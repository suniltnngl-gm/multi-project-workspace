// Objective: Enforce the star-topology agent protocol: runs, leases, idempotent typed messages, cancellation, and checkpoints.
// Requirements: Derive sender identity from a per-agent token; reject every worker-to-worker edge; never wake a model for routing or retries; keep every state change auditable; make duplicate sends a no-op.
// Decisions: The broker is deterministic code and never calls a model; worker messages always resolve to the primary parent; the reviewer is parent-side only; leases and expiry are resolved by the store in one transaction; idempotency compares canonical payloads so a replay cannot silently change the work item.
// Relevant Files: apps/api/src/agentBus.js, apps/api/src/agentProtocol.js, apps/api/src/db/agentRuns.js, apps/api/src/routes/agents.js
// Important Context: User file. This is the zero-token control plane.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  AGENT_AGENT_STATES,
  AGENT_RUN_STATES,
  allowedAgentEdge,
  canonicalJson,
  isTerminalRunState,
  validateEnvelope,
  validateRunInput
} from './agentProtocol.js'
import {
  modelProviderKey,
  planAgentDispatch,
  quotaScopeForModel
} from './providerQuota.js'

const DEFAULT_BUDGET = {
  maxTokens: 20000,
  maxCalls: 20,
  maxMs: 600000
}

const RUN_TRANSITIONS = {
  draft: new Set(['planning', 'cancelled']),
  planning: new Set(['dispatching', 'running', 'failed', 'cancelled']),
  dispatching: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['reviewing', 'completed', 'failed', 'cancelled']),
  reviewing: new Set(['running', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
}

function errorResult(status, message, extra = {}) {
  return { error: { status, body: { error: message, ...extra } } }
}

function readIntegerEnv(env, key, fallback, { min = 0 } = {}) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number greater than or equal to ${min}.`)
  }
  return Math.floor(value)
}

function normalizeBudget(budget, defaults) {
  if (budget === undefined) return { ...defaults }
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null
  const normalized = { ...defaults }
  for (const key of ['maxTokens', 'maxCalls', 'maxMs']) {
    if (budget[key] === undefined) continue
    if (!Number.isFinite(budget[key]) || budget[key] < 0) return null
    normalized[key] = Math.floor(budget[key])
  }
  return normalized
}

const MAX_USAGE_VALUE = 1_000_000_000

function readUsageCount(value, fallback = 0) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_USAGE_VALUE) return null
  return Math.floor(parsed)
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { error: 'Usage must be a JSON object.' }
  }
  const calls = readUsageCount(usage.calls, 1)
  const promptTokens = readUsageCount(
    usage.promptTokens ?? usage.prompt_tokens
  )
  const completionTokens = readUsageCount(
    usage.completionTokens ?? usage.completion_tokens
  )
  const explicitTotal = readUsageCount(usage.totalTokens ?? usage.total_tokens)
  const durationMs = readUsageCount(usage.durationMs ?? usage.duration_ms)
  if (calls === null || promptTokens === null || completionTokens === null ||
      explicitTotal === null || durationMs === null) {
    return { error: 'Usage values must be non-negative numbers within range.' }
  }
  return {
    calls,
    promptTokens,
    completionTokens,
    totalTokens: explicitTotal === 0 && (promptTokens > 0 || completionTokens > 0)
      ? promptTokens + completionTokens
      : explicitTotal,
    durationMs,
    ...(typeof usage.model === 'string' && usage.model.trim()
      ? { model: usage.model.trim() }
      : {})
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function readToken(request) {
  const header = request.get('x-agent-token')
  if (typeof header === 'string' && header.trim()) return header.trim()
  const authorization = request.get('authorization')
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim()
  }
  return ''
}

export function createAgentBus({
  database,
  env = process.env,
  now = Date.now,
  idFactory = (prefix) => `${prefix}_${randomUUID()}`,
  models = [],
  modelBudget
} = {}) {
  if (!database) throw new Error('createAgentBus requires a database.')

  const defaults = {
    maxTokens: readIntegerEnv(env, 'AGENT_RUN_BUDGET_TOKENS', DEFAULT_BUDGET.maxTokens, { min: 1 }),
    maxCalls: readIntegerEnv(env, 'AGENT_RUN_BUDGET_CALLS', DEFAULT_BUDGET.maxCalls, { min: 1 }),
    maxMs: readIntegerEnv(env, 'AGENT_RUN_BUDGET_MS', DEFAULT_BUDGET.maxMs, { min: 1 })
  }
  const messageTtlMs = readIntegerEnv(env, 'AGENT_MESSAGE_TTL_MS', 300000, { min: 1000 })
  const maxAttempts = readIntegerEnv(env, 'AGENT_MESSAGE_MAX_ATTEMPTS', 3, { min: 1 })
  const defaultLeaseMs = readIntegerEnv(env, 'AGENT_LEASE_MS', 30000, { min: 1000 })
  const defaultClaimLimit = readIntegerEnv(env, 'AGENT_CLAIM_LIMIT', 10, { min: 1 })
  const maxClaimLimit = readIntegerEnv(env, 'AGENT_MAX_CLAIM_LIMIT', 20, { min: 1 })
  const maxCheckpointBytes = readIntegerEnv(env, 'AGENT_CHECKPOINT_MAX_BYTES', 65536, { min: 1024 })
  const maxParallelPerProvider = readIntegerEnv(
    env,
    'AGENT_MAX_PARALLEL_PER_PROVIDER',
    1,
    { min: 1 }
  )
  const modelById = new Map(
    (Array.isArray(models) ? models : [])
      .filter((model) => model && typeof model.id === 'string')
      .map((model) => [model.id, model])
  )

  function modelForAgent(agent) {
    if (!agent) return undefined
    return modelById.get(agent.model)
  }

  function providerForAgent(agent) {
    const model = modelForAgent(agent)
    return model ? modelProviderKey(model) : ''
  }

  function runBudgetState(run, usage = database.getAgentRunUsage(run.id)) {
    const budget = run?.budget ?? {}
    const maxTokens = Number.isFinite(budget.maxTokens) ? budget.maxTokens : Infinity
    const maxCalls = Number.isFinite(budget.maxCalls) ? budget.maxCalls : Infinity
    const maxMs = Number.isFinite(budget.maxMs) ? budget.maxMs : Infinity
    const startedAt = run?.startedAt ?? run?.createdAt ?? now()
    const elapsedMs = Math.max(0, now() - startedAt)
    const remaining = {
      tokens: maxTokens - usage.totalTokens,
      calls: maxCalls - usage.calls,
      ms: maxMs - elapsedMs
    }
    return {
      budget: { maxTokens, maxCalls, maxMs },
      usage: {
        calls: usage.calls,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs: usage.durationMs
      },
      elapsedMs,
      remaining,
      exhausted: remaining.tokens <= 0 || remaining.calls <= 0 || remaining.ms <= 0
    }
  }

  function checkRunBudget(runId) {
    const run = database.getAgentRun(runId)
    if (!run) return null
    const state = runBudgetState(run)
    return { ok: !state.exhausted, ...state }
  }

  function appendEvent(runId, agentId, type, data = {}) {
    return database.appendAgentEvent(runId, agentId, type, data, now())
  }

  function getRun(runId, { messageLimit = 100, eventLimit = 200 } = {}) {
    const run = database.getAgentRun(runId)
    if (!run) return null
    return {
      ...run,
      agents: database.listAgents(runId),
      messages: database.listAgentMessages(runId, { limit: messageLimit }),
      events: database.listAgentEvents(runId, { limit: eventLimit }),
      taskOps: database.listAgentTaskOps(runId),
      usage: database.getAgentRunUsage(runId),
      budgetState: runBudgetState(run)
    }
  }

  function authenticate(token) {
    if (typeof token !== 'string' || token.length < 20) return null
    const agent = database.getAgentByTokenHash(hashToken(token))
    if (!agent) return null
    return { ...agent, tokenHash: undefined }
  }

  function authorizeRunAgent(token, runId) {
    const agent = authenticate(token)
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    if (agent.runId !== runId) {
      return errorResult(403, 'The agent token does not belong to this run.')
    }
    const run = database.getAgentRun(runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    return { agent, run }
  }

  function resolveRecipient(run, selector) {
    if (typeof selector !== 'string' || !selector.trim()) return null
    const value = selector.trim()
    if (value === 'parent') {
      return run.primaryAgentId ? database.getAgent(run.primaryAgentId) : null
    }
    if (value === 'reviewer') {
      return run.reviewerAgentId ? database.getAgent(run.reviewerAgentId) : null
    }
    const byId = database.getAgent(value)
    if (byId && byId.runId === run.id) return byId
    return database.getAgentByRunAndName(run.id, value)
  }

  function activeAssignmentsForProvider(runId, provider) {
    if (!provider) return 0
    const agents = new Map(database.listAgents(runId).map((agent) => [agent.id, agent]))
    return database.listActiveAgentAssignments(runId).reduce((count, assignment) => {
      const assigned = agents.get(assignment.toAgentId)
      return providerForAgent(assigned) === provider ? count + 1 : count
    }, 0)
  }

  /**
   * Gate a new assignment before it is stored. This is the quota-saving
   * checkpoint for a multi-agent run: it refuses work when the run budget is
   * spent, when the worker's provider has no headroom, or when that provider
   * already has the configured number of active assignments. A refusal costs
   * no model call and leaves the message queue untouched.
   */
  function dispatchGate(run, recipient) {
    const budgetState = runBudgetState(run)
    if (budgetState.exhausted) {
      return errorResult(
        429,
        'The run budget is exhausted; no further work can be assigned.',
        {
          exhausted: budgetState.exhausted,
          budget: budgetState.budget,
          usage: budgetState.usage,
          remaining: budgetState.remaining
        }
      )
    }

    const model = modelForAgent(recipient)
    if (!model) return null

    if (modelBudget && typeof modelBudget.check === 'function') {
      const quota = modelBudget.check(model.id, quotaScopeForModel(model))
      if (quota && quota.ok === false) {
        return errorResult(
          429,
          `${model.label} has no provider quota headroom for a new assignment.`,
          {
            provider: model.provider,
            ...(quota.retryAfter !== undefined ? { retryAfter: quota.retryAfter } : {}),
            ...(quota.budget ? { budget: quota.budget } : {})
          }
        )
      }
    }

    const provider = modelProviderKey(model)
    const active = activeAssignmentsForProvider(run.id, provider)
    if (active >= maxParallelPerProvider) {
      return errorResult(
        429,
        `Provider ${model.provider} already has ${active} active assignment(s); wait for one to finish before assigning more.`,
        {
          provider: model.provider,
          activeAssignments: active,
          parallelLimit: maxParallelPerProvider
        }
      )
    }
    return null
  }

  function createRun(body = {}) {
    const validationError = validateRunInput(body)
    if (validationError) return errorResult(400, validationError)

    const taskId = body.task_id === undefined ? null : body.task_id
    if (taskId !== null) {
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        return errorResult(400, 'Task ID must be a positive integer.')
      }
      if (!database.getTask(taskId)) return errorResult(404, 'Task not found.')
    }

    const budget = normalizeBudget(body.budget, defaults)
    if (!budget) return errorResult(400, 'Budget values must be non-negative numbers.')

    const runId = idFactory('run')
    const createdAt = now()
    const tokens = new Map()
    const agents = body.agents.map((spec) => {
      const token = `agent_${randomBytes(24).toString('base64url')}`
      tokens.set(spec.name, token)
      return {
        id: idFactory('agt'),
        role: spec.role,
        name: spec.name,
        model: spec.model.trim(),
        backend: typeof spec.backend === 'string' ? spec.backend.trim() : '',
        state: 'idle',
        token,
        tokenHash: hashToken(token),
        promptCacheKey: `${runId}:${spec.name}:${spec.model.trim()}:${(spec.backend ?? '').trim()}`,
        createdAt
      }
    })
    const parent = agents.find((agent) => agent.role === 'parent')
    const reviewer = agents.find((agent) => agent.role === 'reviewer')

    database.createAgentRun({
      id: runId,
      taskId,
      state: 'draft',
      primaryAgentId: parent.id,
      reviewerAgentId: reviewer?.id ?? null,
      modelPlan: body.model_plan ?? {},
      budget,
      plan: body.plan ?? {},
      createdAt,
      updatedAt: createdAt
    })
    for (const agent of agents) {
      database.createAgent({
        id: agent.id,
        runId,
        role: agent.role,
        name: agent.name,
        model: agent.model,
        backend: agent.backend,
        state: agent.state,
        tokenHash: agent.tokenHash,
        promptCacheKey: agent.promptCacheKey,
        createdAt
      })
    }
    appendEvent(runId, parent.id, 'run_created', {
      taskId,
      agents: agents.map((agent) => ({ id: agent.id, role: agent.role, name: agent.name }))
    })

    return {
      ...getRun(runId),
      agents: database.listAgents(runId).map((agent) => ({
        ...agent,
        // The raw token is returned once, at creation. Reads never expose it.
        token: tokens.get(agent.name)
      }))
    }
  }

  function startRun(runId) {
    const run = database.getAgentRun(runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    if (run.state !== 'draft') {
      return errorResult(409, `Only a draft run can be started (currently ${run.state}).`)
    }
    const startedAt = now()
    const updated = database.setAgentRunState(runId, {
      state: 'planning',
      startedAt,
      updatedAt: startedAt
    })
    appendEvent(runId, run.primaryAgentId, 'run_started', { state: 'planning' })
    return updated
  }

  function transitionRun(runId, state, { error, result } = {}) {
    const run = database.getAgentRun(runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    if (!AGENT_RUN_STATES.has(state)) {
      return errorResult(400, `Run state must be one of: ${[...AGENT_RUN_STATES].join(', ')}.`)
    }
    if (!RUN_TRANSITIONS[run.state]?.has(state)) {
      return errorResult(409, `Cannot transition an agent run from ${run.state} to ${state}.`)
    }
    const at = now()
    const terminal = isTerminalRunState(state)
    const updated = database.setAgentRunState(runId, {
      state,
      startedAt: run.startedAt === undefined && state !== 'draft' ? at : undefined,
      finishedAt: terminal ? at : undefined,
      error: error ?? (state === 'failed' ? 'Run failed.' : undefined),
      result,
      updatedAt: at
    })
    if (terminal) {
      for (const agent of database.listAgents(runId)) {
        if (['done', 'failed', 'cancelled'].includes(agent.state)) continue
        database.updateAgent(agent.id, {
          state: state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed',
          finishedAt: at
        })
      }
    }
    appendEvent(runId, run.primaryAgentId, 'run_state', { from: run.state, to: state, error: error ?? null })
    return updated
  }

  function sendMessage({
    token,
    runId,
    to,
    kind,
    payload,
    artifactRefs = [],
    idempotencyKey,
    correlationId = '',
    deadlineAt,
    ttlMs = messageTtlMs
  } = {}) {
    const authorized = authorizeRunAgent(token, runId)
    if (authorized.error) return authorized
    const { agent, run } = authorized
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }

    const recipient = resolveRecipient(run, to)
    if (!recipient) return errorResult(404, 'Recipient agent was not found in this run.')
    if (recipient.id === agent.id) return errorResult(400, 'An agent cannot message itself.')
    if (!allowedAgentEdge(kind, agent.role, recipient.role)) {
      return errorResult(403, `Edge ${agent.role} -> ${recipient.role} is not allowed for ${kind}.`)
    }

    const envelope = validateEnvelope({
      kind,
      payload,
      artifactRefs,
      idempotencyKey,
      correlationId,
      deadlineAt
    })
    if (envelope.error) return errorResult(400, envelope.error)

    const existing = database.findAgentMessageByIdempotency(runId, envelope.idempotencyKey)
    if (existing) {
      const same = existing.fromAgentId === agent.id
        && existing.toAgentId === recipient.id
        && existing.kind === kind
        && canonicalJson(existing.payload) === canonicalJson(envelope.payload)
        && canonicalJson(existing.artifactRefs) === canonicalJson(envelope.artifactRefs)
      if (!same) {
        return errorResult(409, 'Idempotency key was already used for a different message.')
      }
      return { message: existing, duplicate: true }
    }

    // Assignment is the only message kind that asks a worker to spend model
    // quota, so it is gated before the queue record is written.
    if (kind === 'assign') {
      const denied = dispatchGate(run, recipient)
      if (denied) return denied
    }

    const createdAt = now()
    const expiresAt = envelope.deadlineAt === null
      ? createdAt + ttlMs
      : envelope.deadlineAt
    if (expiresAt <= createdAt) return errorResult(400, 'Message deadline has already passed.')

    const message = database.createAgentMessage({
      id: idFactory('msg'),
      runId,
      fromAgentId: agent.id,
      toAgentId: recipient.id,
      kind,
      correlationId: envelope.correlationId,
      seq: database.nextAgentMessageSeq(runId),
      payload: envelope.payload,
      artifactRefs: envelope.artifactRefs,
      idempotencyKey: envelope.idempotencyKey,
      maxAttempts,
      createdAt,
      expiresAt
    })
    appendEvent(runId, agent.id, 'message_sent', {
      messageId: message.id,
      kind,
      to: recipient.id,
      correlationId: envelope.correlationId
    })
    return { message, duplicate: false }
  }

  function claimInbox({ token, runId, limit, leaseMs } = {}) {
    const authorized = authorizeRunAgent(token, runId)
    if (authorized.error) return authorized
    const { agent, run } = authorized
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }

    const requestedLimit = limit === undefined ? defaultClaimLimit : Number(limit)
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > maxClaimLimit) {
      return errorResult(400, `Inbox limit must be between 1 and ${maxClaimLimit}.`)
    }
    const requestedLease = leaseMs === undefined ? defaultLeaseMs : Number(leaseMs)
    if (!Number.isSafeInteger(requestedLease) || requestedLease < 1000 || requestedLease > 300000) {
      return errorResult(400, 'Lease must be between 1000 and 300000 milliseconds.')
    }

    const at = now()
    const claimed = database.claimAgentMessages(runId, agent.id, {
      limit: requestedLimit,
      nowMs: at,
      leaseMs: requestedLease
    })
    database.updateAgent(agent.id, { state: 'running', heartbeatAt: at, leaseUntil: at + requestedLease })
    if (claimed.expired > 0) appendEvent(runId, agent.id, 'messages_expired', { count: claimed.expired })
    if (claimed.requeued > 0) appendEvent(runId, agent.id, 'messages_requeued', { count: claimed.requeued })
    for (const message of claimed.messages) {
      appendEvent(runId, agent.id, 'message_delivered', {
        messageId: message.id,
        kind: message.kind,
        from: message.fromAgentId
      })
    }
    return claimed
  }

  function ackMessage({ token, messageId } = {}) {
    const agent = authenticate(token)
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    const message = database.getAgentMessage(messageId)
    if (!message) return errorResult(404, 'Agent message not found.')
    if (message.toAgentId !== agent.id) return errorResult(403, 'Only the recipient can acknowledge this message.')
    if (!['delivered', 'leased'].includes(message.state)) {
      return errorResult(409, `Cannot acknowledge a ${message.state} message.`)
    }
    const updated = database.ackAgentMessage(message.id, now())
    appendEvent(message.runId, agent.id, 'message_acked', { messageId: message.id })
    return { message: updated }
  }

  function completeMessage({ token, messageId, result } = {}) {
    const agent = authenticate(token)
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    const message = database.getAgentMessage(messageId)
    if (!message) return errorResult(404, 'Agent message not found.')
    if (message.toAgentId !== agent.id) return errorResult(403, 'Only the recipient can complete this message.')
    if (!['delivered', 'leased', 'acked'].includes(message.state)) {
      return errorResult(409, `Cannot complete a ${message.state} message.`)
    }
    if (result !== undefined && (result === null || typeof result !== 'object' || Array.isArray(result))) {
      return errorResult(400, 'Completion result must be a JSON object.')
    }
    const updated = database.completeAgentMessage(message.id, result)
    appendEvent(message.runId, agent.id, 'message_completed', { messageId: message.id })
    return { message: updated }
  }

  function failMessage({ token, messageId, error, retryable = true } = {}) {
    const agent = authenticate(token)
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    const message = database.getAgentMessage(messageId)
    if (!message) return errorResult(404, 'Agent message not found.')
    if (message.toAgentId !== agent.id) return errorResult(403, 'Only the recipient can fail this message.')
    if (!['delivered', 'leased', 'acked'].includes(message.state)) {
      return errorResult(409, `Cannot fail a ${message.state} message.`)
    }
    if (typeof error !== 'string' || !error.trim()) {
      return errorResult(400, 'A failure reason is required.')
    }

    const attempts = message.attempts + 1
    let state = 'failed'
    if (retryable === true) state = attempts < message.maxAttempts ? 'queued' : 'dead_letter'
    const updated = database.failAgentMessage(message.id, {
      state,
      error: error.trim().slice(0, 2000),
      attempts
    })
    appendEvent(message.runId, agent.id, 'message_failed', {
      messageId: message.id,
      retryable: retryable === true,
      attempts,
      state
    })
    return { message: updated }
  }

  function cancelRun(runId, reason = 'Run cancelled.') {
    const run = database.getAgentRun(runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    if (run.state === 'cancelled') return getRun(runId)
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `A ${run.state} run cannot be cancelled.`)
    }
    const at = now()
    const updated = database.setAgentRunState(runId, {
      state: 'cancelled',
      finishedAt: at,
      error: String(reason).slice(0, 2000),
      updatedAt: at
    })
    for (const agent of database.listAgents(runId)) {
      if (['done', 'failed', 'cancelled'].includes(agent.state)) continue
      database.updateAgent(agent.id, { state: 'cancelled', finishedAt: at })
    }
    const expired = database.expireAgentRunMessages(runId)
    appendEvent(runId, run.primaryAgentId, 'run_cancelled', { reason, expiredMessages: expired })
    return updated
  }

  function checkpointRun({ token, runId, checkpoint } = {}) {
    const authorized = authorizeRunAgent(token, runId)
    if (authorized.error) return authorized
    const { run } = authorized
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      return errorResult(400, 'Checkpoint must be a JSON object.')
    }
    if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > maxCheckpointBytes) {
      return errorResult(400, `Checkpoint must be at most ${maxCheckpointBytes} bytes.`)
    }
    const at = now()
    const updated = database.setAgentRunCheckpoint(runId, checkpoint, at)
    appendEvent(runId, authorized.agent.id, 'checkpoint', {
      keys: Object.keys(checkpoint).slice(0, 20)
    })
    return updated
  }

  function heartbeat({ token, state, leaseMs } = {}) {
    const agent = authenticate(token)
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    const run = database.getAgentRun(agent.runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }
    if (state !== undefined && !AGENT_AGENT_STATES.has(state)) {
      return errorResult(400, `Agent state must be one of: ${[...AGENT_AGENT_STATES].join(', ')}.`)
    }
    const at = now()
    const requestedLease = leaseMs === undefined ? defaultLeaseMs : Number(leaseMs)
    if (!Number.isSafeInteger(requestedLease) || requestedLease < 1000 || requestedLease > 300000) {
      return errorResult(400, 'Lease must be between 1000 and 300000 milliseconds.')
    }
    const updated = database.updateAgent(agent.id, {
      state: state === undefined ? 'running' : state,
      heartbeatAt: at,
      leaseUntil: at + requestedLease
    })
    return { agent: updated }
  }

  // Workers report the model usage of a real call so later assignments are
  // gated by what was already spent. Recording is always accepted, even when
  // it pushes the run over budget: the spend is real, and the next assignment
  // is the thing that must stop.
  function recordUsage({ token, runId, usage } = {}) {
    const authorized = authorizeRunAgent(token, runId)
    if (authorized.error) return authorized
    const { agent, run } = authorized
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }
    const normalized = normalizeUsage(usage)
    if (normalized.error) return errorResult(400, normalized.error)

    const modelId = normalized.model ?? agent.model
    const model = modelById.get(modelId)
    const totalTokens = normalized.totalTokens > 0
      ? normalized.totalTokens
      : normalized.promptTokens + normalized.completionTokens
    const totals = database.addAgentRunUsage({
      runId,
      agentId: agent.id,
      model: modelId,
      provider: model?.provider ?? '',
      calls: normalized.calls,
      promptTokens: normalized.promptTokens,
      completionTokens: normalized.completionTokens,
      totalTokens,
      durationMs: normalized.durationMs,
      createdAt: now()
    })
    appendEvent(runId, agent.id, 'usage_recorded', {
      model: modelId,
      calls: normalized.calls,
      totalTokens,
      durationMs: normalized.durationMs
    })
    const state = runBudgetState(run, totals)
    return {
      usage: {
        calls: totals.calls,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        durationMs: totals.durationMs,
        byModel: totals.byModel
      },
      budget: state.budget,
      remaining: state.remaining,
      elapsedMs: state.elapsedMs,
      exhausted: state.exhausted
    }
  }

  function dispatchPlan(runId) {
    const run = database.getAgentRun(runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    const agents = database.listAgents(runId)
    const plan = planAgentDispatch({
      models,
      modelBudget,
      agents,
      parallelLimit: maxParallelPerProvider,
      activeAssignments: database.listActiveAgentAssignments(runId)
    })
    const budgetState = runBudgetState(run)
    return {
      ...plan,
      ok: plan.ok && !budgetState.exhausted,
      budget: budgetState.budget,
      remaining: budgetState.remaining,
      usage: budgetState.usage,
      exhausted: budgetState.exhausted
    }
  }

  return {
    createRun,
    getRun,
    listRuns(options) {
      return database.listAgentRuns(options)
    },
    startRun,
    transitionRun,
    cancelRun,
    checkpointRun,
    authenticate,
    sendMessage,
    claimInbox,
    ackMessage,
    completeMessage,
    failMessage,
    heartbeat,
    recordUsage,
    checkRunBudget,
    dispatchPlan,
    errorResult,
    readToken
  }
}

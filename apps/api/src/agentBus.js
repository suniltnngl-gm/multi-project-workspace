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

function errorResult(status, message) {
  return { error: { status, body: { error: message } } }
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
  idFactory = (prefix) => `${prefix}_${randomUUID()}`
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
      taskOps: database.listAgentTaskOps(runId)
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
    errorResult,
    readToken
  }
}

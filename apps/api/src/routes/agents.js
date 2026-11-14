// Objective: Expose the deterministic agent control plane over the local API: runs, typed messages, inbox leases, cancellation, checkpoints, task ops, scripts, artifacts, and swarm orchestration.
// Requirements: Authenticate agent writes with per-run tokens; return the raw token only when the run is created; keep reads token-free for the local board; never let a worker call another worker; never execute a registered script command from the API; expose swarm plan/run/step/board endpoints supporting parent_mode, max_review_rounds, sync_task, and complete_task.
// Decisions: The route group delegates every protocol rule to the broker, task writes to the task-op store, and swarm orchestration to swarmRunner; script matching and artifact bytes stay in their own stores; missing or invalid tokens are 401 rather than silently falling back to an agent id.
// Relevant Files: apps/api/src/routes/agents.js, apps/api/src/agentBus.js, apps/api/src/swarmRunner.js, apps/api/src/agentScripts.js, apps/api/src/db/agentTaskOps.js, apps/api/src/db/agentScripts.js, apps/api/src/app.js
// Important Context: User file. Local-only surface; the API is bound to loopback by default.
// Work State: Completed: Deterministic agent control-plane routes plus /api/agents/swarm/* endpoints; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { validateScriptInput } from '../agentScripts.js'

const MAX_ARTIFACT_BYTES = 12 * 1024

function sendError(response, result) {
  // A broker error result is { error: { status, body } }, while a run carries
  // error as a plain message string. Only the object shape is an HTTP error.
  if (Number.isInteger(result?.error?.status)) {
    return response.status(result.error.status).json(result.error.body)
  }
  return null
}

function isOpaqueId(value, prefix) {
  return typeof value === 'string'
    && value.length > prefix.length + 1
    && value.length <= 120
    && value.startsWith(`${prefix}_`)
}

function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value)) return null
  const limit = Number(value)
  return limit <= max ? limit : null
}

function normalizeSwarmBody(body = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  return {
    ...input,
    ...(input.task_id !== undefined && input.taskId === undefined ? { taskId: input.task_id } : {}),
    ...(input.worker_count !== undefined && input.workerCount === undefined
      ? { workerCount: input.worker_count }
      : {}),
    ...(input.include_reviewer !== undefined && input.includeReviewer === undefined
      ? { includeReviewer: input.include_reviewer }
      : {}),
    ...(input.opencode_models !== undefined && input.opencodeModels === undefined
      ? { opencodeModels: input.opencode_models }
      : {}),
    ...(input.worktree_path !== undefined && input.worktreePath === undefined
      ? { worktreePath: input.worktree_path }
      : {}),
    ...(input.max_steps !== undefined && input.maxSteps === undefined
      ? { maxSteps: input.max_steps }
      : {}),
    ...(input.parent_mode !== undefined && input.parentMode === undefined
      ? { parentMode: input.parent_mode }
      : {}),
    ...(input.max_review_rounds !== undefined && input.maxReviewRounds === undefined
      ? { maxReviewRounds: input.max_review_rounds }
      : {}),
    ...(input.sync_task !== undefined && input.syncTask === undefined
      ? { syncTask: input.sync_task }
      : {}),
    ...(input.complete_task !== undefined && input.completeTask === undefined
      ? { completeTask: input.complete_task }
      : {}),
    ...(input.self_improve !== undefined && input.selfImprove === undefined
      ? { selfImprove: Boolean(input.self_improve) }
      : {}),
    ...(input.auto_propose_self_improvement !== undefined && input.autoProposeSelfImprovement === undefined
      ? { autoProposeSelfImprovement: Boolean(input.auto_propose_self_improvement) }
      : {})
  }
}

export function createAgentsRouter({ database, bus, swarmRunner } = {}) {
  const router = Router()

  router.post('/api/agents/runs', (request, response) => {
    const result = bus.createRun(request.body)
    if (sendError(response, result)) return
    return response.status(201).json(result)
  })

  router.get('/api/agents/runs', (request, response) => {
    const options = {}
    if (request.query.state !== undefined) {
      if (typeof request.query.state !== 'string') {
        return response.status(400).json({ error: 'State filter must be a single string.' })
      }
      options.state = request.query.state
    }
    if (request.query.task_id !== undefined) {
      if (!/^[1-9]\d*$/.test(request.query.task_id)) {
        return response.status(400).json({ error: 'Task ID filter must be a positive integer.' })
      }
      options.taskId = Number(request.query.task_id)
    }
    const limit = parseLimit(request.query.limit, 50, 200)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 200.' })
    }
    options.limit = limit
    return response.json(database.listAgentRuns(options))
  })

  router.get('/api/agents/runs/:id', (request, response) => {
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    const messageLimit = parseLimit(request.query.message_limit, 100, 500)
    const eventLimit = parseLimit(request.query.event_limit, 200, 1000)
    if (messageLimit === null || eventLimit === null) {
      return response.status(400).json({ error: 'Message and event limits must be positive integers within range.' })
    }
    const run = bus.getRun(runId, { messageLimit, eventLimit })
    if (!run) return response.status(404).json({ error: 'Agent run not found.' })
    return response.json(run)
  })

  router.post('/api/agents/runs/:id/start', (request, response) => {
    const result = bus.startRun(request.params.id)
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.get('/api/agents/runs/:id/usage', (request, response) => {
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    if (!database.getAgentRun(runId)) {
      return response.status(404).json({ error: 'Agent run not found.' })
    }
    return response.json({
      usage: database.getAgentRunUsage(runId),
      budgetState: bus.checkRunBudget(runId)
    })
  })

  router.post('/api/agents/runs/:id/usage', (request, response) => {
    const usage = request.body?.usage ?? request.body
    const result = bus.recordUsage({
      token: bus.readToken(request),
      runId: request.params.id,
      usage
    })
    if (sendError(response, result)) return
    return response.status(201).json(result)
  })

  router.get('/api/agents/runs/:id/dispatch-plan', (request, response) => {
    const result = bus.dispatchPlan(request.params.id)
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/runs/:id/transition', (request, response) => {
    const agent = bus.authenticate(bus.readToken(request))
    if (!agent) return response.status(401).json({ error: 'A valid agent token is required.' })
    if (agent.runId !== request.params.id) {
      return response.status(403).json({ error: 'The agent token does not belong to this run.' })
    }
    const { state, error, result } = request.body ?? {}
    if (typeof state !== 'string' || !state) {
      return response.status(400).json({ error: 'A target state is required.' })
    }
    const updated = bus.transitionRun(request.params.id, state, { error, result })
    if (sendError(response, updated)) return
    return response.json(updated)
  })

  router.post('/api/agents/runs/:id/cancel', (request, response) => {
    const reason = request.body?.reason
    if (reason !== undefined && typeof reason !== 'string') {
      return response.status(400).json({ error: 'Cancellation reason must be a string.' })
    }
    const result = bus.cancelRun(request.params.id, reason ?? 'Run cancelled.')
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/runs/:id/checkpoint', (request, response) => {
    const result = bus.checkpointRun({
      token: bus.readToken(request),
      runId: request.params.id,
      checkpoint: request.body?.checkpoint
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.get('/api/agents/runs/:id/messages', (request, response) => {
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    if (!database.getAgentRun(runId)) {
      return response.status(404).json({ error: 'Agent run not found.' })
    }
    const limit = parseLimit(request.query.limit, 100, 500)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 500.' })
    }
    let afterSeq = 0
    if (request.query.after_seq !== undefined) {
      if (!/^\d+$/.test(request.query.after_seq)) {
        return response.status(400).json({ error: 'after_seq must be a non-negative integer.' })
      }
      afterSeq = Number(request.query.after_seq)
    }
    return response.json(database.listAgentMessages(runId, { limit, afterSeq }))
  })

  router.get('/api/agents/runs/:id/events', (request, response) => {
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    if (!database.getAgentRun(runId)) {
      return response.status(404).json({ error: 'Agent run not found.' })
    }
    const limit = parseLimit(request.query.limit, 200, 1000)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 1000.' })
    }
    return response.json(database.listAgentEvents(runId, { limit }))
  })

  router.get('/api/agents/runs/:id/task-ops', (request, response) => {
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    if (!database.getAgentRun(runId)) {
      return response.status(404).json({ error: 'Agent run not found.' })
    }
    return response.json(database.listAgentTaskOps(runId))
  })

  router.post('/api/agents/messages', (request, response) => {
    const body = request.body ?? {}
    const result = bus.sendMessage({
      token: bus.readToken(request),
      runId: body.run_id,
      to: body.to,
      kind: body.kind,
      payload: body.payload,
      artifactRefs: body.artifact_refs,
      idempotencyKey: body.idempotency_key,
      correlationId: body.correlation_id,
      deadlineAt: body.deadline_at,
      ttlMs: body.ttl_ms
    })
    if (sendError(response, result)) return
    return response.status(result.duplicate ? 200 : 201).json(result)
  })

  router.post('/api/agents/inbox/claim', (request, response) => {
    const body = request.body ?? {}
    const result = bus.claimInbox({
      token: bus.readToken(request),
      runId: body.run_id,
      limit: body.limit,
      leaseMs: body.lease_ms
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/messages/:id/ack', (request, response) => {
    const result = bus.ackMessage({
      token: bus.readToken(request),
      messageId: request.params.id
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/messages/:id/complete', (request, response) => {
    const result = bus.completeMessage({
      token: bus.readToken(request),
      messageId: request.params.id,
      result: request.body?.result
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/messages/:id/fail', (request, response) => {
    const result = bus.failMessage({
      token: bus.readToken(request),
      messageId: request.params.id,
      error: request.body?.error,
      retryable: request.body?.retryable
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/runs/:id/task-ops', (request, response) => {
    const agent = bus.authenticate(bus.readToken(request))
    if (!agent) return response.status(401).json({ error: 'A valid agent token is required.' })
    if (agent.runId !== request.params.id) {
      return response.status(403).json({ error: 'The agent token does not belong to this run.' })
    }
    const result = database.applyTaskOps({ agent, ops: request.body?.ops })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/heartbeat', (request, response) => {
    const result = bus.heartbeat({
      token: bus.readToken(request),
      state: request.body?.state,
      leaseMs: request.body?.lease_ms
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  // Script-first surface: callers resolve a repetitive intent before asking a
  // model. The resolver never runs the stored command.
  router.get('/api/agents/scripts', (request, response) => {
    const limit = parseLimit(request.query.limit, 50, 200)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 200.' })
    }
    const intent = typeof request.query.intent === 'string' ? request.query.intent : undefined
    return response.json(database.listAgentScripts({
      intent,
      limit,
      verifiedOnly: request.query.verified === 'true'
    }))
  })

  router.post('/api/agents/scripts', (request, response) => {
    const fields = validateScriptInput(request.body)
    if (fields.error) return response.status(400).json({ error: fields.error })
    const existing = database.getAgentScriptByName(fields.name)
    const script = database.registerAgentScript(fields)
    return response.status(existing ? 200 : 201).json(script)
  })

  router.post('/api/agents/scripts/resolve', (request, response) => {
    const result = database.resolveAgentScript({
      intent: request.body?.intent,
      input: request.body?.input
    })
    if (sendError(response, result)) return
    return response.json(result)
  })

  router.post('/api/agents/scripts/:id/verify', (request, response) => {
    if (!isOpaqueId(request.params.id, 'scr')) {
      return response.status(400).json({ error: 'Script ID is invalid.' })
    }
    if (!database.getAgentScript(request.params.id)) {
      return response.status(404).json({ error: 'Agent script not found.' })
    }
    return response.json(database.markAgentScriptVerified(request.params.id))
  })

  router.get('/api/agents/artifacts/:hash', (request, response) => {
    if (!/^[a-f0-9]{64}$/.test(request.params.hash)) {
      return response.status(400).json({ error: 'Artifact hash is invalid.' })
    }
    const artifact = database.getAgentArtifact(request.params.hash, {
      includeContent: request.query.content === 'true'
    })
    if (!artifact) return response.status(404).json({ error: 'Agent artifact not found.' })
    return response.json(artifact)
  })

  router.post('/api/agents/artifacts', (request, response) => {
    const body = request.body ?? {}
    if (typeof body.kind !== 'string' || !body.kind.trim() || body.kind.length > 50) {
      return response.status(400).json({ error: 'Artifact kind must be a non-empty string of at most 50 characters.' })
    }
    if (typeof body.content !== 'string' || !body.content) {
      return response.status(400).json({ error: 'Artifact content must be a non-empty string.' })
    }
    if (Buffer.byteLength(body.content, 'utf8') > MAX_ARTIFACT_BYTES) {
      return response.status(413).json({ error: `Artifact content must be at most ${MAX_ARTIFACT_BYTES} bytes.` })
    }
    if (body.path !== undefined && typeof body.path !== 'string') {
      return response.status(400).json({ error: 'Artifact path must be a string.' })
    }
    if (body.producer !== undefined && typeof body.producer !== 'string') {
      return response.status(400).json({ error: 'Artifact producer must be a string.' })
    }
    let expiresAt = null
    if (body.expires_at !== undefined && body.expires_at !== null) {
      expiresAt = typeof body.expires_at === 'number' ? body.expires_at : Date.parse(body.expires_at)
      if (!Number.isFinite(expiresAt)) {
        return response.status(400).json({ error: 'Artifact expiry must be an ISO timestamp or epoch milliseconds.' })
      }
    }
    return response.status(201).json(database.saveAgentArtifact({
      kind: body.kind.trim(),
      path: body.path ?? '',
      producer: body.producer ?? '',
      content: body.content,
      expiresAt
    }))
  })

  router.post('/api/agents/swarm/plan', (request, response) => {
    if (!swarmRunner) {
      return response.status(501).json({ error: 'Swarm runner is not configured.' })
    }
    const plan = swarmRunner.planSwarm(normalizeSwarmBody(request.body ?? {}))
    if (sendError(response, plan)) return
    return response.json(plan)
  })

  router.post('/api/agents/swarm', async (request, response, next) => {
    try {
      if (!swarmRunner) {
        return response.status(501).json({ error: 'Swarm runner is not configured.' })
      }
      const options = normalizeSwarmBody(request.body ?? {})
      const created = swarmRunner.createSwarm(options)
      if (sendError(response, created)) return
      if (options.execute === true) {
        const executed = await swarmRunner.executeSwarm(created.runId, {
          maxSteps: options.maxSteps
        })
        if (sendError(response, executed)) return
        return response.status(201).json(executed)
      }
      return response.status(201).json(created)
    } catch (error) {
      next(error)
    }
  })

  router.get('/api/agents/runs/:id/board', (request, response) => {
    if (!swarmRunner) {
      return response.status(501).json({ error: 'Swarm runner is not configured.' })
    }
    const runId = request.params.id
    if (!isOpaqueId(runId, 'run')) {
      return response.status(400).json({ error: 'Run ID is invalid.' })
    }
    const board = swarmRunner.formatBoard(runId)
    if (!board) return response.status(404).json({ error: 'Agent run not found.' })
    return response.json(board)
  })

  router.post('/api/agents/runs/:id/step', async (request, response, next) => {
    try {
      if (!swarmRunner) {
        return response.status(501).json({ error: 'Swarm runner is not configured.' })
      }
      const runId = request.params.id
      if (!isOpaqueId(runId, 'run')) {
        return response.status(400).json({ error: 'Run ID is invalid.' })
      }
      const result = await swarmRunner.stepSwarm(runId)
      if (sendError(response, result)) return
      return response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/api/agents/runs/:id/execute', async (request, response, next) => {
    try {
      if (!swarmRunner) {
        return response.status(501).json({ error: 'Swarm runner is not configured.' })
      }
      const runId = request.params.id
      if (!isOpaqueId(runId, 'run')) {
        return response.status(400).json({ error: 'Run ID is invalid.' })
      }
      const options = normalizeSwarmBody(request.body ?? {})
      const result = await swarmRunner.executeSwarm(runId, { maxSteps: options.maxSteps })
      if (sendError(response, result)) return
      return response.json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}

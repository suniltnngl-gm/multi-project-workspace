// Objective: Own the persistence layer for agent runs, agents, messages, events, and model evaluation cards.
// Requirements: Keep rows independent of any prompt text; map snake_case columns to the camelCase API surface; make message claims atomic; expose token hashes only to the broker lookup.
// Decisions: One store covers runs, agents, and messages because they share a lifecycle and every read is scoped by run id; leases and expiry are resolved in one transaction so two workers cannot claim the same message; token revocation is implicit because tokens are hashed and never returned by read methods.
// Relevant Files: apps/api/src/db/agentRuns.js, apps/api/src/db/migrations.js, apps/api/src/database.js, apps/api/src/agentBus.js
// Important Context: User file. Composed into the createDatabase surface.
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toAgent(row, { includeTokenHash = false } = {}) {
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    name: row.name,
    model: row.model,
    backend: row.backend,
    state: row.state,
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    promptCacheKey: row.prompt_cache_key,
    createdAt: row.created_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(includeTokenHash ? { tokenHash: row.token_hash } : {})
  }
}

function toRun(row) {
  if (!row) return null
  return {
    id: row.id,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    state: row.state,
    ...(row.primary_agent_id !== null ? { primaryAgentId: row.primary_agent_id } : {}),
    ...(row.reviewer_agent_id !== null ? { reviewerAgentId: row.reviewer_agent_id } : {}),
    modelPlan: parseJson(row.model_plan, {}),
    budget: parseJson(row.budget, {}),
    plan: parseJson(row.plan, {}),
    checkpoint: parseJson(row.checkpoint, {}),
    ...(row.result !== null ? { result: parseJson(row.result, row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {})
  }
}

function toMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    kind: row.kind,
    correlationId: row.correlation_id,
    seq: row.seq,
    state: row.state,
    payload: parseJson(row.payload, {}),
    artifactRefs: parseJson(row.artifact_refs, []),
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.result !== null ? { result: parseJson(row.result, row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    createdAt: row.created_at,
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    ...(row.acked_at !== null ? { ackedAt: row.acked_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
  }
}

function toEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    type: row.type,
    data: parseJson(row.data, {}),
    createdAt: row.created_at
  }
}

export function createAgentRunsStore(connection) {
  const insertRunStatement = connection.prepare(`
    INSERT INTO agent_runs (
      id, task_id, state, primary_agent_id, reviewer_agent_id, model_plan,
      budget, plan, checkpoint, created_at, updated_at
    ) VALUES (
      @id, @taskId, @state, @primaryAgentId, @reviewerAgentId, @modelPlan,
      @budget, @plan, @checkpoint, @createdAt, @updatedAt
    )
  `)
  const getRunStatement = connection.prepare('SELECT * FROM agent_runs WHERE id = ?')
  const listRunsStatement = connection.prepare(
    'SELECT * FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?'
  )

  const insertAgentStatement = connection.prepare(`
    INSERT INTO agent_agents (
      id, run_id, role, name, model, backend, state, token_hash,
      prompt_cache_key, created_at
    ) VALUES (
      @id, @runId, @role, @name, @model, @backend, @state, @tokenHash,
      @promptCacheKey, @createdAt
    )
  `)
  const getAgentStatement = connection.prepare('SELECT * FROM agent_agents WHERE id = ?')
  const getAgentByRunNameStatement = connection.prepare(
    'SELECT * FROM agent_agents WHERE run_id = ? AND name = ?'
  )
  const getAgentByTokenHashStatement = connection.prepare(
    'SELECT * FROM agent_agents WHERE token_hash = ?'
  )
  const listAgentsStatement = connection.prepare(
    'SELECT * FROM agent_agents WHERE run_id = ? ORDER BY CASE role WHEN \'parent\' THEN 0 WHEN \'reviewer\' THEN 1 ELSE 2 END, name'
  )

  const insertMessageStatement = connection.prepare(`
    INSERT INTO agent_messages (
      id, run_id, from_agent_id, to_agent_id, kind, correlation_id, seq, state,
      payload, artifact_refs, idempotency_key, max_attempts, created_at, expires_at
    ) VALUES (
      @id, @runId, @fromAgentId, @toAgentId, @kind, @correlationId, @seq, 'queued',
      @payload, @artifactRefs, @idempotencyKey, @maxAttempts, @createdAt, @expiresAt
    )
  `)
  const getMessageStatement = connection.prepare('SELECT * FROM agent_messages WHERE id = ?')
  const getMessageByIdempotencyStatement = connection.prepare(
    'SELECT * FROM agent_messages WHERE run_id = ? AND idempotency_key = ?'
  )
  const nextSeqStatement = connection.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_messages WHERE run_id = ?'
  )
  const listMessagesStatement = connection.prepare(`
    SELECT * FROM (
      SELECT * FROM agent_messages
      WHERE run_id = ? AND seq > ?
      ORDER BY seq DESC
      LIMIT ?
    ) ORDER BY seq ASC
  `)
  const ackMessageStatement = connection.prepare(
    "UPDATE agent_messages SET state = 'acked', acked_at = ?, lease_owner = NULL, lease_until = NULL WHERE id = ?"
  )
  const completeMessageStatement = connection.prepare(
    "UPDATE agent_messages SET state = 'completed', result = ?, error = NULL, lease_owner = NULL, lease_until = NULL WHERE id = ?"
  )
  const failMessageStatement = connection.prepare(
    `UPDATE agent_messages
     SET state = ?, error = ?, attempts = ?, lease_owner = NULL, lease_until = NULL
     WHERE id = ?`
  )
  const expireRunMessagesStatement = connection.prepare(
    `UPDATE agent_messages
     SET state = 'expired', error = COALESCE(error, 'Run cancelled.'), lease_owner = NULL, lease_until = NULL
     WHERE run_id = ? AND state IN ('queued', 'leased', 'delivered')`
  )

  const insertEventStatement = connection.prepare(`
    INSERT INTO agent_events (run_id, agent_id, type, data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const listEventsStatement = connection.prepare(`
    SELECT * FROM (
      SELECT * FROM agent_events
      WHERE run_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    ) ORDER BY created_at ASC, id ASC
  `)

  // Claiming is the hot path for every worker poll, so these statements are
  // prepared once instead of on each call.
  const expireMessagesStatement = connection.prepare(
    `UPDATE agent_messages
     SET state = 'expired', error = COALESCE(error, 'Message expired.'), lease_owner = NULL, lease_until = NULL
     WHERE run_id = ? AND state IN ('queued', 'leased', 'delivered')
       AND expires_at IS NOT NULL AND expires_at <= ?`
  )
  const requeueExpiredLeasesStatement = connection.prepare(
    `UPDATE agent_messages
     SET state = 'queued', lease_owner = NULL, lease_until = NULL
     WHERE run_id = ? AND state IN ('leased', 'delivered')
       AND lease_until IS NOT NULL AND lease_until <= ?`
  )
  const claimableMessagesStatement = connection.prepare(
    `SELECT * FROM agent_messages
     WHERE run_id = ? AND to_agent_id = ? AND state = 'queued'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY seq ASC
     LIMIT ?`
  )
  const deliverMessageStatement = connection.prepare(
    `UPDATE agent_messages
     SET state = 'delivered', delivered_at = COALESCE(delivered_at, ?),
         lease_owner = ?, lease_until = ?
     WHERE id = ? AND state = 'queued'`
  )

  const claimMessages = connection.transaction((runId, agentId, limit, nowMs, leaseMs) => {
    // Expired TTLs win over leases; a message whose deadline passed is not
    // delivered even if a worker was mid-lease.
    const expired = expireMessagesStatement.run(runId, nowMs).changes

    // An expired lease returns the message to the queue. Attempts are counted
    // on failure, so a crashed worker does not silently consume the retry.
    const requeued = requeueExpiredLeasesStatement.run(runId, nowMs).changes

    const rows = claimableMessagesStatement.all(runId, agentId, nowMs, limit)

    const leaseUntil = nowMs + leaseMs
    for (const row of rows) deliverMessageStatement.run(nowMs, agentId, leaseUntil, row.id)
    // Re-read so callers see the delivered state, not the queued snapshot.
    return {
      messages: rows.map((row) => toMessage(getMessageStatement.get(row.id))),
      expired,
      requeued
    }
  })

  return {
    createAgentRun({ id, taskId = null, state = 'draft', primaryAgentId = null, reviewerAgentId = null, modelPlan = {}, budget = {}, plan = {}, checkpoint = {}, createdAt, updatedAt }) {
      insertRunStatement.run({
        id,
        taskId,
        state,
        primaryAgentId,
        reviewerAgentId,
        modelPlan: JSON.stringify(modelPlan),
        budget: JSON.stringify(budget),
        plan: JSON.stringify(plan),
        checkpoint: JSON.stringify(checkpoint),
        createdAt,
        updatedAt
      })
      return toRun(getRunStatement.get(id))
    },
    getAgentRun(id) {
      return toRun(getRunStatement.get(id))
    },
    listAgentRuns({ taskId, state, limit = 50 } = {}) {
      const conditions = []
      const values = []
      if (taskId !== undefined) {
        conditions.push('task_id = ?')
        values.push(taskId)
      }
      if (state !== undefined) {
        conditions.push('state = ?')
        values.push(state)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = connection.prepare(
        `SELECT * FROM agent_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(...values, limit)
      return rows.map(toRun)
    },
    setAgentRunState(id, { state, startedAt, finishedAt, error, result, updatedAt }) {
      const sets = ['state = @state', 'updated_at = @updatedAt']
      const params = { id, state, updatedAt }
      if (startedAt !== undefined) {
        sets.push('started_at = @startedAt')
        params.startedAt = startedAt
      }
      if (finishedAt !== undefined) {
        sets.push('finished_at = @finishedAt')
        params.finishedAt = finishedAt
      }
      if (error !== undefined) {
        sets.push('error = @error')
        params.error = error
      }
      if (result !== undefined) {
        sets.push('result = @result')
        params.result = result === null ? null : JSON.stringify(result)
      }
      connection.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = @id`).run(params)
      return toRun(getRunStatement.get(id))
    },
    setAgentRunCheckpoint(id, checkpoint, updatedAt) {
      connection.prepare(
        'UPDATE agent_runs SET checkpoint = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(checkpoint), updatedAt, id)
      return toRun(getRunStatement.get(id))
    },
    createAgent({ id, runId, role, name, model, backend = '', state = 'idle', tokenHash, promptCacheKey = '', createdAt }) {
      insertAgentStatement.run({
        id,
        runId,
        role,
        name,
        model,
        backend,
        state,
        tokenHash,
        promptCacheKey,
        createdAt
      })
      return toAgent(getAgentStatement.get(id))
    },
    getAgent(id) {
      return toAgent(getAgentStatement.get(id))
    },
    getAgentByRunAndName(runId, name) {
      return toAgent(getAgentByRunNameStatement.get(runId, name))
    },
    getAgentByTokenHash(tokenHash) {
      return toAgent(getAgentByTokenHashStatement.get(tokenHash), { includeTokenHash: true })
    },
    listAgents(runId) {
      return listAgentsStatement.all(runId).map((row) => toAgent(row))
    },
    updateAgent(id, { state, leaseUntil, heartbeatAt, finishedAt, promptCacheKey } = {}) {
      const sets = []
      const params = { id }
      if (state !== undefined) {
        sets.push('state = @state')
        params.state = state
      }
      if (leaseUntil !== undefined) {
        sets.push('lease_until = @leaseUntil')
        params.leaseUntil = leaseUntil
      }
      if (heartbeatAt !== undefined) {
        sets.push('heartbeat_at = @heartbeatAt')
        params.heartbeatAt = heartbeatAt
      }
      if (finishedAt !== undefined) {
        sets.push('finished_at = @finishedAt')
        params.finishedAt = finishedAt
      }
      if (promptCacheKey !== undefined) {
        sets.push('prompt_cache_key = @promptCacheKey')
        params.promptCacheKey = promptCacheKey
      }
      if (sets.length > 0) {
        connection.prepare(`UPDATE agent_agents SET ${sets.join(', ')} WHERE id = @id`).run(params)
      }
      return toAgent(getAgentStatement.get(id))
    },
    createAgentMessage({ id, runId, fromAgentId, toAgentId, kind, correlationId = '', seq, payload = {}, artifactRefs = [], idempotencyKey, maxAttempts = 3, createdAt, expiresAt = null }) {
      insertMessageStatement.run({
        id,
        runId,
        fromAgentId,
        toAgentId,
        kind,
        correlationId,
        seq,
        payload: JSON.stringify(payload),
        artifactRefs: JSON.stringify(artifactRefs),
        idempotencyKey,
        maxAttempts,
        createdAt,
        expiresAt
      })
      return toMessage(getMessageStatement.get(id))
    },
    getAgentMessage(id) {
      return toMessage(getMessageStatement.get(id))
    },
    findAgentMessageByIdempotency(runId, idempotencyKey) {
      return toMessage(getMessageByIdempotencyStatement.get(runId, idempotencyKey))
    },
    nextAgentMessageSeq(runId) {
      return nextSeqStatement.get(runId).seq
    },
    listAgentMessages(runId, { limit = 100, afterSeq = 0 } = {}) {
      return listMessagesStatement.all(runId, afterSeq, limit).map(toMessage)
    },
    claimAgentMessages(runId, agentId, { limit = 10, nowMs, leaseMs = 30000 } = {}) {
      return claimMessages(runId, agentId, limit, nowMs, leaseMs)
    },
    ackAgentMessage(id, ackedAt) {
      ackMessageStatement.run(ackedAt, id)
      return toMessage(getMessageStatement.get(id))
    },
    completeAgentMessage(id, result) {
      completeMessageStatement.run(
        result === undefined ? null : JSON.stringify(result),
        id
      )
      return toMessage(getMessageStatement.get(id))
    },
    failAgentMessage(id, { state, error, attempts }) {
      failMessageStatement.run(state, error, attempts, id)
      return toMessage(getMessageStatement.get(id))
    },
    expireAgentRunMessages(runId) {
      return expireRunMessagesStatement.run(runId).changes
    },
    appendAgentEvent(runId, agentId, type, data, createdAt) {
      const payload = data ?? {}
      const result = insertEventStatement.run(
        runId,
        agentId ?? null,
        type,
        JSON.stringify(payload),
        createdAt
      )
      // Build the row from the inputs instead of re-reading it; event
      // appends are on the hot message path and callers do not need a
      // database round-trip for fields they just wrote.
      return {
        id: Number(result.lastInsertRowid),
        runId,
        ...(agentId ? { agentId } : {}),
        type,
        data: payload,
        createdAt
      }
    },
    listAgentEvents(runId, { limit = 200 } = {}) {
      return listEventsStatement.all(runId, limit).map(toEvent)
    }
  }
}

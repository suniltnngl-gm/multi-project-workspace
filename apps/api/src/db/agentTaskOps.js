// Objective: Apply parent-agent task operations with scoping, optimistic concurrency, idempotency, and verifier-gated completion.
// Requirements: Only a parent agent may write; creates must hang off the run task or a task created by the same run; updates must carry the expected updated_at; done requires an explicit verifier result; opportunistic work becomes a proposal.
// Decisions: Each op runs in its own transaction so one conflict cannot roll back unrelated work; the op ledger is the idempotency boundary; task links stay out of generic PATCH handling; proposal creation reuses the existing dry-run store.
// Relevant Files: apps/api/src/db/agentTaskOps.js, apps/api/src/db/tasks.js, apps/api/src/db/taskProposals.js, apps/api/src/db/agentRuns.js, apps/api/src/routes/agents.js
// Important Context: User file. The broker authenticates the agent; this store only sees the resolved agent and run.
import { randomUUID } from 'node:crypto'
import { validateTaskInput } from '../routes/util.js'
import { isTerminalRunState, MAX_TASK_OPS_CREATES_PER_RUN, MAX_TASK_OPS_PER_BATCH } from '../agentProtocol.js'

const CREATE_FIELDS = new Set([
  'title', 'description', 'project', 'status', 'priority', 'task_type',
  'acceptance_criteria', 'objectives', 'requirements', 'decisions',
  'relevant_files', 'important_context', 'work_completed', 'work_active',
  'work_blocked', 'next_move'
])
const UPDATE_FIELDS = new Set([
  'description', 'acceptance_criteria', 'status', 'priority',
  'objectives', 'requirements', 'decisions', 'relevant_files',
  'important_context', 'work_completed', 'work_active', 'work_blocked',
  'next_move'
])
const TEXT_FIELDS = new Set([
  'description', 'acceptance_criteria', 'objectives', 'requirements',
  'decisions', 'relevant_files', 'important_context', 'work_completed',
  'work_active', 'work_blocked', 'next_move'
])

function errorResult(status, message) {
  return { error: { status, body: { error: message } } }
}

function pickFields(source, allowed) {
  const result = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(key)) result[key] = value
  }
  for (const key of Object.keys(result)) {
    if (TEXT_FIELDS.has(key) && typeof result[key] === 'string') result[key] = result[key].trim()
  }
  return result
}

function normalizeProposal(op) {
  return {
    title: typeof op.title === 'string' ? op.title.trim() : '',
    description: typeof op.description === 'string' ? op.description.trim() : '',
    priority: op.priority ?? 'medium',
    task_type: op.task_type ?? 'chore',
    project: typeof op.project === 'string' && op.project.trim() ? op.project.trim() : 'workspace',
    rationale: typeof op.rationale === 'string' ? op.rationale.trim() : ''
  }
}

export function createAgentTaskOpsStore(connection, {
  tasks,
  proposals,
  agentRuns,
  now = Date.now,
  idFactory = (prefix) => `${prefix}_${randomUUID()}`
} = {}) {
  if (!connection || !tasks || !proposals || !agentRuns) {
    throw new Error('createAgentTaskOpsStore requires a connection, tasks, proposals, and agentRuns.')
  }

  const insertOpStatement = connection.prepare(`
    INSERT INTO agent_task_ops (
      id, run_id, agent_id, op_id, op, task_id, status, result, created_at
    ) VALUES (
      @id, @runId, @agentId, @opId, @op, @taskId, @status, @result, @createdAt
    )
  `)
  const getOpStatement = connection.prepare(
    'SELECT * FROM agent_task_ops WHERE run_id = ? AND op_id = ?'
  )
  const listOpsStatement = connection.prepare(
    'SELECT * FROM agent_task_ops WHERE run_id = ? ORDER BY created_at ASC, id ASC'
  )
  const countCreatedTasksStatement = connection.prepare(
    `SELECT COUNT(*) AS count FROM agent_task_ops
     WHERE run_id = ? AND op = 'create_task' AND status = 'created'`
  )

  function readOp(row) {
    if (!row) return null
    return {
      id: row.id,
      runId: row.run_id,
      ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
      opId: row.op_id,
      op: row.op,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      status: row.status,
      result: row.result ? JSON.parse(row.result) : {},
      createdAt: row.created_at
    }
  }

  function getOp(runId, opId) {
    return readOp(getOpStatement.get(runId, opId))
  }

  function listOps(runId) {
    return listOpsStatement.all(runId).map(readOp)
  }

  function recordOp({ runId, agentId, opId, op, taskId = null, status, result }) {
    insertOpStatement.run({
      id: idFactory('aop'),
      runId,
      agentId,
      opId,
      op,
      taskId,
      status,
      result: JSON.stringify(result ?? {}),
      createdAt: now()
    })
    return getOp(runId, opId)
  }

  function taskInScope(task, run) {
    return task.id === run.taskId || task.agent_run_id === run.id
  }

  function createTaskOp(op, run) {
    const fields = pickFields(op, CREATE_FIELDS)
    if (fields.status === 'done') {
      return { status: 'rejected', error: 'create_task cannot create an already-done task.' }
    }
    const validationError = validateTaskInput({ ...fields, title: fields.title })
    if (validationError) return { status: 'rejected', error: validationError }

    const parentTaskId = op.parent_task_id ?? run.taskId ?? null
    if (parentTaskId === null) {
      return { status: 'rejected', error: 'A parent task is required for create_task.' }
    }
    if (!Number.isSafeInteger(parentTaskId) || parentTaskId <= 0) {
      return { status: 'rejected', error: 'Parent task ID must be a positive integer.' }
    }
    const parent = tasks.getTask(parentTaskId)
    if (!parent) return { status: 'rejected', error: 'Parent task not found.' }
    if (!taskInScope(parent, run)) {
      return { status: 'rejected', error: 'Parent task is outside this agent run.' }
    }

    const creates = countCreatedTasksStatement.get(run.id).count
    if (creates >= MAX_TASK_OPS_CREATES_PER_RUN) {
      return {
        status: 'rejected',
        error: `A run may create at most ${MAX_TASK_OPS_CREATES_PER_RUN} tasks.`
      }
    }

    const task = tasks.createTask(fields)
    tasks.linkTaskToAgentRun(task.id, run.id, parentTaskId)
    return { status: 'created', taskId: task.id, result: { taskId: task.id, parentTaskId } }
  }

  function updateTaskOp(op, run) {
    const taskId = op.task_id
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      return { status: 'rejected', error: 'Task ID must be a positive integer.' }
    }
    const task = tasks.getTask(taskId)
    if (!task) return { status: 'rejected', error: 'Task not found.' }
    if (!taskInScope(task, run)) {
      return { status: 'rejected', error: 'Task is outside this agent run.' }
    }
    if (typeof op.expected_updated_at !== 'string' || !op.expected_updated_at) {
      return { status: 'rejected', error: 'expected_updated_at is required for update_task.' }
    }

    const fields = pickFields(op.fields, UPDATE_FIELDS)
    if (Object.keys(fields).length === 0) {
      return { status: 'rejected', error: 'Provide at least one task field to update.' }
    }
    const validationError = validateTaskInput(fields, { partial: true })
    if (validationError) return { status: 'rejected', error: validationError }

    if (fields.status === 'done') {
      if (op.verified !== true) {
        return { status: 'rejected', error: 'Setting done requires verified: true.' }
      }
      const criteria = (fields.acceptance_criteria ?? task.acceptance_criteria ?? '').trim()
      if (!criteria) {
        return { status: 'rejected', error: 'Setting done requires non-empty acceptance criteria.' }
      }
    }
    if (fields.status === 'blocked') {
      const reason = (op.reason ?? fields.work_blocked ?? '').trim()
      if (!reason) {
        return { status: 'rejected', error: 'Setting blocked requires a reason.' }
      }
      fields.work_blocked = reason
    }

    const outcome = tasks.updateTaskIfUnchanged(taskId, op.expected_updated_at, fields)
    if (!outcome.ok && outcome.reason === 'missing') {
      return { status: 'rejected', error: 'Task not found.' }
    }
    if (!outcome.ok && outcome.reason === 'conflict') {
      return {
        status: 'conflict',
        taskId,
        result: {
          taskId,
          expectedUpdatedAt: op.expected_updated_at,
          currentUpdatedAt: outcome.task.updated_at
        }
      }
    }
    return {
      status: 'updated',
      taskId,
      result: { taskId, updatedAt: outcome.task.updated_at }
    }
  }

  function proposeTaskOp(op, run) {
    const proposal = normalizeProposal(op)
    const validationError = validateTaskInput({
      title: proposal.title,
      description: proposal.description,
      priority: proposal.priority,
      task_type: proposal.task_type,
      project: proposal.project
    })
    if (validationError) return { status: 'rejected', error: validationError }

    const created = proposals.createTaskProposals({
      proposals: [proposal],
      jobId: '',
      agentRunId: run.id
    })
    if (created.created.length === 0) {
      return {
        status: 'skipped',
        result: { skipped: created.skipped, reason: 'A matching proposal is already pending.' }
      }
    }
    return {
      status: 'proposed',
      result: { proposalId: created.created[0].id, taskId: null }
    }
  }

  const applyOne = connection.transaction((agent, run, op) => {
    const existing = getOp(run.id, op.op_id)
    if (existing) return { existing }

    let outcome
    if (op.op === 'create_task') outcome = createTaskOp(op, run)
    else if (op.op === 'update_task') outcome = updateTaskOp(op, run)
    else if (op.op === 'propose_task') outcome = proposeTaskOp(op, run)
    else outcome = { status: 'rejected', error: 'Unsupported task op.' }

    const taskId = Number.isSafeInteger(outcome.taskId) ? outcome.taskId : null
    recordOp({
      runId: run.id,
      agentId: agent.id,
      opId: op.op_id,
      op: op.op,
      taskId: taskId ?? outcome.result?.taskId ?? null,
      status: outcome.status,
      result: outcome.result ?? (outcome.error ? { error: outcome.error } : {})
    })
    return { outcome }
  })

  function applyTaskOps({ agent, ops } = {}) {
    if (!agent) return errorResult(401, 'A valid agent token is required.')
    if (agent.role !== 'parent') {
      return errorResult(403, 'Only the parent agent can change tasks.')
    }
    const run = agentRuns.getAgentRun(agent.runId)
    if (!run) return errorResult(404, 'Agent run not found.')
    if (isTerminalRunState(run.state)) {
      return errorResult(409, `Agent run is ${run.state}.`)
    }
    if (!Array.isArray(ops) || ops.length === 0) {
      return errorResult(400, 'Provide at least one task op.')
    }
    if (ops.length > MAX_TASK_OPS_PER_BATCH) {
      return errorResult(400, `At most ${MAX_TASK_OPS_PER_BATCH} task ops are allowed per batch.`)
    }

    const seen = new Set()
    for (const op of ops) {
      if (!op || typeof op !== 'object' || Array.isArray(op)) {
        return errorResult(400, 'Each task op must be a JSON object.')
      }
      if (typeof op.op_id !== 'string' || !op.op_id.trim() || op.op_id.length > 100) {
        return errorResult(400, 'Each task op needs a non-empty op_id of at most 100 characters.')
      }
      if (seen.has(op.op_id)) {
        return errorResult(400, `Duplicate op_id in batch: ${op.op_id}.`)
      }
      seen.add(op.op_id)
    }

    const results = []
    for (const op of ops) {
      const applied = applyOne(agent, run, op)
      if (applied.existing) {
        results.push({
          opId: op.op_id,
          op: op.op,
          status: 'duplicate',
          ...applied.existing.result
        })
        continue
      }
      const outcome = applied.outcome
      results.push({
        opId: op.op_id,
        op: op.op,
        status: outcome.status,
        ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.result !== undefined ? { result: outcome.result } : {})
      })
    }
    return { results }
  }

  return {
    applyTaskOps,
    getAgentTaskOp: getOp,
    listAgentTaskOps: listOps
  }
}

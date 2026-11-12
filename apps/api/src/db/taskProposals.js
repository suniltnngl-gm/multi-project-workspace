// Objective: Own the task proposal domain: model-backed improvement drafts that become tasks only after approval.
// Requirements: Proposals persist as dry-run records; approve creates the task and links its origin in one transaction; reject records the decision; rollback deletes the created task without erasing the proposal's history.
// Decisions: The store takes the tasks store the way gitWorktrees takes repositories so approve and rollback coordinate task creation and deletion atomically (better-sqlite3 nests transactions via savepoints); re-runs skip titles that still have an undecided proposal so pending work is not duplicated, while decided titles may be proposed again; created_task_id survives rollback as the historical record of what the proposal created; priority and task type normalize to their defaults instead of rejecting, mirroring how the improve route coerces model output.
// Relevant Files: apps/api/src/db/taskProposals.js, apps/api/src/db/tasks.js, apps/api/src/routes/proposals.js, apps/api/src/routes/aiDrafts.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface; fed by the AI improve route.
// Work State: Completed: Added as task #41; rollback updates a prepared statement as task #56; Active: None; Blocked: None; Next Move: Maintain as needed.
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])

export function createTaskProposalsStore(connection, { tasks } = {}) {
  const listProposalsStatement = connection.prepare(`
    SELECT * FROM task_proposals
    ORDER BY task_proposals.created_at DESC, task_proposals.id DESC
  `)
  const listProposalsByStatusStatement = connection.prepare(`
    SELECT * FROM task_proposals
    WHERE status = ?
    ORDER BY task_proposals.created_at DESC, task_proposals.id DESC
  `)
  const getProposalStatement = connection.prepare('SELECT * FROM task_proposals WHERE id = ?')
  const listUndecidedByTitleStatement = connection.prepare(`
    SELECT title FROM task_proposals WHERE status IN ('proposed')
  `)
  const insertProposalStatement = connection.prepare(`
    INSERT INTO task_proposals
      (title, description, priority, task_type, project, rationale, origin_job_id, origin_agent_run_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
  `)
  const decideProposalStatement = connection.prepare(`
    UPDATE task_proposals
    SET status = ?, created_task_id = ?, decided_at = ?, updated_at = ?
    WHERE id = ?
  `)
  const rollbackProposalStatement = connection.prepare(
    'UPDATE task_proposals SET status = ?, updated_at = ? WHERE id = ?'
  )

  function toProposal(row) {
    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      priority: row.priority,
      taskType: row.task_type,
      project: row.project,
      rationale: row.rationale,
      originJobId: row.origin_job_id,
      ...(row.origin_agent_run_id ? { originAgentRunId: row.origin_agent_run_id } : {}),
      status: row.status,
      ...(row.created_task_id !== null ? { createdTaskId: row.created_task_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {})
    }
  }

  function normalizePriority(value) {
    return PRIORITIES.has(value) ? value : 'medium'
  }

  function normalizeTaskType(value) {
    return TASK_TYPES.has(value) ? value : 'chore'
  }

  /**
   * Persist one run's suggestions as fresh proposals. Suggestions whose title
   * already has an undecided proposal are skipped so a re-run does not
   * duplicate pending work; titles that were decided may be proposed again.
   */
  const createTaskProposals = connection.transaction(({ proposals = [], jobId = '', agentRunId = '' } = {}) => {
    const now = new Date().toISOString()
    const pending = new Set(
      listUndecidedByTitleStatement.all().map((row) => row.title.trim().toLowerCase())
    )
    const created = []
    let skipped = 0
    for (const proposal of proposals) {
      const title = typeof proposal?.title === 'string' ? proposal.title.trim().slice(0, 200) : ''
      if (!title) continue
      if (pending.has(title.toLowerCase())) {
        skipped += 1
        continue
      }
      pending.add(title.toLowerCase())
      const result = insertProposalStatement.run(
        title,
        typeof proposal.description === 'string' ? proposal.description.slice(0, 2000) : '',
        normalizePriority(proposal.priority),
        normalizeTaskType(proposal.task_type),
        typeof proposal.project === 'string' && proposal.project.trim() ? proposal.project.trim().slice(0, 100) : 'workspace',
        typeof proposal.rationale === 'string' ? proposal.rationale.slice(0, 2000) : '',
        typeof jobId === 'string' ? jobId : '',
        typeof agentRunId === 'string' ? agentRunId : '',
        now,
        now
      )
      created.push(toProposal(getProposalStatement.get(Number(result.lastInsertRowid))))
    }
    return { created, skipped }
  })

  /**
   * Approve a proposal: create its task, link the drafting origin, and stamp
   * the decision - one transaction, so a task never exists without its
   * proposal linkage or the reverse.
   */
  const approveTaskProposal = connection.transaction((id) => {
    const row = getProposalStatement.get(id)
    if (!row) return { error: { status: 404, body: { error: 'Task proposal not found.' } } }
    if (row.status !== 'proposed') {
      return { error: { status: 409, body: { error: `Only proposed task proposals can be approved (currently ${row.status}).` } } }
    }
    const task = tasks.createTask({
      title: row.title,
      description: row.description,
      priority: row.priority,
      task_type: row.task_type,
      project: row.project
    })
    if (row.origin_job_id !== '') {
      tasks.setTaskOrigin(task.id, row.origin_job_id)
    }
    const now = new Date().toISOString()
    decideProposalStatement.run('approved', task.id, now, now, id)
    return { proposal: toProposal(getProposalStatement.get(id)), task: tasks.getTask(task.id) }
  })

  const rejectTaskProposal = connection.transaction((id) => {
    const row = getProposalStatement.get(id)
    if (!row) return { error: { status: 404, body: { error: 'Task proposal not found.' } } }
    if (row.status !== 'proposed') {
      return { error: { status: 409, body: { error: `Only proposed task proposals can be rejected (currently ${row.status}).` } } }
    }
    const now = new Date().toISOString()
    decideProposalStatement.run('rejected', null, now, now, id)
    return { proposal: toProposal(getProposalStatement.get(id)) }
  })

  /**
   * Roll back an approval: delete the task it created (unlinking the drafting
   * job like any task deletion) and mark the proposal rolled back. The
   * created task id and decision time survive as the historical record.
   */
  const rollbackTaskProposal = connection.transaction((id) => {
    const row = getProposalStatement.get(id)
    if (!row) return { error: { status: 404, body: { error: 'Task proposal not found.' } } }
    if (row.status !== 'approved') {
      return { error: { status: 409, body: { error: `Only approved task proposals can be rolled back (currently ${row.status}).` } } }
    }
    if (row.created_task_id !== null) {
      tasks.deleteTask(row.created_task_id)
    }
    const now = new Date().toISOString()
    rollbackProposalStatement.run('rolled_back', now, id)
    return { proposal: toProposal(getProposalStatement.get(id)) }
  })

  return {
    listTaskProposals({ status } = {}) {
      if (status === undefined) return listProposalsStatement.all().map(toProposal)
      return listProposalsByStatusStatement.all(String(status)).map(toProposal)
    },
    getTaskProposal(id) {
      return toProposal(getProposalStatement.get(id))
    },
    createTaskProposals,
    approveTaskProposal,
    rejectTaskProposal,
    rollbackTaskProposal
  }
}

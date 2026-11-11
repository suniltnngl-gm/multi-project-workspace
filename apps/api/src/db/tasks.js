// Objective: Own task rows, their activity trail, and task-linked AI run reads.
// Requirements: Record field-level activity events; keep drafting and worktree provenance out of generic task edits; keep AI runs inspectable after task deletion.
// Decisions: The task-centric ai_jobs reads and the unlink write live here because they key off task identity; toAiRun is imported from the jobs store; TASK_COLUMNS is exported for the migration sequence.
// Relevant Files: apps/api/src/db/tasks.js, apps/api/src/db/aiJobs.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { toAiRun } from './aiJobs.js'

export const TASK_COLUMNS = {
  project: "TEXT NOT NULL DEFAULT 'workspace'",
  status: "TEXT NOT NULL DEFAULT 'todo'",
  priority: "TEXT NOT NULL DEFAULT 'medium'",
  task_type: "TEXT NOT NULL DEFAULT 'feature'",
  acceptance_criteria: "TEXT NOT NULL DEFAULT ''",
  objectives: "TEXT NOT NULL DEFAULT ''",
  requirements: "TEXT NOT NULL DEFAULT ''",
  decisions: "TEXT NOT NULL DEFAULT ''",
  relevant_files: "TEXT NOT NULL DEFAULT ''",
  important_context: "TEXT NOT NULL DEFAULT ''",
  work_completed: "TEXT NOT NULL DEFAULT ''",
  work_active: "TEXT NOT NULL DEFAULT ''",
  work_blocked: "TEXT NOT NULL DEFAULT ''",
  next_move: "TEXT NOT NULL DEFAULT ''",
  worktree_path: "TEXT NOT NULL DEFAULT ''",
  origin_job_id: "TEXT NOT NULL DEFAULT ''"
}

function toTask(row) {
  if (!row) return null
  return { ...row, completed: row.status === 'done' || Boolean(row.completed) }
}

function toTaskEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    action: row.action,
    ...(row.field !== null ? { field: row.field } : {}),
    ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
    ...(row.new_value !== null ? { newValue: row.new_value } : {}),
    createdAt: row.created_at
  }
}

export function createTasksStore(connection) {
  const taskFields = 'id, title, description, completed, project, status, priority, task_type, acceptance_criteria, objectives, requirements, decisions, relevant_files, important_context, work_completed, work_active, work_blocked, next_move, worktree_path, origin_job_id, created_at, updated_at'
  const taskOrder = "ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC"
  const getStatement = connection.prepare(
    `SELECT ${taskFields} FROM tasks WHERE id = ?`
  )
  const insertStatement = connection.prepare(
    'INSERT INTO tasks (title, description, project, status, priority, task_type, acceptance_criteria, objectives, requirements, decisions, relevant_files, important_context, work_completed, work_active, work_blocked, next_move, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const updateStatement = connection.prepare(
    'UPDATE tasks SET title = ?, description = ?, project = ?, status = ?, priority = ?, task_type = ?, acceptance_criteria = ?, objectives = ?, requirements = ?, decisions = ?, relevant_files = ?, important_context = ?, work_completed = ?, work_active = ?, work_blocked = ?, next_move = ?, completed = ?, updated_at = ? WHERE id = ?'
  )
  const deleteStatement = connection.prepare('DELETE FROM tasks WHERE id = ?')
  const updateTaskWorktreeStatement = connection.prepare(
    'UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?'
  )
  const updateTaskOriginStatement = connection.prepare(
    'UPDATE tasks SET origin_job_id = ?, updated_at = ? WHERE id = ?'
  )
  const listTaskEventsStatement = connection.prepare(`
    SELECT id, task_id, action, field, old_value, new_value, created_at
    FROM task_events
    WHERE task_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const insertTaskEventStatement = connection.prepare(`
    INSERT INTO task_events (task_id, action, field, old_value, new_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const projectsStatement = connection.prepare('SELECT DISTINCT project FROM tasks ORDER BY project COLLATE NOCASE')
  const listTaskAiRunsStatement = connection.prepare(`
    SELECT id, task_id, model, backend, state, phase, title, created_at,
           started_at, finished_at, error, status, retry_after
    FROM ai_jobs
    WHERE task_id = ? OR id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `)
  const unlinkTaskJobsStatement = connection.prepare(
    'UPDATE ai_jobs SET task_id = NULL WHERE task_id = ?'
  )

  const TASK_ACTIVITY_FIELDS = [
    'title', 'description', 'project', 'status', 'priority', 'task_type',
    'acceptance_criteria', 'objectives', 'requirements', 'decisions',
    'relevant_files', 'important_context', 'work_completed', 'work_active',
    'work_blocked', 'next_move'
  ]

  function readTask(id) {
    return toTask(getStatement.get(id))
  }

  function readTaskActivity(taskId, activityLimit = 50) {
    const requestedLimit = Number(activityLimit)
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(200, Math.trunc(requestedLimit))
      : 50
    return listTaskEventsStatement.all(taskId, limit).map(toTaskEvent)
  }

  // AI runs are matched by the job's task link or by the task's drafting
  // origin, so a task created from a draft shows the run that produced it.
  function readTaskAiRuns(task, aiLimit = 20) {
    const requestedLimit = Number(aiLimit)
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(100, Math.trunc(requestedLimit))
      : 20
    return listTaskAiRunsStatement.all(task.id, task.origin_job_id ?? '', limit).map(toAiRun)
  }

  const insertTaskRecord = connection.transaction((fields) => {
    const now = new Date().toISOString()
    const result = insertStatement.run(
      fields.title,
      fields.description,
      fields.project,
      fields.status,
      fields.priority,
      fields.task_type,
      fields.acceptance_criteria,
      fields.objectives,
      fields.requirements,
      fields.decisions,
      fields.relevant_files,
      fields.important_context,
      fields.work_completed,
      fields.work_active,
      fields.work_blocked,
      fields.next_move,
      fields.status === 'done' ? 1 : 0,
      now,
      now
    )
    const id = Number(result.lastInsertRowid)
    insertTaskEventStatement.run(id, 'created', null, null, null, now)
    return id
  })

  const deleteTaskRecord = connection.transaction((id) => {
    // AI runs survive task deletion but are unlinked so their history remains
    // inspectable without pointing at a missing task.
    unlinkTaskJobsStatement.run(id)
    return deleteStatement.run(id).changes > 0
  })

  const applyTaskUpdate = connection.transaction((id, changes) => {
    const current = readTask(id)
    if (!current) return null

    const status = changes.status ?? (changes.completed === undefined
      ? current.status
      : changes.completed ? 'done' : 'todo')
    const next = {
      title: changes.title ?? current.title,
      description: changes.description ?? current.description,
      project: changes.project ?? current.project,
      status,
      priority: changes.priority ?? current.priority,
      task_type: changes.task_type ?? current.task_type,
      acceptance_criteria: changes.acceptance_criteria ?? current.acceptance_criteria,
      objectives: changes.objectives ?? current.objectives,
      requirements: changes.requirements ?? current.requirements,
      decisions: changes.decisions ?? current.decisions,
      relevant_files: changes.relevant_files ?? current.relevant_files,
      important_context: changes.important_context ?? current.important_context,
      work_completed: changes.work_completed ?? current.work_completed,
      work_active: changes.work_active ?? current.work_active,
      work_blocked: changes.work_blocked ?? current.work_blocked,
      next_move: changes.next_move ?? current.next_move
    }
    const changedFields = TASK_ACTIVITY_FIELDS.filter(
      (field) => current[field] !== next[field]
    )
    if (changedFields.length === 0) return current

    const updatedAt = new Date().toISOString()
    updateStatement.run(
      next.title,
      next.description,
      next.project,
      next.status,
      next.priority,
      next.task_type,
      next.acceptance_criteria,
      next.objectives,
      next.requirements,
      next.decisions,
      next.relevant_files,
      next.important_context,
      next.work_completed,
      next.work_active,
      next.work_blocked,
      next.next_move,
      next.status === 'done' ? 1 : 0,
      updatedAt,
      id
    )
    for (const field of changedFields) {
      insertTaskEventStatement.run(
        id,
        'updated',
        field,
        String(current[field]),
        String(next[field]),
        updatedAt
      )
    }
    return readTask(id)
  })

  // The worktree link is owned by the lifecycle endpoints, never by generic
  // task edits, so its history is recorded as explicit link/unlink events.
  const applyTaskWorktreeUpdate = connection.transaction((id, path, action) => {
    const current = readTask(id)
    if (!current) return null
    const updatedAt = new Date().toISOString()
    updateTaskWorktreeStatement.run(path, updatedAt, id)
    insertTaskEventStatement.run(
      id,
      action,
      'worktree_path',
      String(current.worktree_path ?? ''),
      String(path),
      updatedAt
    )
    return readTask(id)
  })

  // Drafting provenance is owned by the creation flows, never by generic
  // task edits, so it is recorded as an explicit drafted event.
  const applyTaskOriginUpdate = connection.transaction((id, jobId) => {
    const current = readTask(id)
    if (!current) return null
    const updatedAt = new Date().toISOString()
    updateTaskOriginStatement.run(jobId, updatedAt, id)
    insertTaskEventStatement.run(
      id,
      'drafted',
      'origin_job_id',
      String(current.origin_job_id ?? ''),
      String(jobId),
      updatedAt
    )
    return readTask(id)
  })
  return {
    listTasks(filters = {}) {
      const conditions = []
      const values = []
      for (const field of ['project', 'status', 'priority', 'task_type']) {
        if (filters[field]) {
          conditions.push(`${field} = ?`)
          values.push(filters[field])
        }
      }
      if (filters.search) {
        const searchFields = [
          'title', 'description', 'acceptance_criteria', 'objectives',
          'requirements', 'decisions', 'relevant_files', 'important_context',
          'work_completed', 'work_active', 'work_blocked', 'next_move'
        ]
        conditions.push(
          `(${searchFields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`
        )
        const search = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`
        values.push(...searchFields.map(() => search))
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = connection.prepare(`SELECT ${taskFields} FROM tasks ${where} ${taskOrder}`).all(...values)
      return rows.map(toTask)
    },
    getTask(id) {
      return readTask(id)
    },
    getTaskDetail(id, { activityLimit = 50, aiLimit = 20 } = {}) {
      const task = readTask(id)
      if (!task) return null
      return {
        ...task,
        activity: readTaskActivity(id, activityLimit),
        aiRuns: readTaskAiRuns(task, aiLimit)
      }
    },
    listTaskActivity(id, { limit = 50 } = {}) {
      if (!readTask(id)) return null
      return readTaskActivity(id, limit)
    },
    listTaskAiRuns(id, { limit = 20 } = {}) {
      const task = readTask(id)
      if (!task) return null
      return readTaskAiRuns(task, limit)
    },
    listProjects() {
      return projectsStatement.all().map(({ project }) => project)
    },
    createTask({
      title,
      description = '',
      project = 'workspace',
      status = 'todo',
      priority = 'medium',
      task_type = 'feature',
      acceptance_criteria = '',
      objectives = '',
      requirements = '',
      decisions = '',
      relevant_files = '',
      important_context = '',
      work_completed = '',
      work_active = '',
      work_blocked = '',
      next_move = ''
    }) {
      const id = insertTaskRecord({
        title,
        description,
        project,
        status,
        priority,
        task_type,
        acceptance_criteria,
        objectives,
        requirements,
        decisions,
        relevant_files,
        important_context,
        work_completed,
        work_active,
        work_blocked,
        next_move
      })
      return readTask(id)
    },
    updateTask(id, changes) {
      return applyTaskUpdate(id, changes)
    },
    linkTaskWorktree(id, path) {
      return applyTaskWorktreeUpdate(id, path, 'worktree_linked')
    },
    unlinkTaskWorktree(id) {
      return applyTaskWorktreeUpdate(id, '', 'worktree_unlinked')
    },
    setTaskOrigin(id, jobId) {
      return applyTaskOriginUpdate(id, jobId)
    },
    deleteTask(id) {
      return deleteTaskRecord(id)
    },
  }
}

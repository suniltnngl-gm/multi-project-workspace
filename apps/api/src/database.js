import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const defaultDatabasePath = fileURLToPath(new URL('../data/workspace.sqlite', import.meta.url))
const TASK_COLUMNS = {
  project: "TEXT NOT NULL DEFAULT 'workspace'",
  status: "TEXT NOT NULL DEFAULT 'todo'",
  priority: "TEXT NOT NULL DEFAULT 'medium'",
  task_type: "TEXT NOT NULL DEFAULT 'feature'",
  acceptance_criteria: "TEXT NOT NULL DEFAULT ''"
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

function toJob(row) {
  if (!row) return null
  return {
    id: row.id,
    state: row.state,
    phase: row.phase,
    model: row.model,
    title: row.title,
    createdAt: row.created_at,
    ...(row.backend !== null && row.backend !== undefined ? { backend: row.backend } : {}),
    ...(row.task_id !== null && row.task_id !== undefined ? { taskId: row.task_id } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.result !== null ? { result: JSON.parse(row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.retry_after !== null && row.retry_after !== undefined
      ? { retryAfter: row.retry_after }
      : {})
  }
}

function toAiRun(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    model: row.model,
    ...(row.backend !== null ? { backend: row.backend } : {}),
    state: row.state,
    phase: row.phase,
    title: row.title,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.started_at !== null && row.finished_at !== null
      ? { durationMs: Math.max(0, row.finished_at - row.started_at) }
      : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.retry_after !== null ? { retryAfter: row.retry_after } : {})
  }
}

export function createDatabase(databasePath = process.env.DATABASE_PATH || defaultDatabasePath) {
  const resolvedPath = resolve(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  const connection = new Database(resolvedPath)
  connection.pragma('journal_mode = WAL')
  connection.pragma('foreign_keys = ON')
  connection.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
      description TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      project TEXT NOT NULL DEFAULT 'workspace',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      task_type TEXT NOT NULL DEFAULT 'feature',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task
      ON task_events(task_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued',
      model TEXT NOT NULL,
      backend TEXT,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT,
      error TEXT,
      status INTEGER,
      retry_after INTEGER
    );

    CREATE TABLE IF NOT EXISTS ai_budget (
      model TEXT NOT NULL,
      day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, day)
    );

    CREATE TABLE IF NOT EXISTS ai_quota (
      model TEXT NOT NULL,
      policy TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      used REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (model, policy, bucket)
    );
  `)

  // Carry the legacy daily counters into the generalized quota table. The old
  // table is kept so an interrupted upgrade can be retried, and the copy is
  // idempotent.
  connection.exec(`
    INSERT OR IGNORE INTO ai_quota (model, policy, bucket, used)
    SELECT model, '0:requests:day:fixed',
           CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000,
           used
    FROM ai_budget;
  `)

  const existingColumns = new Set(
    connection.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name)
  )
  for (const [column, definition] of Object.entries(TASK_COLUMNS)) {
    if (!existingColumns.has(column)) {
      connection.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`)
    }
  }
  const jobColumns = new Set(
    connection.prepare('PRAGMA table_info(ai_jobs)').all().map((column) => column.name)
  )
  if (!jobColumns.has('retry_after')) {
    connection.exec('ALTER TABLE ai_jobs ADD COLUMN retry_after INTEGER')
  }
  if (!jobColumns.has('backend')) {
    connection.exec('ALTER TABLE ai_jobs ADD COLUMN backend TEXT')
  }
  if (!jobColumns.has('task_id')) {
    connection.exec(
      'ALTER TABLE ai_jobs ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL'
    )
  }
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_task
      ON ai_jobs(task_id, created_at DESC);
  `)
  connection.exec(`
    UPDATE tasks SET status = 'done' WHERE completed = 1 AND status = 'todo';
    UPDATE tasks SET completed = CASE WHEN status = 'done' THEN 1 ELSE 0 END;
  `)

  // Existing tasks get a synthetic creation event so their history is never
  // blank after an upgrade. The NOT EXISTS guard makes startup idempotent.
  connection.exec(`
    INSERT INTO task_events (task_id, action, created_at)
    SELECT tasks.id, 'created', tasks.created_at
    FROM tasks
    WHERE NOT EXISTS (
      SELECT 1 FROM task_events
      WHERE task_events.task_id = tasks.id AND task_events.action = 'created'
    );
  `)

  const taskFields = 'id, title, description, completed, project, status, priority, task_type, acceptance_criteria, created_at, updated_at'
  const taskOrder = "ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC"
  const getStatement = connection.prepare(
    `SELECT ${taskFields} FROM tasks WHERE id = ?`
  )
  const insertStatement = connection.prepare(
    'INSERT INTO tasks (title, description, project, status, priority, task_type, acceptance_criteria, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const updateStatement = connection.prepare(
    'UPDATE tasks SET title = ?, description = ?, project = ?, status = ?, priority = ?, task_type = ?, acceptance_criteria = ?, completed = ?, updated_at = ? WHERE id = ?'
  )
  const deleteStatement = connection.prepare('DELETE FROM tasks WHERE id = ?')
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
  const listJobsStatement = connection.prepare(
    'SELECT * FROM ai_jobs ORDER BY created_at ASC, rowid ASC'
  )
  const listTaskAiRunsStatement = connection.prepare(`
    SELECT id, task_id, model, backend, state, phase, title, created_at,
           started_at, finished_at, error, status, retry_after
    FROM ai_jobs
    WHERE task_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `)
  const unlinkTaskJobsStatement = connection.prepare(
    'UPDATE ai_jobs SET task_id = NULL WHERE task_id = ?'
  )
  const saveJobStatement = connection.prepare(`
    INSERT INTO ai_jobs (
      id, state, phase, model, backend, task_id, title, created_at, started_at,
      finished_at, result, error, status, retry_after
    ) VALUES (
      @id, @state, @phase, @model, @backend, @taskId, @title, @createdAt,
      @startedAt, @finishedAt, @result, @error, @status, @retryAfter
    )
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state,
      phase = excluded.phase,
      backend = excluded.backend,
      task_id = excluded.task_id,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      result = excluded.result,
      error = excluded.error,
      status = excluded.status,
      retry_after = excluded.retry_after
  `)
  const getJobStatement = connection.prepare('SELECT * FROM ai_jobs WHERE id = ?')
  const deleteJobStatement = connection.prepare('DELETE FROM ai_jobs WHERE id = ?')
  const interruptJobsStatement = connection.prepare(`
    UPDATE ai_jobs
    SET state = 'error', phase = 'finished', error = ?, finished_at = ?
    WHERE state IN ('queued', 'running')
  `)
  const getQuotaStatement = connection.prepare(
    'SELECT used FROM ai_quota WHERE model = ? AND policy = ? AND bucket = ?'
  )
  const addQuotaStatement = connection.prepare(`
    INSERT INTO ai_quota (model, policy, bucket, used)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(model, policy, bucket) DO UPDATE SET used = used + excluded.used
  `)
  const latestQuotaStatement = connection.prepare(`
    SELECT bucket, used FROM ai_quota
    WHERE model = ? AND policy = ?
    ORDER BY bucket DESC
    LIMIT 1
  `)
  const pruneQuotaStatement = connection.prepare(
    'DELETE FROM ai_quota WHERE bucket < ?'
  )

  const TASK_ACTIVITY_FIELDS = [
    'title', 'description', 'project', 'status', 'priority', 'task_type',
    'acceptance_criteria'
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

  function readTaskAiRuns(taskId, aiLimit = 20) {
    const requestedLimit = Number(aiLimit)
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(100, Math.trunc(requestedLimit))
      : 20
    return listTaskAiRunsStatement.all(taskId, limit).map(toAiRun)
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
      acceptance_criteria: changes.acceptance_criteria ?? current.acceptance_criteria
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
        conditions.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR acceptance_criteria LIKE ? ESCAPE '\\')")
        const search = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`
        values.push(search, search, search)
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
        aiRuns: readTaskAiRuns(id, aiLimit)
      }
    },
    listTaskActivity(id, { limit = 50 } = {}) {
      if (!readTask(id)) return null
      return readTaskActivity(id, limit)
    },
    listTaskAiRuns(id, { limit = 20 } = {}) {
      if (!readTask(id)) return null
      return readTaskAiRuns(id, limit)
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
      acceptance_criteria = ''
    }) {
      const id = insertTaskRecord({
        title,
        description,
        project,
        status,
        priority,
        task_type,
        acceptance_criteria
      })
      return readTask(id)
    },
    updateTask(id, changes) {
      return applyTaskUpdate(id, changes)
    },
    deleteTask(id) {
      return deleteTaskRecord(id)
    },
    listJobs() {
      return listJobsStatement.all().map(toJob)
    },
    saveJob(job) {
      saveJobStatement.run({
        id: job.id,
        state: job.state,
        phase: job.phase ?? 'queued',
        model: job.model,
        backend: job.backend ?? null,
        taskId: job.taskId ?? null,
        title: job.title,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        result: job.result === undefined ? null : JSON.stringify(job.result),
        error: job.error ?? null,
        status: job.status ?? null,
        retryAfter: job.retryAfter ?? null
      })
      return toJob(getJobStatement.get(job.id))
    },
    deleteJob(id) {
      return deleteJobStatement.run(id).changes > 0
    },
    markInterruptedJobs(message, finishedAt = Date.now()) {
      return interruptJobsStatement.run(message, finishedAt).changes
    },
    getQuota(model, policy, bucket) {
      return getQuotaStatement.get(model, policy, bucket)?.used ?? 0
    },
    addQuota(model, policy, bucket, amount) {
      addQuotaStatement.run(model, policy, bucket, amount)
      return getQuotaStatement.get(model, policy, bucket)?.used ?? 0
    },
    getLatestQuota(model, policy) {
      const row = latestQuotaStatement.get(model, policy)
      return row ? { bucket: row.bucket, used: row.used } : null
    },
    pruneQuotaBefore(cutoff) {
      return pruneQuotaStatement.run(cutoff).changes
    },
    close() {
      connection.close()
    }
  }
}

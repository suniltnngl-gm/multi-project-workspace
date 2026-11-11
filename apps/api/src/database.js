import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const defaultDatabasePath = fileURLToPath(new URL('../data/workspace.sqlite', import.meta.url))
const TASK_COLUMNS = {
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

function toRepository(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.file_count !== undefined ? { fileCount: row.file_count } : {}),
    ...(row.folder_count !== undefined ? { folderCount: row.folder_count } : {}),
    ...(row.worktree_count !== undefined ? { worktreeCount: row.worktree_count } : {})
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

export function createDatabase(
  databasePath = process.env.DATABASE_PATH || defaultDatabasePath,
  { rootDir } = {}
) {
  const resolvedPath = resolve(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  const connection = new Database(resolvedPath)
  connection.pragma('journal_mode = WAL')
  connection.pragma('foreign_keys = ON')
  connection.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),
      root_path TEXT NOT NULL UNIQUE CHECK(length(trim(root_path)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS git_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
      repository_root TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL DEFAULT '',
      head_commit TEXT NOT NULL DEFAULT '',
      remote_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      user_template TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
      path TEXT NOT NULL CHECK(length(trim(path)) BETWEEN 1 AND 500),
      objective TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repository_id, path)
    );
  `)
  connection.exec(`
    CREATE TABLE IF NOT EXISTS user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
      path TEXT NOT NULL CHECK(length(trim(path)) BETWEEN 1 AND 500),
      objective TEXT NOT NULL DEFAULT '',
      requirements TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '',
      relevant_files TEXT NOT NULL DEFAULT '',
      important_context TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repository_id, path)
    );

    CREATE TABLE IF NOT EXISTS user_file_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_file_id INTEGER NOT NULL REFERENCES user_files(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_file_events_file
      ON user_file_events(user_file_id, created_at DESC, id DESC);
  `)
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
      objectives TEXT NOT NULL DEFAULT '',
      requirements TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '',
      relevant_files TEXT NOT NULL DEFAULT '',
      important_context TEXT NOT NULL DEFAULT '',
      work_completed TEXT NOT NULL DEFAULT '',
      work_active TEXT NOT NULL DEFAULT '',
      work_blocked TEXT NOT NULL DEFAULT '',
      next_move TEXT NOT NULL DEFAULT '',
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

  for (const [tableName, columnsToDrop] of [
    ['user_files', ['work_completed', 'work_active', 'work_blocked', 'next_move']],
    ['folders', ['important_context']]
  ]) {
    const columns = new Set(
      connection.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name)
    )
    for (const column of columnsToDrop) {
      if (columns.has(column)) {
        try {
          connection.exec(`ALTER TABLE ${tableName} DROP COLUMN ${column}`)
        } catch (error) {
          // Older SQLite builds cannot drop columns; leave them unused.
        }
      }
    }
  }

  // Add outcome-tracking columns to tables that predate them.
  for (const [tableName, columnsToAdd] of [
    ['tools', ['success_count', 'failure_count']]
  ]) {
    const columns = new Set(
      connection.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name)
    )
    for (const column of columnsToAdd) {
      if (!columns.has(column)) {
        try {
          connection.exec(
            `ALTER TABLE ${tableName} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
          )
        } catch (error) {
          // Ignore if the column already exists or cannot be added.
        }
      }
    }
  }

  // Older user_files tables predate content-hash tracking for header syncs.
  const userFileColumns = new Set(
    connection.prepare('PRAGMA table_info(user_files)').all().map((column) => column.name)
  )
  if (!userFileColumns.has('content_hash')) {
    connection.exec('ALTER TABLE user_files ADD COLUMN content_hash TEXT')
  }

  // Multi-repository registry. user_files and folders predate repository
  // scoping and key their path globally; the multi-repository shape keys
  // (repository_id, path). The rebuild preserves ids so the
  // user_file_events trail survives. Foreign keys are disabled around it so
  // dropping the old table cannot cascade into the event rows, per the
  // documented SQLite migration procedure.
  const folderColumns = new Set(
    connection.prepare('PRAGMA table_info(folders)').all().map((column) => column.name)
  )
  const worktreeColumns = new Set(
    connection.prepare('PRAGMA table_info(git_worktrees)').all().map((column) => column.name)
  )
  const repositoryBackfillNeeded =
    !userFileColumns.has('repository_id') ||
    !folderColumns.has('repository_id') ||
    !worktreeColumns.has('repository_id')

  // The primary repository is registered before any association column is
  // backfilled, so rows that predate scoping point at a real repository row
  // (id 1). Callers pass their workspace root via rootDir; when a legacy
  // database needs a backfill target and no root was given, the process
  // working directory stands in so backfilled rows never dangle.
  const hasAnyRepository =
    connection.prepare('SELECT 1 FROM repositories LIMIT 1').get() !== undefined
  if (!hasAnyRepository && (rootDir !== undefined || repositoryBackfillNeeded)) {
    const primaryRoot = resolve(String(rootDir !== undefined ? rootDir : process.cwd()))
    const now = new Date().toISOString()
    const baseName = basename(primaryRoot) || 'repository'
    let name = baseName
    let suffix = 2
    while (connection.prepare('SELECT 1 FROM repositories WHERE name = ?').get(name)) {
      name = `${baseName}-${suffix}`
      suffix += 1
    }
    connection.prepare(
      'INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).run(name, primaryRoot, now, now)
  } else if (rootDir !== undefined) {
    const primaryRoot = resolve(String(rootDir))
    const registered = connection.prepare(
      'SELECT id FROM repositories WHERE root_path = ?'
    ).get(primaryRoot)
    if (!registered) {
      const now = new Date().toISOString()
      const baseName = basename(primaryRoot) || 'repository'
      let name = baseName
      let suffix = 2
      while (connection.prepare('SELECT 1 FROM repositories WHERE name = ?').get(name)) {
        name = `${baseName}-${suffix}`
        suffix += 1
      }
      connection.prepare(
        'INSERT INTO repositories (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run(name, primaryRoot, now, now)
    }
  }

  if (!userFileColumns.has('repository_id')) {
    connection.pragma('foreign_keys = OFF')
    try {
      connection.transaction(() => {
        connection.exec(`
          CREATE TABLE user_files_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
            path TEXT NOT NULL CHECK(length(trim(path)) BETWEEN 1 AND 500),
            objective TEXT NOT NULL DEFAULT '',
            requirements TEXT NOT NULL DEFAULT '',
            decisions TEXT NOT NULL DEFAULT '',
            relevant_files TEXT NOT NULL DEFAULT '',
            important_context TEXT NOT NULL DEFAULT '',
            content_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(repository_id, path)
          );
        `)
        connection.exec(`
          INSERT INTO user_files_scoped (
            id, repository_id, path, objective, requirements, decisions,
            relevant_files, important_context, content_hash, created_at, updated_at
          )
          SELECT id, 1, path, objective, requirements, decisions,
                 relevant_files, important_context, content_hash, created_at, updated_at
          FROM user_files
        `)
        connection.exec('DROP TABLE user_files')
        connection.exec('ALTER TABLE user_files_scoped RENAME TO user_files')
      })()
    } finally {
      connection.pragma('foreign_keys = ON')
    }
  }

  if (!folderColumns.has('repository_id')) {
    connection.pragma('foreign_keys = OFF')
    try {
      connection.transaction(() => {
        connection.exec(`
          CREATE TABLE folders_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
            path TEXT NOT NULL CHECK(length(trim(path)) BETWEEN 1 AND 500),
            objective TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(repository_id, path)
          );
        `)
        connection.exec(`
          INSERT INTO folders_scoped (id, repository_id, path, objective, created_at, updated_at)
          SELECT id, 1, path, objective, created_at, updated_at
          FROM folders
        `)
        connection.exec('DROP TABLE folders')
        connection.exec('ALTER TABLE folders_scoped RENAME TO folders')
      })()
    } finally {
      connection.pragma('foreign_keys = ON')
    }
  }

  // Worktrees keep their globally unique absolute path; they gain the
  // repository link through a rebuild (ALTER cannot add a REFERENCES column
  // with a non-NULL default), backfilling the link by matching the recorded
  // repository root against registered repositories. Nothing references
  // git_worktrees, so the rebuild only preserves its own rows and ids.
  if (!worktreeColumns.has('repository_id')) {
    connection.pragma('foreign_keys = OFF')
    try {
      connection.transaction(() => {
        connection.exec(`
          CREATE TABLE git_worktrees_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id INTEGER NOT NULL DEFAULT 1 REFERENCES repositories(id),
            repository_root TEXT NOT NULL,
            worktree_path TEXT NOT NULL UNIQUE,
            branch TEXT NOT NULL DEFAULT '',
            head_commit TEXT NOT NULL DEFAULT '',
            remote_url TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `)
        connection.exec(`
          INSERT INTO git_worktrees_scoped (
            id, repository_id, repository_root, worktree_path, branch,
            head_commit, remote_url, created_at, updated_at
          )
          SELECT id,
                 COALESCE(
                   (SELECT repositories.id FROM repositories
                    WHERE repositories.root_path = git_worktrees.repository_root),
                   1
                 ),
                 repository_root, worktree_path, branch, head_commit, remote_url,
                 created_at, updated_at
          FROM git_worktrees
        `)
        connection.exec('DROP TABLE git_worktrees')
        connection.exec('ALTER TABLE git_worktrees_scoped RENAME TO git_worktrees')
      })()
    } finally {
      connection.pragma('foreign_keys = ON')
    }
  }

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

  // Tracked files predating the event trail get the same synthesized creation
  // event, with the same idempotent guard.
  connection.exec(`
    INSERT INTO user_file_events (user_file_id, action, created_at)
    SELECT user_files.id, 'created', user_files.created_at
    FROM user_files
    WHERE NOT EXISTS (
      SELECT 1 FROM user_file_events
      WHERE user_file_events.user_file_id = user_files.id
        AND user_file_events.action = 'created'
    );
  `)

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
  const listJobsStatement = connection.prepare(
    'SELECT * FROM ai_jobs ORDER BY created_at ASC, rowid ASC'
  )
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

  const USER_FILE_ACTIVITY_FIELDS = [
    'path', 'objective', 'requirements', 'decisions', 'relevant_files', 'important_context'
  ]

  // Header lines recognized in the leading comment block of tracked files.
  const USER_FILE_HEADER_FIELDS = [
    ['objective', 'Objective'],
    ['requirements', 'Requirements'],
    ['decisions', 'Decisions'],
    ['relevant_files', 'Relevant Files'],
    ['important_context', 'Important Context']
  ]

  /**
   * Parse the tracking header from a file's leading comment block.
   *
   * Recognized lines are "# Objective: ..." (Python, YAML, shell, Markdown)
   * or "// Objective: ..." (JavaScript). Only the leading comment block is
   * read, so the convention mentioned later in a file - inside a test
   * fixture, for example - is never mistaken for the file's own header.
   * The first value per field wins.
   */
  function parseUserFileHeaders(content) {
    const headers = {}
    for (const line of String(content ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith('#!')) continue
      const comment = /^(?:#|\/\/)\s?(.*)$/.exec(trimmed)
      if (!comment) break
      for (const [field, label] of USER_FILE_HEADER_FIELDS) {
        if (headers[field] !== undefined) continue
        const match = new RegExp(`^${label}:\\s*(.*)$`).exec(comment[1])
        if (match) headers[field] = match[1].trim()
      }
    }
    return headers
  }

  function hashUserFileContent(content) {
    return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
  }

  function toUserFileEvent(row) {
    if (!row) return null
    return {
      id: row.id,
      fileId: row.user_file_id,
      action: row.action,
      ...(row.field !== null ? { field: row.field } : {}),
      ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
      ...(row.new_value !== null ? { newValue: row.new_value } : {}),
      createdAt: row.created_at
    }
  }

  function readUserFileActivity(fileId, activityLimit = 50) {
    const requestedLimit = Number(activityLimit)
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(200, Math.trunc(requestedLimit))
      : 50
    return listUserFileEventsStatement.all(fileId, limit).map(toUserFileEvent)
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

    const listFoldersStatement = connection.prepare(`
      SELECT folders.*, repositories.name AS repository_name
      FROM folders
      LEFT JOIN repositories ON repositories.id = folders.repository_id
      ORDER BY folders.repository_id, folders.path COLLATE NOCASE
    `)
    const getFolderStatement = connection.prepare(`
      SELECT folders.*, repositories.name AS repository_name
      FROM folders
      LEFT JOIN repositories ON repositories.id = folders.repository_id
      WHERE folders.id = ?
    `)
    const getFolderByPathStatement = connection.prepare(
      'SELECT * FROM folders WHERE repository_id = ? AND path = ?'
    )
    const insertFolderStatement = connection.prepare(
      'INSERT INTO folders (repository_id, path, objective, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    const updateFolderStatement = connection.prepare(
      'UPDATE folders SET path = ?, objective = ?, updated_at = ? WHERE id = ?'
    )
    const deleteFolderStatement = connection.prepare('DELETE FROM folders WHERE id = ?')

    const listGitWorktreesStatement = connection.prepare(`
      SELECT git_worktrees.*, repositories.name AS repository_name
      FROM git_worktrees
      LEFT JOIN repositories ON repositories.id = git_worktrees.repository_id
      ORDER BY git_worktrees.repository_root, git_worktrees.worktree_path
    `)
    const upsertGitWorktreeStatement = connection.prepare(
      `INSERT INTO git_worktrees (
         repository_id, repository_root, worktree_path, branch, head_commit, remote_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worktree_path) DO UPDATE SET
         repository_id = excluded.repository_id,
         repository_root = excluded.repository_root,
         branch = excluded.branch,
         head_commit = excluded.head_commit,
         remote_url = excluded.remote_url,
         updated_at = excluded.updated_at`
    )
    const deleteGitWorktreeStatement = connection.prepare(
      'DELETE FROM git_worktrees WHERE worktree_path = ?'
    )
    const listRepositoriesStatement = connection.prepare(`
      SELECT repositories.*,
             (SELECT COUNT(*) FROM user_files WHERE user_files.repository_id = repositories.id) AS file_count,
             (SELECT COUNT(*) FROM folders WHERE folders.repository_id = repositories.id) AS folder_count,
             (SELECT COUNT(*) FROM git_worktrees WHERE git_worktrees.repository_id = repositories.id) AS worktree_count
      FROM repositories
      ORDER BY repositories.id
    `)
    const getRepositoryStatement = connection.prepare('SELECT * FROM repositories WHERE id = ?')
    const getRepositoryByRootStatement = connection.prepare(
      'SELECT * FROM repositories WHERE root_path = ?'
    )
    const getRepositoryByNameStatement = connection.prepare(
      'SELECT * FROM repositories WHERE name = ?'
    )
    const insertRepositoryStatement = connection.prepare(
      'INSERT INTO repositories (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    const listToolsStatement = connection.prepare('SELECT * FROM tools ORDER BY name')
    const upsertToolStatement = connection.prepare(
      `INSERT INTO tools (name, command, version, available, success_count, failure_count, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         command = excluded.command,
         version = excluded.version,
         available = excluded.available,
         success_count = tools.success_count + excluded.success_count,
         failure_count = tools.failure_count + excluded.failure_count,
         checked_at = excluded.checked_at`
    )

    const listEnvironmentsStatement = connection.prepare('SELECT * FROM environments ORDER BY name')
    const upsertEnvironmentStatement = connection.prepare(
      `INSERT INTO environments (name, value, source, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = excluded.value,
         source = excluded.source,
         checked_at = excluded.checked_at`
    )

    const listUserFilesStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      ORDER BY user_files.repository_id, user_files.path COLLATE NOCASE
    `)
    const getUserFileStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      WHERE user_files.id = ?
    `)
    const getUserFileByPathStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      WHERE user_files.repository_id = ? AND user_files.path = ?
    `)
    const insertUserFileStatement = connection.prepare(
      'INSERT INTO user_files (repository_id, path, objective, requirements, decisions, relevant_files, important_context, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const listUserFilesForRepositoryStatement = connection.prepare(
      'SELECT * FROM user_files WHERE repository_id = ?'
    )
    const listFoldersForRepositoryStatement = connection.prepare(
      'SELECT path FROM folders WHERE repository_id = ?'
    )
    const updateUserFileStatement = connection.prepare(
      'UPDATE user_files SET path = ?, objective = ?, requirements = ?, decisions = ?, relevant_files = ?, important_context = ?, updated_at = ? WHERE id = ?'
    )
    const updateUserFileHashStatement = connection.prepare(
      'UPDATE user_files SET content_hash = ? WHERE id = ?'
    )
    const deleteUserFileStatement = connection.prepare('DELETE FROM user_files WHERE id = ?')
    const listUserFileEventsStatement = connection.prepare(`
      SELECT id, user_file_id, action, field, old_value, new_value, created_at
      FROM user_file_events
      WHERE user_file_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    const insertUserFileEventStatement = connection.prepare(`
      INSERT INTO user_file_events (user_file_id, action, field, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    function toFolder(row) {
      if (!row) return null
      return {
        id: row.id,
        repositoryId: row.repository_id,
        ...(row.repository_name !== undefined ? { repository: row.repository_name } : {}),
        path: row.path,
        objective: row.objective,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    }

    function toUserFile(row) {
      if (!row) return null
      return {
        id: row.id,
        repositoryId: row.repository_id,
        ...(row.repository_name !== undefined ? { repository: row.repository_name } : {}),
        path: row.path,
        objective: row.objective,
        requirements: row.requirements,
        decisions: row.decisions,
        relevant_files: row.relevant_files,
        important_context: row.important_context,
        contentHash: row.content_hash ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    }

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
    listJobs() {
      return listJobsStatement.all().map(toJob)
    },
    getJob(id) {
      return toJob(getJobStatement.get(id))
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
    listUserFiles({ search = '', repositoryId } = {}) {
      const conditions = []
      const values = []
      if (repositoryId !== undefined) {
        conditions.push('user_files.repository_id = ?')
        values.push(repositoryId)
      }
      if (search) {
        const like = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`
        conditions.push(
          '(user_files.path LIKE ? ESCAPE \'\\\' OR user_files.objective LIKE ? ESCAPE \'\\\' OR user_files.requirements LIKE ? ESCAPE \'\\\' OR user_files.decisions LIKE ? ESCAPE \'\\\' OR user_files.relevant_files LIKE ? ESCAPE \'\\\' OR user_files.important_context LIKE ? ESCAPE \'\\\')'
        )
        values.push(...Array(6).fill(like))
      }
      if (conditions.length === 0) return listUserFilesStatement.all().map(toUserFile)
      const rows = connection.prepare(`
        SELECT user_files.*, repositories.name AS repository_name
        FROM user_files
        LEFT JOIN repositories ON repositories.id = user_files.repository_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY user_files.repository_id, user_files.path COLLATE NOCASE
      `).all(...values)
      return rows.map(toUserFile)
    },
    getUserFile(id) {
      return toUserFile(getUserFileStatement.get(id))
    },
    getUserFileByPath(path, repositoryId = 1) {
      return toUserFile(getUserFileByPathStatement.get(repositoryId, path))
    },
    createUserFile({
      path,
      objective = '',
      requirements = '',
      decisions = '',
      relevant_files = '',
      important_context = '',
      repositoryId = 1
    }) {
      const now = new Date().toISOString()
      const result = insertUserFileStatement.run(
        repositoryId, path, objective, requirements, decisions, relevant_files, important_context,
        null, now, now
      )
      const id = Number(result.lastInsertRowid)
      insertUserFileEventStatement.run(id, 'created', null, null, null, now)
      return toUserFile(getUserFileStatement.get(id))
    },
    updateUserFile(id, changes) {
      const current = toUserFile(getUserFileStatement.get(id))
      if (!current) return null
      const next = {
        path: changes.path ?? current.path,
        objective: changes.objective ?? current.objective,
        requirements: changes.requirements ?? current.requirements,
        decisions: changes.decisions ?? current.decisions,
        relevant_files: changes.relevant_files ?? current.relevant_files,
        important_context: changes.important_context ?? current.important_context
      }
      const changedFields = USER_FILE_ACTIVITY_FIELDS.filter(
        (field) => current[field] !== next[field]
      )
      if (changedFields.length === 0) return current
      const now = new Date().toISOString()
      updateUserFileStatement.run(
        next.path, next.objective, next.requirements, next.decisions, next.relevant_files,
        next.important_context, now, id
      )
      for (const field of changedFields) {
        insertUserFileEventStatement.run(id, 'updated', field, current[field], next[field], now)
      }
      return toUserFile(getUserFileStatement.get(id))
    },
    deleteUserFile(id) {
      return deleteUserFileStatement.run(id).changes > 0
    },
    getUserFileDetail(id, { activityLimit = 50 } = {}) {
      const file = toUserFile(getUserFileStatement.get(id))
      if (!file) return null
      return { ...file, activity: readUserFileActivity(id, activityLimit) }
    },
    /**
     * Sync tracked files with their header comments.
     *
     * Each entry carries { path, content }. A content hash scopes the work:
     * files whose content is unchanged are skipped entirely, and a changed
     * file only writes the fields whose header value differs. A missing
     * header line stops syncing that field instead of erasing the last
     * value. Header syncs record "synced" events; manual updates record
     * "updated" events, so history is preserved either way.
     */
    scanUserFiles(files, { repositoryId = 1 } = {}) {
      const now = new Date().toISOString()
      const existing = new Map(
        listUserFilesForRepositoryStatement.all(repositoryId).map((row) => [row.path, row])
      )
      let inserted = 0
      let synced = 0
      let refreshed = 0
      let skipped = 0
      for (const { path, content } of files) {
        const hash = hashUserFileContent(content)
        const current = existing.get(path)
        if (!current) {
          const headers = parseUserFileHeaders(content)
          const result = insertUserFileStatement.run(
            repositoryId,
            path,
            headers.objective ?? '',
            headers.requirements ?? '',
            headers.decisions ?? '',
            headers.relevant_files ?? '',
            headers.important_context ?? '',
            hash,
            now,
            now
          )
          const id = Number(result.lastInsertRowid)
          insertUserFileEventStatement.run(id, 'created', null, null, null, now)
          for (const [field] of USER_FILE_HEADER_FIELDS) {
            const value = headers[field] ?? ''
            if (value) insertUserFileEventStatement.run(id, 'synced', field, '', value, now)
          }
          inserted += 1
          continue
        }

        if (current.content_hash === hash) {
          skipped += 1
          continue
        }

        const headers = parseUserFileHeaders(content)
        const next = {}
        const changedFields = []
        for (const [field] of USER_FILE_HEADER_FIELDS) {
          next[field] = headers[field] !== undefined ? headers[field] : current[field]
          if (next[field] !== current[field]) changedFields.push(field)
        }
        updateUserFileHashStatement.run(hash, current.id)
        if (changedFields.length === 0) {
          refreshed += 1
          continue
        }
        updateUserFileStatement.run(
          current.path, next.objective, next.requirements, next.decisions,
          next.relevant_files, next.important_context, now, current.id
        )
        for (const field of changedFields) {
          insertUserFileEventStatement.run(
            current.id, 'synced', field, current[field], next[field], now
          )
        }
        synced += 1
      }
      return { inserted, synced, refreshed, skipped, total: files.length }
    },
    listFolders() {
      return listFoldersStatement.all().map(toFolder)
    },
    getFolder(id) {
      return toFolder(getFolderStatement.get(id))
    },
    getFolderByPath(path, repositoryId = 1) {
      return toFolder(getFolderByPathStatement.get(repositoryId, path))
    },
    createFolder({ path, objective = '', repositoryId = 1 }) {
      const now = new Date().toISOString()
      const result = insertFolderStatement.run(repositoryId, path, objective, now, now)
      return this.getFolder(Number(result.lastInsertRowid))
    },
    updateFolder(id, changes) {
      const current = this.getFolder(id)
      if (!current) return null
      const next = {
        path: changes.path ?? current.path,
        objective: changes.objective ?? current.objective
      }
      const now = new Date().toISOString()
      updateFolderStatement.run(next.path, next.objective, now, id)
      return this.getFolder(id)
    },
    deleteFolder(id) {
      return deleteFolderStatement.run(id).changes > 0
    },
    scanFolders(paths, { repositoryId = 1 } = {}) {
      const now = new Date().toISOString()
      const existing = new Set(
        listFoldersForRepositoryStatement.all(repositoryId).map((row) => row.path)
      )
      let inserted = 0
      let updated = 0
      for (const path of paths) {
        if (existing.has(path)) {
          updated += 1
        } else {
          insertFolderStatement.run(repositoryId, path, '', now, now)
          inserted += 1
          existing.add(path)
        }
      }
      return { inserted, updated, total: paths.length }
    },
    listGitWorktrees() {
      return listGitWorktreesStatement.all().map((row) => ({
        id: row.id,
        repositoryId: row.repository_id,
        ...(row.repository_name !== undefined ? { repository: row.repository_name } : {}),
        repositoryRoot: row.repository_root,
        worktreePath: row.worktree_path,
        branch: row.branch,
        headCommit: row.head_commit,
        remoteUrl: row.remote_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    },
    scanGitWorktrees(entries) {
      const now = new Date().toISOString()
      // Each entry's repository root resolves to its registered repository,
      // registering unknown roots on first sight so worktree rows are always
      // associated with a real repository.
      const repositoryIds = new Map()
      for (const entry of entries) {
        let repositoryId = repositoryIds.get(entry.repositoryRoot)
        if (repositoryId === undefined) {
          repositoryId = this.ensureRepository(entry.repositoryRoot).repository.id
          repositoryIds.set(entry.repositoryRoot, repositoryId)
        }
        upsertGitWorktreeStatement.run(
          repositoryId,
          entry.repositoryRoot,
          entry.worktreePath,
          entry.branch || '',
          entry.headCommit || '',
          entry.remoteUrl || '',
          now,
          now
        )
      }
      return { total: entries.length }
    },
    deleteGitWorktree(worktreePath) {
      return deleteGitWorktreeStatement.run(worktreePath).changes > 0
    },
    listRepositories() {
      return listRepositoriesStatement.all().map(toRepository)
    },
    getRepository(id) {
      return toRepository(getRepositoryStatement.get(id))
    },
    getRepositoryByRoot(rootPath) {
      return toRepository(getRepositoryByRootStatement.get(resolve(String(rootPath))))
    },
    getRepositoryByName(name) {
      return toRepository(getRepositoryByNameStatement.get(String(name)))
    },
    /**
     * Resolve a repository root to its registered row, registering it on
     * first sight. The name defaults to the root's basename and takes a
     * numeric suffix when another repository already uses that name. An
     * explicit name that is already taken still throws, so callers validate
     * user-provided names before reaching here.
     */
    ensureRepository(rootPath, { name } = {}) {
      const root = resolve(String(rootPath))
      const existing = toRepository(getRepositoryByRootStatement.get(root))
      if (existing) return { repository: existing, created: false }
      const baseName = String(name ?? basename(root) ?? 'repository').trim() || 'repository'
      let finalName = baseName
      let suffix = 2
      while (getRepositoryByNameStatement.get(finalName)) {
        if (name !== undefined) break
        finalName = `${baseName}-${suffix}`
        suffix += 1
      }
      const now = new Date().toISOString()
      insertRepositoryStatement.run(finalName, root, now, now)
      return { repository: toRepository(getRepositoryByRootStatement.get(root)), created: true }
    },
    listTools() {
      return listToolsStatement.all().map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        version: row.version,
        available: Boolean(row.available),
        successCount: row.success_count,
        failureCount: row.failure_count,
        checkedAt: row.checked_at
      }))
    },
    scanTools(entries) {
      const now = new Date().toISOString()
      for (const entry of entries) {
        const available = entry.available ? 1 : 0
        upsertToolStatement.run(
          entry.name,
          entry.command,
          entry.version || '',
          available,
          available,
          available ? 0 : 1,
          now
        )
      }
      return { total: entries.length }
    },
    listEnvironments() {
      return listEnvironmentsStatement.all().map((row) => ({
        id: row.id,
        name: row.name,
        value: row.value,
        source: row.source,
        checkedAt: row.checked_at
      }))
    },
    scanEnvironments(entries) {
      const now = new Date().toISOString()
      for (const entry of entries) {
        upsertEnvironmentStatement.run(entry.name, entry.value || '', entry.source || '', now)
      }
      return { total: entries.length }
    },
    listAiSessions() {
      return connection.prepare('SELECT * FROM ai_sessions ORDER BY updated_at DESC').all().map((row) => ({
        id: row.id,
        taskId: row.task_id,
        title: row.title,
        summary: row.summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    },
    getAiSession(id) {
      const session = connection.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id)
      if (!session) return null
      const messages = connection.prepare(
        'SELECT id, role, content, created_at FROM ai_messages WHERE session_id = ? ORDER BY id ASC'
      ).all(id).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at
      }))
      return {
        id: session.id,
        taskId: session.task_id,
        title: session.title,
        summary: session.summary,
        messages,
        createdAt: session.created_at,
        updatedAt: session.updated_at
      }
    },
    createAiSession({ title = '', taskId = null } = {}) {
      const now = new Date().toISOString()
      const result = connection.prepare(
        'INSERT INTO ai_sessions (task_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(taskId, title, '', now, now)
      return this.getAiSession(Number(result.lastInsertRowid))
    },
    addAiMessage(sessionId, { role, content }) {
      const session = connection.prepare('SELECT id FROM ai_sessions WHERE id = ?').get(sessionId)
      if (!session) return null
      const now = new Date().toISOString()
      connection.prepare(
        'INSERT INTO ai_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, role, content, now)
      connection.prepare('UPDATE ai_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
      // Keep only the most recent 100 messages per session.
      connection.prepare(`
        DELETE FROM ai_messages
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM ai_messages WHERE session_id = ? ORDER BY id DESC LIMIT 100
        )
      `).run(sessionId, sessionId)
      return this.getAiSession(sessionId)
    },
    compactAiSession(sessionId, summary) {
      const session = connection.prepare('SELECT id FROM ai_sessions WHERE id = ?').get(sessionId)
      if (!session) return null
      const now = new Date().toISOString()
      connection.prepare('UPDATE ai_sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now, sessionId)
      // Remove older messages, keeping the most recent 10.
      connection.prepare(`
        DELETE FROM ai_messages
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM ai_messages WHERE session_id = ? ORDER BY id DESC LIMIT 10
        )
      `).run(sessionId, sessionId)
      return this.getAiSession(sessionId)
    },
    deleteAiSession(id) {
      return connection.prepare('DELETE FROM ai_sessions WHERE id = ?').run(id).changes > 0
    },
    listPromptTemplates() {
      return connection.prepare('SELECT * FROM prompt_templates ORDER BY name').all().map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        systemPrompt: row.system_prompt,
        userTemplate: row.user_template,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    },
    getPromptTemplate(id) {
      const row = connection.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(id)
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        systemPrompt: row.system_prompt,
        userTemplate: row.user_template,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    },
    createPromptTemplate({ name, description = '', systemPrompt = '', userTemplate = '' }) {
      const now = new Date().toISOString()
      const result = connection.prepare(
        'INSERT INTO prompt_templates (name, description, system_prompt, user_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, description, systemPrompt, userTemplate, now, now)
      return this.getPromptTemplate(Number(result.lastInsertRowid))
    },
    updatePromptTemplate(id, changes) {
      const current = this.getPromptTemplate(id)
      if (!current) return null
      const next = {
        name: changes.name ?? current.name,
        description: changes.description ?? current.description,
        systemPrompt: changes.systemPrompt ?? changes.system_prompt ?? current.systemPrompt,
        userTemplate: changes.userTemplate ?? changes.user_template ?? current.userTemplate
      }
      const now = new Date().toISOString()
      connection.prepare(
        'UPDATE prompt_templates SET name = ?, description = ?, system_prompt = ?, user_template = ?, updated_at = ? WHERE id = ?'
      ).run(next.name, next.description, next.systemPrompt, next.userTemplate, now, id)
      return this.getPromptTemplate(id)
    },
    deletePromptTemplate(id) {
      return connection.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id).changes > 0
    },
    close() {
      connection.close()
    }
  }
}

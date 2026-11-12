// Objective: Create the workspace database schema and upgrade legacy shapes in place.
// Requirements: Stay idempotent so an interrupted upgrade can be retried; preserve row ids and event trails; register a primary repository before any association backfill; link activity events to tool runs without rebuilding their tables.
// Decisions: One cohesive sequence rather than per-domain migrations, because the association rebuilds must land after the repositories registry exists; foreign keys toggle outside transactions per the documented SQLite rebuild procedure; a legacy database opened without a root falls back to the process working directory so backfilled rows never dangle; run_id lands as a nullable ALTER because SQLite allows a nullable REFERENCES column and the trails survive untouched.
// Relevant Files: apps/api/src/db/migrations.js, apps/api/src/database.js, apps/api/src/db/tasks.js, apps/api/src/db/toolRuns.js
// Important Context: User file. Runs on every createDatabase call before any store builds its statements.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { basename, resolve } from 'node:path'
import { TASK_COLUMNS } from './tasks.js'

export function runMigrations(connection, { rootDir } = {}) {
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
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      integration_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      status_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      uri TEXT NOT NULL CHECK(length(trim(uri)) BETWEEN 1 AND 500),
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      is_template INTEGER NOT NULL DEFAULT 0 CHECK(is_template IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(server_id, uri)
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_resources_server
      ON mcp_resources(server_id, last_seen_at DESC, id DESC);
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
      missing_at TEXT,
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

    CREATE TABLE IF NOT EXISTS tool_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('api', 'scan')),
      label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_runs_created
      ON tool_runs(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS task_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      task_type TEXT NOT NULL DEFAULT 'chore',
      project TEXT NOT NULL DEFAULT 'workspace',
      rationale TEXT NOT NULL DEFAULT '',
      origin_job_id TEXT NOT NULL DEFAULT '',
      origin_agent_run_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK(status IN ('proposed', 'approved', 'rejected', 'rolled_back')),
      created_task_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_proposals_status
      ON task_proposals(status, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'draft'
        CHECK(state IN ('draft', 'planning', 'dispatching', 'running', 'reviewing', 'completed', 'failed', 'cancelled')),
      primary_agent_id TEXT,
      reviewer_agent_id TEXT,
      model_plan TEXT NOT NULL DEFAULT '{}',
      budget TEXT NOT NULL DEFAULT '{}',
      plan TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      checkpoint TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_task
      ON agent_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_state
      ON agent_runs(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_run_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agent_agents(id) ON DELETE SET NULL,
      model TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      calls INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_usage_run
      ON agent_run_usage(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_run_usage_agent
      ON agent_run_usage(run_id, agent_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS agent_agents (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('parent', 'reviewer', 'worker')),
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      backend TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'idle'
        CHECK(state IN ('idle', 'ready', 'running', 'waiting', 'done', 'failed', 'cancelled')),
      token_hash TEXT NOT NULL,
      lease_until INTEGER,
      heartbeat_at INTEGER,
      prompt_cache_key TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(run_id, name),
      UNIQUE(token_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_agents_run
      ON agent_agents(run_id, role, name);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      from_agent_id TEXT NOT NULL REFERENCES agent_agents(id) ON DELETE CASCADE,
      to_agent_id TEXT NOT NULL REFERENCES agent_agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
        CHECK(kind IN ('assign', 'progress', 'question', 'result', 'error', 'cancel', 'verdict', 'handoff')),
      correlation_id TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued', 'leased', 'delivered', 'acked', 'completed', 'failed', 'expired', 'dead_letter')),
      payload TEXT NOT NULL DEFAULT '{}',
      artifact_refs TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      result TEXT,
      error TEXT,
      lease_owner TEXT,
      lease_until INTEGER,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      acked_at INTEGER,
      expires_at INTEGER,
      UNIQUE(run_id, idempotency_key),
      UNIQUE(run_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_run
      ON agent_messages(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
      ON agent_messages(to_agent_id, state, seq);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_lease
      ON agent_messages(state, lease_until);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_expiry
      ON agent_messages(run_id, state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_requeue
      ON agent_messages(run_id, state, lease_until);

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agent_agents(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_events_run
      ON agent_events(run_id, created_at ASC, id ASC);

    CREATE TABLE IF NOT EXISTS agent_task_ops (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agent_agents(id) ON DELETE SET NULL,
      op_id TEXT NOT NULL,
      op TEXT NOT NULL,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, op_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_task_ops_run
      ON agent_task_ops(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_task_ops_creates
      ON agent_task_ops(run_id, op, status);

    CREATE TABLE IF NOT EXISTS agent_model_evals (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      config_key TEXT NOT NULL,
      eval_version TEXT NOT NULL,
      score REAL NOT NULL,
      passed INTEGER NOT NULL DEFAULT 0 CHECK(passed IN (0, 1)),
      details TEXT NOT NULL DEFAULT '{}',
      evaluated_at INTEGER NOT NULL,
      UNIQUE(model, config_key, eval_version)
    );

    CREATE TABLE IF NOT EXISTS agent_scripts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      intent TEXT NOT NULL,
      input_schema TEXT NOT NULL DEFAULT '{}',
      output_schema TEXT NOT NULL DEFAULT '{}',
      command TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 60000,
      cost_class TEXT NOT NULL DEFAULT 'free',
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_scripts_intent
      ON agent_scripts(intent, version DESC);

    CREATE TABLE IF NOT EXISTS agent_artifacts (
      content_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      producer TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_artifacts_expiry
      ON agent_artifacts(expires_at) WHERE expires_at IS NOT NULL;
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
  // A tracked file that disappears from disk keeps its row and event trail;
  // missing_at records when the scan noticed, and a later scan clears it.
  if (!userFileColumns.has('missing_at')) {
    connection.exec('ALTER TABLE user_files ADD COLUMN missing_at TEXT')
  }

  // Provenance: link every activity event to the tool run that produced it.
  // The column is nullable so the ALTER preserves ids and trails; events that
  // predate run tracking keep run_id NULL.
  for (const tableName of ['task_events', 'user_file_events']) {
    const columns = new Set(
      connection.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name)
    )
    if (!columns.has('run_id')) {
      connection.exec(
        `ALTER TABLE ${tableName} ADD COLUMN run_id INTEGER REFERENCES tool_runs(id)`
      )
    }
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
            missing_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(repository_id, path)
          );
        `)
        connection.exec(`
          INSERT INTO user_files_scoped (
            id, repository_id, path, objective, requirements, decisions,
            relevant_files, important_context, content_hash, missing_at, created_at, updated_at
          )
          SELECT id, 1, path, objective, requirements, decisions,
                 relevant_files, important_context, content_hash, missing_at, created_at, updated_at
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
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_parent
      ON tasks(parent_task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent_run
      ON tasks(agent_run_id, created_at DESC);
  `)
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
  if (!jobColumns.has('agent_run_id')) {
    connection.exec('ALTER TABLE ai_jobs ADD COLUMN agent_run_id TEXT')
  }
  if (!jobColumns.has('agent_id')) {
    connection.exec('ALTER TABLE ai_jobs ADD COLUMN agent_id TEXT')
  }
  const proposalColumns = new Set(
    connection.prepare('PRAGMA table_info(task_proposals)').all().map((column) => column.name)
  )
  if (!proposalColumns.has('origin_agent_run_id')) {
    connection.exec(
      "ALTER TABLE task_proposals ADD COLUMN origin_agent_run_id TEXT NOT NULL DEFAULT ''"
    )
  }
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_task
      ON ai_jobs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_agent_run
      ON ai_jobs(agent_run_id, created_at DESC);
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
}

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { createDatabase } from '../src/database.js'

let directory

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-migrations-'))
})

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

// Recreates the shape of a pre-tracking database: tasks and task_events before
// the structured planning columns, user files with the retired work_* columns,
// folders with important_context, tools without outcome counters, ai_jobs
// before retry_after/backend/task_id, and the legacy ai_budget daily counters.
function createLegacyDatabase(databasePath) {
  const connection = new Database(databasePath)
  connection.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE ai_jobs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued',
      model TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT,
      error TEXT,
      status INTEGER
    );
    CREATE TABLE ai_budget (
      model TEXT NOT NULL,
      day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, day)
    );
    CREATE TABLE user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      objective TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      objective TEXT NOT NULL DEFAULT '',
      important_context TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    );
  `)
  connection.prepare(
    'INSERT INTO tasks (title, description, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('Legacy done task', 'Done before the upgrade', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  connection.prepare(
    'INSERT INTO tasks (title, description, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('Legacy open task', 'Still open after the upgrade', 0, '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
  connection.prepare(
    'INSERT INTO task_events (task_id, action, created_at) VALUES (?, ?, ?)'
  ).run(1, 'created', '2026-01-01T00:00:00.000Z')
  connection.prepare(
    'INSERT INTO ai_jobs (id, state, phase, model, title, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('legacy-job', 'done', 'finished', 'legacy-model', 'Legacy job', 1000)
  connection.prepare(
    'INSERT INTO ai_budget (model, day, used) VALUES (?, ?, ?)'
  ).run('legacy-model', '2026-01-15', 3)
  connection.prepare(`
    INSERT INTO user_files (
      path, objective, requirements, decisions, relevant_files, important_context,
      work_completed, work_active, work_blocked, next_move, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'docs/legacy.md', 'Legacy objective', 'Legacy requirements', 'Legacy decisions', 'docs/*',
    'Legacy context', 'Legacy work', 'Legacy active', 'Legacy blocked', 'Legacy move',
    '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z'
  )
  connection.prepare(
    'INSERT INTO folders (path, objective, important_context, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('legacy-folder', 'Legacy folder objective', 'Legacy folder context', '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z')
  connection.prepare(
    'INSERT INTO tools (name, command, version, available, checked_at) VALUES (?, ?, ?, ?, ?)'
  ).run('git', 'git', 'git version 2.39.0', 1, '2026-01-07T00:00:00.000Z')
  connection.close()
}

function tableColumns(connection, table) {
  return connection.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
}

test('legacy tracking databases are migrated without losing data', () => {
  const databasePath = join(directory, 'legacy-tracking.sqlite')
  createLegacyDatabase(databasePath)

  const migrated = createDatabase(databasePath)

  // Task completion state carries over and the synthesized planning columns default to empty.
  assert.equal(migrated.getTask(1).status, 'done')
  assert.equal(migrated.getTask(1).completed, true)
  assert.equal(migrated.getTask(2).status, 'todo')
  assert.equal(migrated.getTask(2).completed, false)
  for (const field of [
    'objectives', 'requirements', 'decisions', 'relevant_files', 'important_context',
    'work_completed', 'work_active', 'work_blocked', 'next_move', 'worktree_path'
  ]) {
    assert.equal(migrated.getTask(2)[field], '')
  }

  // User file and folder rows survive with their tracked fields intact.
  const file = migrated.getUserFileByPath('docs/legacy.md')
  assert.equal(file.objective, 'Legacy objective')
  assert.equal(file.requirements, 'Legacy requirements')
  assert.equal(file.decisions, 'Legacy decisions')
  assert.equal(file.relevant_files, 'docs/*')
  assert.equal(file.important_context, 'Legacy context')
  const folder = migrated.getFolderByPath('legacy-folder')
  assert.equal(folder.objective, 'Legacy folder objective')

  // Legacy user-file rows gain a creation event without losing fields.
  assert.equal(file.contentHash, null)
  const legacyFileActivity = migrated.getUserFileDetail(file.id).activity
  assert.equal(legacyFileActivity.length, 1)
  assert.equal(legacyFileActivity[0].action, 'created')
  assert.equal(legacyFileActivity[0].createdAt, '2026-01-05T00:00:00.000Z')

  // Tool rows survive and start with neutral outcome counters.
  const tools = migrated.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'git')
  assert.equal(tools[0].available, true)
  assert.equal(tools[0].version, 'git version 2.39.0')
  assert.equal(tools[0].successCount, 0)
  assert.equal(tools[0].failureCount, 0)

  // The pre-existing creation event is kept and the task without one gets a
  // single synthesized event, so history is neither lost nor duplicated.
  const doneActivity = migrated.getTaskDetail(1).activity
  assert.equal(doneActivity.length, 1)
  assert.equal(doneActivity[0].action, 'created')
  assert.equal(doneActivity[0].createdAt, '2026-01-01T00:00:00.000Z')
  const openActivity = migrated.getTaskDetail(2).activity
  assert.equal(openActivity.length, 1)
  assert.equal(openActivity[0].action, 'created')
  assert.equal(openActivity[0].createdAt, '2026-02-02T00:00:00.000Z')
  migrated.close()

  const inspection = new Database(databasePath, { readonly: true })
  const userFileColumns = tableColumns(inspection, 'user_files')
  for (const dropped of ['work_completed', 'work_active', 'work_blocked', 'next_move']) {
    assert.ok(!userFileColumns.includes(dropped), `user_files still has ${dropped}`)
  }
  for (const kept of ['objective', 'requirements', 'decisions', 'relevant_files', 'important_context']) {
    assert.ok(userFileColumns.includes(kept), `user_files lost ${kept}`)
  }
  assert.ok(userFileColumns.includes('content_hash'), 'user_files is missing content_hash')

  const folderColumns = tableColumns(inspection, 'folders')
  assert.ok(!folderColumns.includes('important_context'), 'folders still has important_context')
  assert.ok(folderColumns.includes('objective'))

  const toolColumns = tableColumns(inspection, 'tools')
  assert.ok(toolColumns.includes('success_count'))
  assert.ok(toolColumns.includes('failure_count'))

  const jobColumns = tableColumns(inspection, 'ai_jobs')
  for (const added of ['retry_after', 'backend', 'task_id']) {
    assert.ok(jobColumns.includes(added), `ai_jobs is missing ${added}`)
  }

  const tables = inspection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map((row) => row.name)
  for (const created of ['git_worktrees', 'environments', 'prompt_templates', 'ai_quota', 'user_file_events']) {
    assert.ok(tables.includes(created), `missing table ${created}`)
  }

  const quota = inspection.prepare(
    "SELECT policy, bucket, used FROM ai_quota WHERE model = 'legacy-model'"
  ).all()
  assert.equal(quota.length, 1)
  assert.equal(quota[0].policy, '0:requests:day:fixed')
  assert.equal(quota[0].bucket, Date.parse('2026-01-15T00:00:00.000Z'))
  assert.equal(quota[0].used, 3)
  const budget = inspection.prepare(
    "SELECT used FROM ai_budget WHERE model = 'legacy-model' AND day = '2026-01-15'"
  ).get()
  assert.equal(budget.used, 3)
  const job = inspection.prepare(
    "SELECT state, phase, model FROM ai_jobs WHERE id = 'legacy-job'"
  ).get()
  assert.equal(job.state, 'done')
  assert.equal(job.phase, 'finished')
  assert.equal(job.model, 'legacy-model')
  inspection.close()
})

test('reopening a migrated database is idempotent', () => {
  const databasePath = join(directory, 'legacy-idempotent.sqlite')
  createLegacyDatabase(databasePath)

  const first = createDatabase(databasePath)
  first.close()

  const second = createDatabase(databasePath)
  assert.equal(second.getTaskDetail(1).activity.length, 1)
  assert.equal(second.getTaskDetail(2).activity.length, 1)
  const legacyFile = second.getUserFileByPath('docs/legacy.md')
  assert.equal(second.getUserFileDetail(legacyFile.id).activity.length, 1)
  const tools = second.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].successCount, 0)
  assert.equal(tools[0].failureCount, 0)
  assert.equal(second.getUserFileByPath('docs/legacy.md').objective, 'Legacy objective')
  assert.equal(second.getFolderByPath('legacy-folder').objective, 'Legacy folder objective')
  second.close()

  const inspection = new Database(databasePath, { readonly: true })
  const quotaCount = inspection.prepare(
    "SELECT COUNT(*) AS count FROM ai_quota WHERE model = 'legacy-model'"
  ).get().count
  assert.equal(quotaCount, 1)
  const quota = inspection.prepare(
    "SELECT used FROM ai_quota WHERE model = 'legacy-model'"
  ).get()
  assert.equal(quota.used, 3)
  inspection.close()
})

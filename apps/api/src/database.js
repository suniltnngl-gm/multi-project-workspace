// Objective: Compose the workspace database from per-domain stores behind one public entry.
// Requirements: Keep the createDatabase signature and returned surface identical, so routes, scripts, and tests never know about the split; run migrations before any store builds its statements.
// Decisions: Each domain owns its statements, mappers, and methods in apps/api/src/db/; git worktrees take the repositories store so root resolution stays explicit; close stays here because it owns the connection.
// Relevant Files: apps/api/src/database.js, apps/api/src/db/migrations.js, apps/api/src/db/tasks.js, apps/api/src/db/repositories.js
// Important Context: User file. The composition entry for scripts/, the API, and the tests.
// Work State: Completed: Split into db/ domain modules as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from './db/migrations.js'
import { createTasksStore } from './db/tasks.js'
import { createAiJobsStore } from './db/aiJobs.js'
import { createAiQuotaStore } from './db/aiQuota.js'
import { createUserFilesStore } from './db/userFiles.js'
import { createFoldersStore } from './db/folders.js'
import { createRepositoriesStore } from './db/repositories.js'
import { createGitWorktreesStore } from './db/gitWorktrees.js'
import { createToolsStore } from './db/tools.js'
import { createEnvironmentsStore } from './db/environments.js'
import { createAiSessionsStore } from './db/aiSessions.js'
import { createPromptTemplatesStore } from './db/promptTemplates.js'

const defaultDatabasePath = fileURLToPath(new URL('../data/workspace.sqlite', import.meta.url))

export function createDatabase(
  databasePath = process.env.DATABASE_PATH || defaultDatabasePath,
  { rootDir } = {}
) {
  const resolvedPath = resolve(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  const connection = new Database(resolvedPath)
  connection.pragma('journal_mode = WAL')
  connection.pragma('foreign_keys = ON')
  runMigrations(connection, { rootDir })

  const repositories = createRepositoriesStore(connection)
  return {
    ...createTasksStore(connection),
    ...createAiJobsStore(connection),
    ...createAiQuotaStore(connection),
    ...createUserFilesStore(connection),
    ...createFoldersStore(connection),
    ...repositories,
    ...createGitWorktreesStore(connection, { repositories }),
    ...createToolsStore(connection),
    ...createEnvironmentsStore(connection),
    ...createAiSessionsStore(connection),
    ...createPromptTemplatesStore(connection),
    close() {
      connection.close()
    }
  }
}

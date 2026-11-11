// Objective: Own the registry of workspace roots that scopes every other tracking domain.
// Requirements: Unique names and root paths; reject nothing silently — taken names throw so callers validate user input first; auto-registration suffixes colliding names.
// Decisions: ensureRepository registers unknown roots on first sight so scans never fail on an unregistered root; roots are resolved to absolute paths.
// Relevant Files: apps/api/src/db/repositories.js, apps/api/src/db/gitWorktrees.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { basename, resolve } from 'node:path'

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

export function createRepositoriesStore(connection) {
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
  return {
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
  }
}

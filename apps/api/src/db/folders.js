// Objective: Own folder-level objectives scoped per repository.
// Requirements: Key folders by (repository_id, path); record activity through the file-events style of touched surfaces only.
// Decisions: listFoldersForRepositoryStatement lives here because scans reconcile per repository.
// Relevant Files: apps/api/src/db/folders.js, apps/api/src/workspaceScan.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createFoldersStore(connection) {
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
    const listFoldersForRepositoryStatement = connection.prepare(
      'SELECT path FROM folders WHERE repository_id = ?'
    )

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
  return {
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
  }
}

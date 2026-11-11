// Objective: Own Git worktree rows joined to their repository.
// Requirements: Worktree paths stay globally unique; rows always associate with a real repository row.
// Decisions: The store takes the repositories store so scans register unknown roots on first sight through ensureRepository rather than a bare this call.
// Relevant Files: apps/api/src/db/gitWorktrees.js, apps/api/src/db/repositories.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createGitWorktreesStore(connection, { repositories }) {
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
  return {
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
          repositoryId = repositories.ensureRepository(entry.repositoryRoot).repository.id
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
  }
}

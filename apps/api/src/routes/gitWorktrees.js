// Objective: Own the Git worktree routes and refresh the worktree rows after task worktree changes.
// Requirements: Worktree rows always associate with a registered repository; scans read the current Git state verbatim.
// Decisions: refreshGitWorktreeRows takes the database explicitly so the tasks group can reuse it without sharing a closure.
// Relevant Files: apps/api/src/routes/gitWorktrees.js, apps/api/src/taskWorktrees.js, apps/api/src/routes/tasks.js
// Important Context: User file. Route group for /api/git-worktrees.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { execFileSync } from 'node:child_process'
import { parseWorktreePorcelain } from '../taskWorktrees.js'

export async function refreshGitWorktreeRows(database, worktrees) {
    const remoteUrl = (() => {
      try {
        return execFileSync(
          'git',
          ['-C', worktrees.repoRoot, 'remote', 'get-url', 'origin'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()
      } catch {
        return ''
      }
    })()
    const entries = (await worktrees.listEntries()).map((entry) => ({ ...entry, remoteUrl }))
    database.scanGitWorktrees(entries)
    return entries
}

export function createGitWorktreesRouter({ database }) {
  const router = Router()

  router.get('/api/git-worktrees', (_request, response) => {
    response.json(database.listGitWorktrees())
  })

  router.post('/api/git-worktrees/scan', async (_request, response) => {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      const remoteUrl = (() => {
        try {
          return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
            encoding: 'utf8'
          }).trim()
        } catch {
          return ''
        }
      })()
      const output = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8'
      })
      const entries = parseWorktreePorcelain(output, root)
      for (const entry of entries) {
        entry.remoteUrl = remoteUrl
      }
      const result = database.scanGitWorktrees(entries)
      response.json({ ...result, entries })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan Git worktrees.' })
    }
  })

  return router
}

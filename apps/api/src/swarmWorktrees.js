import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function resolveGitRepoRoot(startDir) {
  if (!startDir || !existsSync(startDir)) return null
  try {
    return runGit(startDir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

export function provisionWorkerWorktree({ repoRoot, runId, agentName }) {
  const root = resolveGitRepoRoot(repoRoot)
  if (!root) return null

  const shortRun = String(runId ?? 'run').replace(/^run_/, '').slice(0, 8)
  const safeAgent = String(agentName ?? 'worker').replace(/[^a-zA-Z0-9_-]/g, '-')
  const worktreesDir = join(root, '.worktrees')
  mkdirSync(worktreesDir, { recursive: true })

  const worktreePath = resolve(worktreesDir, `swarm-${shortRun}-${safeAgent}`)
  const branch = `swarm/${shortRun}/${safeAgent}`

  if (!existsSync(worktreePath)) {
    runGit(root, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
  }

  const rootEnv = join(root, '.env')
  const worktreeEnv = join(worktreePath, '.env')
  if (existsSync(rootEnv) && !existsSync(worktreeEnv)) {
    try {
      symlinkSync(rootEnv, worktreeEnv)
    } catch {
      copyFileSync(rootEnv, worktreeEnv)
    }
  }

  return {
    repoRoot: root,
    worktreePath,
    branch,
    dbPath: join(worktreePath, '.swarm-tmp.sqlite')
  }
}

export function collectWorktreeDiff(worktreePath, { maxChars = 6000 } = {}) {
  if (!worktreePath || !existsSync(worktreePath)) return ''
  try {
    const status = runGit(worktreePath, ['status', '--short'])
    const diff = runGit(worktreePath, ['diff', 'HEAD'])
    const combined = [status ? `Status:\n${status}` : '', diff ? `Diff:\n${diff}` : '']
      .filter(Boolean)
      .join('\n\n')
    if (combined.length <= maxChars) return combined
    return `${combined.slice(0, maxChars)}\n... [truncated]`
  } catch {
    return ''
  }
}

export function cleanupRunWorktrees(worktrees = []) {
  for (const entry of worktrees) {
    if (!entry?.repoRoot || !entry?.worktreePath) continue
    try {
      if (existsSync(entry.worktreePath)) {
        runGit(entry.repoRoot, ['worktree', 'remove', '--force', entry.worktreePath])
      }
    } catch {
      // Best-effort cleanup.
    }
    if (entry.branch) {
      try {
        runGit(entry.repoRoot, ['branch', '-D', entry.branch])
      } catch {
        // Branch may already be deleted or unmerged.
      }
    }
  }
}

export function mergeWorktreeBranches(worktrees = []) {
  const merged = []
  const conflicts = []
  for (const entry of worktrees) {
    if (!entry?.repoRoot || !entry?.worktreePath || !entry?.branch) continue
    try {
      const dirty = runGit(entry.worktreePath, ['status', '--porcelain'])
      if (dirty) {
        runGit(entry.worktreePath, ['add', '-A'])
        runGit(entry.worktreePath, ['commit', '-m', `chore(swarm): ${entry.branch}`])
      }
      const ahead = Number(runGit(entry.repoRoot, ['rev-list', '--count', `HEAD..${entry.branch}`]) || 0)
      if (ahead > 0) {
        try {
          runGit(entry.repoRoot, ['merge', '--no-edit', entry.branch])
          merged.push(entry.branch)
        } catch (err) {
          try {
            runGit(entry.repoRoot, ['merge', '--abort'])
          } catch {
            // Ignore abort failure.
          }
          conflicts.push({ branch: entry.branch, error: err?.message || 'merge conflict' })
        }
      }
    } catch (err) {
      conflicts.push({ branch: entry.branch, error: err?.message || 'worktree merge failed' })
    }
  }
  return { merged, conflicts }
}

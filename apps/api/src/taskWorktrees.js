// Objective: Manage task-scoped Git worktrees so task execution is isolated and cleanable.
// Requirements: Worktrees live outside the main checkout, every Git call is bounded and shell-free, and lifecycle actions are explicit.
// Decisions: Location convention is parent-of-repo/repo-name-worktrees/task-id-slug with branch task/id-slug, overridable via WORKSPACE_TASK_WORKTREE_ROOT; porcelain parsing is shared with the git-context scan.
// Relevant Files: apps/api/src/taskWorktrees.js, apps/api/src/app.js, apps/api/src/database.js
// Important Context: User file. The opencode CLI has no worktree subcommand, so the workspace manages git worktrees directly and runs the OpenCode CLI inside them.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const DEFAULT_GIT_TIMEOUT_MS = 60000
const MAX_SLUG_LENGTH = 40

/**
 * Turn a task title into a filesystem-safe slug fragment.
 */
export function slugifyTaskTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'task'
}

/**
 * Parse `git worktree list --porcelain` output into tracking entries with the
 * same shape the git-context scan persists. Shared so the task worktree
 * lifecycle and the scan route never drift apart.
 */
export function parseWorktreePorcelain(output, repositoryRoot) {
  const entries = []
  let current = {}
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current.worktreePath) entries.push(current)
      current = { repositoryRoot: String(repositoryRoot), worktreePath: line.slice(9).trim() }
    } else if (line.startsWith('HEAD ')) {
      current.headCommit = line.slice(5).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace('refs/heads/', '')
    } else if (line === '') {
      if (current.worktreePath) entries.push(current)
      current = {}
    }
  }
  if (current.worktreePath) entries.push(current)
  for (const entry of entries) {
    entry.branch ??= ''
    entry.headCommit ??= ''
  }
  return entries
}

/**
 * Default worktree root: a sibling directory of the repository so the main
 * checkout, its scans, and git status stay clean.
 */
export function defaultWorktreeRoot(repoRoot) {
  return join(dirname(resolve(repoRoot)), `${basename(resolve(repoRoot))}-worktrees`)
}

/**
 * Build the task worktree manager for one repository. All Git access runs
 * through execFile without a shell and is bounded by a timeout.
 */
export function createTaskWorktrees({
  repoRoot,
  worktreeRoot,
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS
} = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('Task worktrees require a repository root.')
  }
  const root = resolve(repoRoot)
  const resolvedWorktreeRoot = resolve(worktreeRoot ?? env.WORKSPACE_TASK_WORKTREE_ROOT ?? defaultWorktreeRoot(root))

  async function git(args, options = {}) {
    const { stdout } = await execFileImpl('git', ['-C', root, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      ...options
    })
    return stdout
  }

  function resolveWorktree({ taskId, title, name, branch } = {}) {
    if (!Number.isSafeInteger(taskId) || taskId < 1) {
      throw new Error('A worktree links to a task id.')
    }
    const slug = slugifyTaskTitle(name ?? title)
    return {
      path: join(resolvedWorktreeRoot, `task-${taskId}-${slug}`),
      branch: branch ?? `task/${taskId}-${slug}`
    }
  }

  async function branchExists(branch) {
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  async function create({ taskId, title, name, branch }) {
    const location = resolveWorktree({ taskId, title, name, branch })
    // A branch left behind by a hand-removed worktree is reused rather than
    // recreated, so a self-healing relink keeps the task's history.
    if (await branchExists(location.branch)) {
      await git(['worktree', 'add', location.path, location.branch])
    } else {
      await git(['worktree', 'add', '-b', location.branch, location.path])
    }
    return location
  }

  async function remove({ path, force = false }) {
    await git(['worktree', 'remove', ...(force ? ['--force'] : []), path])
    await git(['worktree', 'prune'])
  }

  async function prune() {
    await git(['worktree', 'prune'])
  }

  async function listEntries() {
    const output = await git(['worktree', 'list', '--porcelain'])
    return parseWorktreePorcelain(output, root)
  }

  return {
    repoRoot: root,
    worktreeRoot: resolvedWorktreeRoot,
    resolveWorktree,
    create,
    remove,
    prune,
    listEntries
  }
}

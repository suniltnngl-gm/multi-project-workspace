/**
 * SPLIT-BRAIN GUARD (#212) — pre-build dirty-worktree quarantine.
 *
 * A rebuild window must never edit on top of leftovers from an aborted turn: that is how
 * a stale diff gets committed under a fresh plan. Before any build/rebuild window writes,
 * the tree is inspected:
 *
 *   - clean                     -> nothing to do.
 *   - dirty WITH an active lease -> REFUSED. Those edits belong to a live work-item; the
 *                                   caller must resolve the conflict, not wipe them.
 *   - dirty WITHOUT an active lease -> orphaned. Every dirty path is snapshotted under
 *                                   `<backupRoot>/quarantine/<stamp>/` first. Restoration
 *                                   to the HEAD baseline happens ONLY when the caller
 *                                   explicitly passes `allowRestore: true`; by default the
 *                                   function is observational and non-destructive.
 *
 * Git access is injected (`runGit`, `readFileSync`) so tests need no real repository.
 */
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const STATUS_LINE = /^([ MADRCU?]{1,2})\s+(.+)$/

export function parsePorcelainStatus(statusText = '') {
  const out = []
  for (const raw of String(statusText).split(/\r?\n/)) {
    if (!raw.trim()) continue
    const m = STATUS_LINE.exec(raw.trim())
    if (!m) continue
    const [, code, path] = m
    const untracked = code.includes('?')
    out.push({ code, path: path.replace(/^"|"$/g, ''), untracked })
  }
  return out
}

function snapshotFile({ absPath, repoDir, quarantineDir, untracked }) {
  const rel = relative(repoDir, absPath) || 'file'
  const dest = join(quarantineDir, rel)
  mkdirSync(resolve(dest, '..'), { recursive: true })
  copyFileSync(absPath, dest)
  return { path: rel, snapshotPath: dest, untracked, sha256: null }
}

/**
 * Inspect and, optionally, quarantine a dirty worktree.
 * Never throws for a merely dirty tree; only refuses (ok:false) when an active work-item
 * owns the edits.
 */
export function quarantineDirtyWorktree({
  repoDir,
  workItemId = null,
  activeLease = false,
  allowRestore = false,
  backupRoot = null,
  isOwned = () => false,
  nowIso = () => new Date().toISOString(),
  runGit = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' }),
  existsSync: existsFn = existsSync,
  copyFileSync: copyFn = copyFileSync,
  mkdirSync: mkdirFn = mkdirSync,
  rmSync: rmFn = rmSync
} = {}) {
  const root = resolve(repoDir)
  const status = runGit(['status', '--porcelain=v1'], root)
  if (status.status !== 0) return { ok: false, reason: 'git_status_failed', detail: String(status.stderr || '') }
  const dirty = parsePorcelainStatus(status.stdout)
  if (dirty.length === 0) return { ok: true, reason: 'clean', quarantined: [], restored: false }

  const ownedPaths = dirty.filter((d) => isOwned(d.path)).map((d) => d.path)
  if (activeLease || ownedPaths.length > 0) {
    return {
      ok: false,
      reason: 'dirty_tree_with_active_work_item',
      workItemId,
      ownedPaths,
      dirty: dirty.map((d) => d.path),
      restored: false
    }
  }

  const stamp = nowIso().replace(/[:.]/g, '-')
  // Never write the quarantine store inside the repository: that would show up as new
  // untracked content on the next status call and feed back into the dirty set.
  const quarantineDir = backupRoot
    ? join(resolve(backupRoot), 'quarantine', stamp)
    : join(tmpdir(), 'swarm-quarantine', stamp)
  mkdirFn(quarantineDir, { recursive: true })

  const quarantined = []
  for (const entry of dirty) {
    const abs = join(root, entry.path)
    if (!existsFn(abs)) continue
    quarantined.push(snapshotFile({ absPath: abs, repoDir: root, quarantineDir, untracked: entry.untracked }))
  }

  if (!allowRestore) {
    return { ok: true, reason: 'orphaned_dirty_snapshot_only', quarantined, restored: false }
  }

  // Restore tracked edits to HEAD, remove untracked strays. Snapshots already exist.
  const tracked = quarantined.filter((q) => !q.untracked)
  const untracked = quarantined.filter((q) => q.untracked)
  for (const q of tracked) {
    const r = runGit(['checkout', '--', q.path], root)
    if (r.status !== 0) return { ok: false, reason: 'restore_failed', detail: String(r.stderr || ''), quarantined, restored: false }
  }
  for (const q of untracked) {
    try {
      rmFn(join(root, q.path), { force: true })
    } catch {
      return { ok: false, reason: 'restore_failed', detail: `unlink:${q.path}`, quarantined, restored: false }
    }
  }
  return { ok: true, reason: 'quarantined_and_restored', quarantined, restored: true }
}

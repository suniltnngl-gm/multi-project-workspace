#!/usr/bin/env node
/**
 * Phase 1 publish gate — turn a review round into a verified outcome.
 *
 * W4 (review) must leave a machine-readable verdict; W5 (publish) acts on it:
 *   ACCEPT -> triple-layer checkpoint (per-file backup + git commit + GitHub push)
 *   REJECT -> single-file `undoLastEdit` per modified file (never a wholesale revert)
 *             plus structured replan guidance for the next round's W1.
 *
 * Every read fails closed: a missing/malformed verdict is REJECT/missing_verdict_artifact,
 * so W5 can never guess.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'node:path'
import { evaluateDeterministicDiff } from './swarm-review.mjs'
import { checkpointPassingDiff, protectedWriteFile, undoLastEdit } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

export function roundBaseSha(repoDir) {
  const r = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 })
  return (r.stdout || '').trim() || null
}

/** Repo-relative files changed since `baseSha` (committed + working tree + untracked, deduped). */
export function modifiedFilesSince({ repoDir, baseSha }) {
  if (!baseSha) return []
  // `git diff <base>` covers both commits since base and uncommitted tracked edits.
  const changed = spawnSync('git', ['-C', repoDir, 'diff', '--name-only', baseSha], { encoding: 'utf8', timeout: 5000 })
  const untracked = spawnSync('git', ['-C', repoDir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 5000 })
  const files = [
    ...(changed.stdout || '').split(/\r?\n/),
    ...(untracked.stdout || '').split(/\r?\n/)
  ].map((s) => s.trim()).filter(Boolean)
  return [...new Set(files)].filter((p) => !isBackupArtifact(p))
}

/** Never treat relay/mutation-guard scratch artifacts as round deliverables. */
export function isBackupArtifact(relPath) {
  const p = String(relPath).replace(/\\/g, '/')
  return p.startsWith('.backups/') || p.includes('/.backups/')
    || /\.bak(?:\.meta\.json)?$/.test(p)
    || /\.edit-[0-9a-f-]+$/.test(p)
}

/**
 * Read the W4 verdict artifact. Fails closed when absent or not one of
 * ACCEPT|REJECT, so a silent/failed review can never reach publish as ACCEPT.
 */
export function readReviewVerdict(findingsPath, { windowStartedAtMs = null } = {}) {
  if (!findingsPath || !existsSync(findingsPath)) {
    return { verdict: 'REJECT', reason: 'missing_verdict_artifact' }
  }
  // A prior round's artifact must never authorize this round's publish gate.
  if (typeof windowStartedAtMs === 'number' && windowStartedAtMs > 0) {
    const mtimeMs = statSync(findingsPath).mtimeMs
    if (mtimeMs < windowStartedAtMs - 2000) {
      return { verdict: 'REJECT', reason: 'stale_verdict_artifact', mtimeMs, windowStartedAtMs }
    }
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(findingsPath, 'utf8'))
  } catch {
    return { verdict: 'REJECT', reason: 'malformed_verdict_artifact' }
  }
  const review = doc && typeof doc.review === 'object' ? doc.review : {}
  const raw = String(doc.verdict || review.verdict || '').trim().toUpperCase()
  if (raw !== 'ACCEPT' && raw !== 'REJECT') {
    return { verdict: 'REJECT', reason: 'missing_verdict_artifact' }
  }
  return { verdict: raw, reason: String(doc.reason || review.reason || `w4_${raw.toLowerCase()}`), source: findingsPath }
}

/** Deterministic $0 gates over the round diff (whitespace/secrets/unrecoverable + optional focused test). */
export function deterministicRoundReview({ repoDir, baseSha, testFile = null }) {
  // `<base>` compares against the working tree, so it covers both commits since the
  // round base and the sibling's uncommitted build edits.
  const range = baseSha || 'HEAD'
  const diffCheck = spawnSync('git', ['-C', repoDir, 'diff', '--check', range], { encoding: 'utf8', timeout: 5000 })
  const diffRes = spawnSync('git', ['-C', repoDir, 'diff', range], { encoding: 'utf8', timeout: 5000 })
  let testExitCode = 0
  if (testFile) {
    const tr = spawnSync(process.execPath, ['--test', resolve(repoDir, testFile)], {
      cwd: resolve(repoDir, 'apps/api'), encoding: 'utf8', timeout: 60_000
    })
    testExitCode = tr.status ?? 1
  }
  return evaluateDeterministicDiff({
    diffText: diffRes.stdout || '',
    diffCheckExitCode: diffCheck.status ?? 1,
    testExitCode
  })
}

/** Files among `files` that still differ from HEAD (i.e. would actually be committed). */
export function pendingFilesSinceHead({ repoDir, files }) {
  const list = files.filter(Boolean)
  if (!list.length) return []
  const r = spawnSync('git', ['-C', repoDir, 'status', '--porcelain', '--', ...list], { encoding: 'utf8', timeout: 5000 })
  const out = new Set()
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const p = line.slice(3).trim()
    if (p) out.add(p)
  }
  return [...out]
}

/**
 * Apply the W5 gate. Scoped strictly to the round's modified files; never `git add -A`.
 */
/**
 * REJECT cleanup that actually restores state:
 *  - files that existed before the round -> `undoLastEdit` (restore the pre-round snapshot)
 *  - files newly created during the round -> removed outright
 * Fails closed: any file still dirty vs `baseSha`, or any failed undo/remove,
 * yields ok:false so the relay halts instead of relaying on with unreviewed edits.
 */
export function rejectRoundCleanup({ repoDir, baseSha, preExisting = [], backupRoot = null } = {}) {
  const dirty = modifiedFilesSince({ repoDir, baseSha })
  const known = new Set((preExisting || []).map(String))
  const bdir = backupRoot ? join(resolve(backupRoot), '.backups') : null
  const created = []
  const edited = []
  const left = []
  const undone = []
  const removed = []
  const failed = []

  const isTrackedAtBase = (rel) => spawnSync('git', ['-C', repoDir, 'ls-files', '--error-unmatch', '--', String(rel)], { encoding: 'utf8', timeout: 5000 }).status === 0

  for (const rel of dirty) {
    if (isTrackedAtBase(rel)) { edited.push(rel); continue }
    // Untracked but already present before the round: not this round's artifact.
    if (known.has(rel)) { left.push(rel); continue }
    created.push(rel)
  }

  for (const rel of created) {
    try {
      rmSync(resolve(repoDir, rel), { force: true })
      removed.push(rel)
    } catch (err) {
      failed.push({ file: rel, error: String(err && err.message || err) })
    }
  }
  for (const rel of edited) {
    const abs = resolve(repoDir, rel)
    try {
      try {
        undoLastEdit(abs)
      } catch (repoLocalErr) {
        if (!bdir) throw repoLocalErr
        undoLastEdit(abs, { backupDir: bdir })
      }
      undone.push(rel)
    } catch (err) {
      // #221: a build sibling (cline/codex) can edit a tracked file without ever
      // going through protectedWriteFile, so no .backups/ snapshot exists. Restore
      // exactly that file from the round base — never a wholesale reset.
      const reason = String(err && err.message || err)
      const relSafe = !isAbsolute(String(rel)) && !String(rel).split(/[\\/]/).includes('..')
      if (/no_backup_history/.test(reason) && relSafe && baseSha) {
        const restore = spawnSync('git', ['-C', repoDir, 'checkout', String(baseSha), '--', String(rel)], { encoding: 'utf8', timeout: 5000 })
        if (restore.status === 0) {
          undone.push(rel)
          continue
        }
      }
      failed.push({ file: rel, error: reason })
    }
  }
  const allow = new Set(left)
  const remaining = modifiedFilesSince({ repoDir, baseSha }).filter((f) => !allow.has(f))
  return { ok: failed.length === 0 && remaining.length === 0, undone, removed, left, failed, remaining }
}

export function applyPublishGate({ verdict, repoDir, baseSha, reportDir, sibling = null, quotaPool = null, taskId = null, push = true, backupRoot = null, preExisting = [], verdictArtifactPath = null, windowId = null, gateSource = null }) {
  const files = modifiedFilesSince({ repoDir, baseSha })

  if (verdict.verdict === 'ACCEPT') {
    if (!files.length) return { ok: true, action: 'noop_no_changes', files: [] }
    // Idempotence: never re-commit work already committed/pushed by the build window —
    // `git commit` on clean files fails and would abort the relay before its summary.
    const pending = pendingFilesSinceHead({ repoDir, files })
    if (!pending.length) return { ok: true, action: 'already_committed', files }
    const res = checkpointPassingDiff({
      repoDir,
      files: pending,
      message: `swarm relay: auto-checkpoint accepted round (${sibling || 'unknown'})`,
      taskId,
      category: 'self-improvement',
      sibling,
      quotaPool,
      backupRoot: backupRoot || join(homedir(), '.local/state/curl-ai-bridge/repo-checkpoints'),
      push,
      // Provenance: only an ACCEPT artifact from this round authorizes the commit.
      gate: (verdictArtifactPath || verdict.source)
        ? { verdictPath: verdictArtifactPath || verdict.source, windowId, gateSource: gateSource || verdict.reason || null }
        : null
    })
    return { ok: true, action: 'checkpoint_pushed', files, commitSha: res.commitSha, gate: res.gate }
  }

  // REJECT: restore the pre-round baseline; block wholesale reverts.
  const cleanup = rejectRoundCleanup({ repoDir, baseSha, preExisting, backupRoot })
  const replanPath = join(reportDir, `replan-${Date.now()}.json`)
  protectedWriteFile(replanPath, `${JSON.stringify({
    schema: 'relay-replan/v1',
    verdict: verdict.verdict,
    reason: verdict.reason,
    baseSha,
    files: { undone: cleanup.undone, removed: cleanup.removed, failed: cleanup.failed },
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
  return {
    ok: cleanup.ok,
    action: cleanup.ok ? 'undone_single_file' : 'reject_cleanup_incomplete',
    files: { undone: cleanup.undone, removed: cleanup.removed, failed: cleanup.failed },
    remaining: cleanup.remaining,
    replanPath
  }
}

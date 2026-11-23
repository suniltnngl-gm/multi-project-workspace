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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'os'
import { join, resolve } from 'node:path'
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
export function readReviewVerdict(findingsPath) {
  if (!findingsPath || !existsSync(findingsPath)) {
    return { verdict: 'REJECT', reason: 'missing_verdict_artifact' }
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

/**
 * Apply the W5 gate. Scoped strictly to the round's modified files; never `git add -A`.
 */
export function applyPublishGate({ verdict, repoDir, baseSha, reportDir, sibling = null, quotaPool = null, taskId = null, push = true, backupRoot = null }) {
  const files = modifiedFilesSince({ repoDir, baseSha })

  if (verdict.verdict === 'ACCEPT') {
    if (!files.length) return { ok: true, action: 'noop_no_changes', files: [] }
    const res = checkpointPassingDiff({
      repoDir,
      files,
      message: `swarm relay: auto-checkpoint accepted round (${sibling || 'unknown'})`,
      taskId,
      category: 'self-improvement',
      sibling,
      quotaPool,
      backupRoot: backupRoot || join(homedir(), '.local/state/curl-ai-bridge/repo-checkpoints'),
      push
    })
    return { ok: true, action: 'checkpoint_pushed', files, commitSha: res.commitSha }
  }

  // REJECT: undo only the last edit on each modified file; block wholesale reverts.
  const undone = []
  for (const rel of files) {
    try {
      undoLastEdit(resolve(repoDir, rel))
      undone.push({ file: rel, ok: true })
    } catch (err) {
      undone.push({ file: rel, ok: false, error: String(err && err.message || err) })
    }
  }
  const replanPath = join(reportDir, `replan-${Date.now()}.json`)
  protectedWriteFile(replanPath, `${JSON.stringify({
    schema: 'relay-replan/v1',
    verdict: verdict.verdict,
    reason: verdict.reason,
    baseSha,
    files: undone,
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
  return { ok: true, action: 'undone_single_file', files: undone, replanPath }
}

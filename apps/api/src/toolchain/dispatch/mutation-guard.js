/**
 * Fail-closed unrecoverable-mutation guard and checksum-verified backup/recovery
 * helper for swarm state & repo operations.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const UNRECOVERABLE_PATTERNS = [
  { id: 'git_force_push', re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/i },
  { id: 'git_hard_reset', re: /\bgit\s+reset\s+--hard\b/i },
  { id: 'git_clean_force', re: /\bgit\s+clean\s+-[a-z]*f/i },
  { id: 'git_wholesale_checkout', re: /\bgit\s+(?:checkout\s+(?:--\s+)?\.|restore\s+(?:--staged\s+--worktree\s+|--worktree\s+)?\.|stash\s+(?:drop|clear))(?:\s|$)/i },
  { id: 'rm_rf_root_or_home', re: /\brm\s+-[a-z]*r[a-z]*f\s+(\/|~|\$HOME|\/home\/sunilkr\/Code\b)/i },
  { id: 'sql_destructive', re: /\b(DROP\s+(TABLE|VIEW|SCHEMA|DATABASE)|TRUNCATE\s+TABLE)\b/i },
  { id: 'cloud_destructive', re: /\b(gcloud\s+projects\s+delete|gsutil\s+rm|gcloud\s+storage\s+rm)\b/i }
]

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function classifyMutationRisk(commandOrAction) {
  const text = String(commandOrAction || '')
  for (const rule of UNRECOVERABLE_PATTERNS) {
    if (rule.re.test(text)) {
      return {
        allowed: false,
        risk: 'unrecoverable',
        rule: rule.id,
        reason: `blocked_unrecoverable_mutation:${rule.id}`
      }
    }
  }
  return { allowed: true, risk: 'recoverable', rule: null, reason: 'ok' }
}

let backupSeq = 0

export const DEFAULT_MAX_BACKUPS_PER_FILE = 5
export const DEFAULT_MAX_BACKUP_DIR_BYTES = 5 * 1024 * 1024

/**
 * Bounded backup retention pruner: keeps at most `maxBackupsPerFile` recent
 * checkpoints per file AND caps total directory usage at `maxTotalBytes`.
 * Always preserves at least the newest 1 backup per file (unless `maxBackupsPerFile === 0`
 * is explicitly passed after a git commit/push checkpoint) so `undoLastEdit`
 * can always recover the last-minute edit without wholesale rollback.
 */
export function pruneBackups(backupDir, {
  targetPath = null,
  maxBackupsPerFile = DEFAULT_MAX_BACKUPS_PER_FILE,
  maxTotalBytes = DEFAULT_MAX_BACKUP_DIR_BYTES
} = {}) {
  if (!backupDir || !existsSync(backupDir)) return { prunedCount: 0, freedBytes: 0 }
  const allBak = readdirSync(backupDir).filter((f) => f.endsWith('.bak')).sort()
  const byPrefix = new Map()
  for (const f of allBak) {
    // Format: <basename>.<iso-stamp>.<seq>.<uuid8>.bak
    const parts = f.split('.')
    const base = parts.length >= 5 ? parts.slice(0, -4).join('.') : f
    if (!byPrefix.has(base)) byPrefix.set(base, [])
    byPrefix.get(base).push(f)
  }

  let prunedCount = 0
  let freedBytes = 0
  const removeBak = (bakName) => {
    const bakPath = join(backupDir, bakName)
    const metaPath = `${bakPath}.meta.json`
    try {
      if (existsSync(bakPath)) {
        freedBytes += readFileSync(bakPath).length
        rmSync(bakPath, { force: true })
        prunedCount += 1
      }
      if (existsSync(metaPath)) rmSync(metaPath, { force: true })
    } catch {}
  }

  // 1. Per-file cap (allow 0 when explicitly clearing git-tracked file backups post-commit/push; otherwise min 1)
  const capPerFile = maxBackupsPerFile === 0
    ? 0
    : Math.max(1, Number(maxBackupsPerFile) || DEFAULT_MAX_BACKUPS_PER_FILE)
  for (const [base, list] of byPrefix.entries()) {
    if (targetPath && base !== basename(targetPath)) continue
    while (list.length > capPerFile) {
      const oldest = list.shift()
      removeBak(oldest)
    }
  }

  // 2. Directory total-bytes cap (evict oldest backups across files while keeping newest 1 per file)
  if (Number.isFinite(maxTotalBytes) && maxTotalBytes > 0) {
    const remaining = readdirSync(backupDir).filter((f) => f.endsWith('.bak')).sort()
    const latestPerBase = new Set()
    const entries = remaining.map((f) => {
      const parts = f.split('.')
      const base = parts.length >= 5 ? parts.slice(0, -4).join('.') : f
      const p = join(backupDir, f)
      const bytes = existsSync(p) ? readFileSync(p).length : 0
      return { f, base, bytes }
    })
    for (const e of entries) {
      // Since entries are sorted oldest->newest, overwriting leaves the newest per base
    }
    const newestByBase = new Map()
    for (const e of entries) newestByBase.set(e.base, e.f)
    for (const f of newestByBase.values()) latestPerBase.add(f)

    let totalBytes = entries.reduce((acc, e) => acc + e.bytes, 0)
    for (const e of entries) {
      if (totalBytes <= maxTotalBytes) break
      if (latestPerBase.has(e.f)) continue
      removeBak(e.f)
      totalBytes -= e.bytes
    }
  }

  return { prunedCount, freedBytes }
}

export function createRecoveryBackup(targetPath, {
  backupDir = null,
  maxBackupsPerFile = DEFAULT_MAX_BACKUPS_PER_FILE,
  maxTotalBytes = DEFAULT_MAX_BACKUP_DIR_BYTES
} = {}) {
  if (!existsSync(targetPath)) {
    throw new Error(`backup_target_missing:${targetPath}`)
  }
  const dir = backupDir || join(dirname(targetPath), '.backups')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const data = readFileSync(targetPath)
  const digest = sha256(data)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const seq = String(++backupSeq).padStart(6, '0')
  const backupPath = join(dir, `${basename(targetPath)}.${stamp}.${seq}.${randomUUID().slice(0, 8)}.bak`)
  const metaPath = `${backupPath}.meta.json`

  writeFileSync(backupPath, data, { mode: 0o600 })
  writeFileSync(metaPath, JSON.stringify({
    targetPath,
    backupPath,
    sha256: digest,
    bytes: data.length,
    createdAt: new Date().toISOString()
  }, null, 2), { mode: 0o600 })

  pruneBackups(dir, { targetPath, maxBackupsPerFile, maxTotalBytes })

  return { ok: true, targetPath, backupPath, metaPath, sha256: digest, bytes: data.length }
}

export function restoreRecoveryBackup(backupPath, targetPath) {
  const metaPath = `${backupPath}.meta.json`
  if (!existsSync(backupPath) || !existsSync(metaPath)) {
    throw new Error(`backup_or_meta_missing:${backupPath}`)
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const data = readFileSync(backupPath)
  const actual = sha256(data)
  if (actual !== meta.sha256) {
    throw new Error(`backup_checksum_mismatch:${backupPath}`)
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.restore-${randomUUID()}`
  writeFileSync(tmp, data)
  renameSync(tmp, targetPath)
  return { ok: true, restored: targetPath, sha256: actual, bytes: data.length }
}

/**
 * Per-file protected write: creates a checksummed single-file checkpoint of the
 * current file contents immediately before atomically writing `nextContent`.
 */
export function protectedWriteFile(targetPath, nextContent, {
  backupDir = null,
  maxBackupsPerFile = DEFAULT_MAX_BACKUPS_PER_FILE,
  maxTotalBytes = DEFAULT_MAX_BACKUP_DIR_BYTES,
  mode = null
} = {}) {
  const backup = existsSync(targetPath)
    ? createRecoveryBackup(targetPath, { backupDir, maxBackupsPerFile, maxTotalBytes })
    : null
  mkdirSync(dirname(targetPath), { recursive: true })
  const buf = Buffer.isBuffer(nextContent) ? nextContent : Buffer.from(String(nextContent), 'utf8')
  const postEditSha256 = sha256(buf)
  const tmp = `${targetPath}.edit-${randomUUID()}`
  writeFileSync(tmp, buf, mode ? { mode } : undefined)
  renameSync(tmp, targetPath)
  if (backup) {
    const meta = JSON.parse(readFileSync(backup.metaPath, 'utf8'))
    meta.postEditSha256 = postEditSha256
    writeFileSync(backup.metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
  }
  return { ok: true, targetPath, backupPath: backup?.backupPath ?? null, previousSha256: backup?.sha256 ?? null, postEditSha256 }
}

/**
 * Undo ONLY the last edit to `targetPath`, leaving earlier edits and all other
 * files in the working set intact. Fails closed if an unprotected edit modified
 * `targetPath` after the latest checkpoint (`unprotected_edit_detected`).
 */
export function undoLastEdit(targetPath, { backupDir = null } = {}) {
  const dir = backupDir || join(dirname(targetPath), '.backups')
  if (!existsSync(dir)) throw new Error(`no_backup_history:${targetPath}`)
  const prefix = `${basename(targetPath)}.`
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort()
  if (!candidates.length) throw new Error(`no_backup_history:${targetPath}`)

  const latest = join(dir, candidates[candidates.length - 1])
  const metaPath = `${latest}.meta.json`
  if (existsSync(metaPath) && existsSync(targetPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (meta.postEditSha256) {
      const currentSha = sha256(readFileSync(targetPath))
      if (currentSha !== meta.postEditSha256) {
        throw new Error(`unprotected_edit_detected:${targetPath}`)
      }
    }
  }
  const res = restoreRecoveryBackup(latest, targetPath)
  rmSync(latest, { force: true })
  rmSync(metaPath, { force: true })
  return { ...res, consumedBackup: latest }
}

/**
 * Git-checkpoint backup compactor: once changes are staged, committed, or pushed
 * to git/GitHub, git itself holds the durable history for repo files and the
 * milestone is checkpointed. However, every passing diff MUST remain protected by
 * all three layers: (1) local git commit, (2) GitHub remote push, and (3) at least
 * 1 per-file `.backups/` checkpoint (`keepRepoBackups = 1` min, `keepStateBackups = 1` min)
 * so a subsequent bad edit can still be rolled back per-file via `undoLastEdit`
 * without ever resorting to a wholesale git revert.
 */
export function pruneBackupsAfterGitCheckpoint({
  committedPaths = [],
  stateBackupDirs = [],
  keepRepoBackups = 1,
  keepStateBackups = 1,
  maxTotalBytes = DEFAULT_MAX_BACKUP_DIR_BYTES
} = {}) {
  let prunedCount = 0
  let freedBytes = 0
  const touchedRepoBackupDirs = new Set()

  for (const filePath of committedPaths) {
    if (!filePath) continue
    const bdir = join(dirname(filePath), '.backups')
    if (!existsSync(bdir)) continue
    touchedRepoBackupDirs.add(bdir)
    const res = pruneBackups(bdir, {
      targetPath: filePath,
      maxBackupsPerFile: keepRepoBackups,
      maxTotalBytes
    })
    prunedCount += res.prunedCount
    freedBytes += res.freedBytes
  }

  for (const bdir of touchedRepoBackupDirs) {
    try {
      if (existsSync(bdir) && readdirSync(bdir).length === 0) {
        rmSync(bdir, { recursive: true, force: true })
      }
    } catch {}
  }

  for (const bdir of stateBackupDirs) {
    if (!bdir || !existsSync(bdir)) continue
    const res = pruneBackups(bdir, {
      maxBackupsPerFile: Math.max(1, Number(keepStateBackups) || 1),
      maxTotalBytes
    })
    prunedCount += res.prunedCount
    freedBytes += res.freedBytes
  }

  return { ok: true, prunedCount, freedBytes }
}

/**
 * Triple-layer Passing-Diff Checkpoint (`backup` + `git commit` + `GitHub push`) +
 * Progressive Self-Improvement Telemetry Ledger (`checkpoint-ledger.jsonl`):
 * Ensures every passing diff is protected by:
 *   1. A fresh per-file `.backups/` snapshot of each passing file (`createRecoveryBackup`,
 *      compacted to `keepRepoBackups: 1` so recovery size stays minimal while preserving
 *      instant per-file undo if a subsequent edit breaks tests),
 *   2. A local git stage + commit of ONLY the specified passing `files`,
 *   3. Optional push to `remote` / `branch` (GitHub) + state backup compaction,
 *   4. A persistent JSONL telemetry entry tracking:
 *      - validated non-stop progress (`commitSha`, `pushed`, `filesCount`),
 *      - AI quota saved (by locking passing diffs so siblings never re-do passing files),
 *      - avoided wholesale undo/redo & early hallucination detection (`undoCount`, `hallucinationsCaught`),
 *      - authorized progressive/portable/reusable self-improvement category (`taskId`, `category`, `sibling`, ` quotaPool`).
 */
export function checkpointPassingDiff({
  repoDir,
  files = [],
  message = 'chore(checkpoint): passing diff checkpoint',
  backupRoot = null,
  stateBackupDirs = [],
  ledgerPath = null,
  taskId = null,
  category = 'self-improvement',
  sibling = null,
  quotaPool = null,
  undoCount = 0,
  hallucinationsCaught = 0,
  push = false,
  remote = 'origin',
  branch = 'master',
  runGit = null
} = {}) {
  if (!repoDir) throw new Error('repoDir_required')
  const root = resolve(repoDir)
  const relFiles = files.map((f) => String(f).trim()).filter(Boolean)
  if (!relFiles.length) throw new Error('checkpoint_files_required')

  const absFiles = relFiles.map((f) => resolve(root, f))
  const backups = []
  for (const abs of absFiles) {
    if (!existsSync(abs)) throw new Error(`checkpoint_file_missing:${abs}`)
    const bdir = backupRoot ? join(resolve(backupRoot), '.backups') : null
    const bak = createRecoveryBackup(abs, {
      backupDir: bdir,
      maxBackupsPerFile: 1
    })
    backups.push({ file: abs, backupPath: bak.backupPath, sha256: bak.sha256 })
  }

  const execGit = runGit || ((args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim())
  execGit(['add', '--', ...relFiles])
  execGit(['commit', '-m', message, '--', ...relFiles])
  const commitSha = execGit(['rev-parse', '--short', 'HEAD'])

  let pushed = false
  if (push) {
    execGit(['push', remote, branch])
    pushed = true
  }

  const pruned = pruneBackupsAfterGitCheckpoint({
    committedPaths: backupRoot ? [] : absFiles,
    stateBackupDirs: [
      ...(backupRoot ? [join(resolve(backupRoot), '.backups')] : []),
      ...stateBackupDirs
    ],
    keepRepoBackups: 1,
    keepStateBackups: 1
  })

  const resolvedLedgerPath = ledgerPath || (backupRoot ? join(resolve(backupRoot), 'checkpoint-ledger.jsonl') : null)
  const entry = {
    schema: 'checkpoint-telemetry/v1',
    at: new Date().toISOString(),
    atMs: Date.now(),
    commitSha,
    pushed,
    remote: push ? remote : null,
    branch: push ? branch : null,
    taskId: taskId || null,
    category: category || 'self-improvement',
    sibling: sibling || null,
    quotaPool: quotaPool || null,
    files: relFiles,
    filesCount: relFiles.length,
    backupsCount: backups.length,
    prunedCount: pruned.prunedCount,
    freedBytes: pruned.freedBytes,
    undoCount: Number(undoCount) || 0,
    hallucinationsCaught: Number(hallucinationsCaught) || 0,
    wholesaleRevertsAvoided: 1,
    estimatedQuotaTurnsSaved: Math.max(1, relFiles.length),
    message
  }

  if (resolvedLedgerPath) {
    mkdirSync(dirname(resolvedLedgerPath), { recursive: true, mode: 0o700 })
    appendFileSync(resolvedLedgerPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  return {
    ok: true,
    commitSha,
    pushed,
    remote: push ? remote : null,
    branch: push ? branch : null,
    files: relFiles,
    backups,
    pruned,
    telemetry: entry,
    ledgerPath: resolvedLedgerPath
  }
}

export function summarizeCheckpointTelemetry(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return {
      totalCheckpoints: 0,
      pushedCheckpoints: 0,
      filesProtected: 0,
      wholesaleRevertsAvoided: 0,
      estimatedQuotaTurnsSaved: 0,
      hallucinationsCaught: 0,
      singleFileUndos: 0,
      freedBackupBytes: 0,
      latestCommitSha: null,
      categories: {}
    }
  }
  const lines = readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  const summary = {
    totalCheckpoints: 0,
    pushedCheckpoints: 0,
    filesProtected: 0,
    wholesaleRevertsAvoided: 0,
    estimatedQuotaTurnsSaved: 0,
    hallucinationsCaught: 0,
    singleFileUndos: 0,
    freedBackupBytes: 0,
    latestCommitSha: null,
    categories: {}
  }
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      summary.totalCheckpoints += 1
      if (r.pushed) summary.pushedCheckpoints += 1
      summary.filesProtected += Number(r.filesCount) || 0
      summary.wholesaleRevertsAvoided += Number(r.wholesaleRevertsAvoided) || 0
      summary.estimatedQuotaTurnsSaved += Number(r.estimatedQuotaTurnsSaved) || 0
      summary.hallucinationsCaught += Number(r.hallucinationsCaught) || 0
      summary.singleFileUndos += Number(r.undoCount) || 0
      summary.freedBackupBytes += Number(r.freedBytes) || 0
      if (r.commitSha) summary.latestCommitSha = r.commitSha
      const cat = r.category || 'self-improvement'
      summary.categories[cat] = (summary.categories[cat] || 0) + 1
    } catch {}
  }
  return summary
}

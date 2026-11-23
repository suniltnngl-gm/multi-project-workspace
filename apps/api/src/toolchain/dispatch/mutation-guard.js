/**
 * Fail-closed unrecoverable-mutation guard and checksum-verified backup/recovery
 * helper for swarm state & repo operations.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const UNRECOVERABLE_PATTERNS = [
  { id: 'git_force_push', re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/i },
  { id: 'git_hard_reset', re: /\bgit\s+reset\s+--hard\b/i },
  { id: 'git_clean_force', re: /\bgit\s+clean\s+-[a-z]*f/i },
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
 * Always preserves at least the newest 1 backup per file so `undoLastEdit`
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

  // 1. Per-file cap (keep last N backups for each file, min 1)
  const capPerFile = Math.max(1, Number(maxBackupsPerFile) || DEFAULT_MAX_BACKUPS_PER_FILE)
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
  maxTotalBytes = DEFAULT_MAX_BACKUP_DIR_BYTES
} = {}) {
  const backup = existsSync(targetPath)
    ? createRecoveryBackup(targetPath, { backupDir, maxBackupsPerFile, maxTotalBytes })
    : null
  mkdirSync(dirname(targetPath), { recursive: true })
  const buf = Buffer.isBuffer(nextContent) ? nextContent : Buffer.from(String(nextContent), 'utf8')
  const postEditSha256 = sha256(buf)
  const tmp = `${targetPath}.edit-${randomUUID()}`
  writeFileSync(tmp, buf)
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

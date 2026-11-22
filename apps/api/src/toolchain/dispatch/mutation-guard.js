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

export function createRecoveryBackup(targetPath, { backupDir = null } = {}) {
  if (!existsSync(targetPath)) {
    throw new Error(`backup_target_missing:${targetPath}`)
  }
  const dir = backupDir || join(dirname(targetPath), '.backups')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const data = readFileSync(targetPath)
  const digest = sha256(data)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(dir, `${basename(targetPath)}.${stamp}.${randomUUID().slice(0, 8)}.bak`)
  const metaPath = `${backupPath}.meta.json`

  writeFileSync(backupPath, data, { mode: 0o600 })
  writeFileSync(metaPath, JSON.stringify({
    targetPath,
    backupPath,
    sha256: digest,
    bytes: data.length,
    createdAt: new Date().toISOString()
  }, null, 2), { mode: 0o600 })

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
export function protectedWriteFile(targetPath, nextContent, { backupDir = null } = {}) {
  const backup = existsSync(targetPath) ? createRecoveryBackup(targetPath, { backupDir }) : null
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.edit-${randomUUID()}`
  writeFileSync(tmp, nextContent)
  renameSync(tmp, targetPath)
  return { ok: true, targetPath, backupPath: backup?.backupPath ?? null, previousSha256: backup?.sha256 ?? null }
}

/**
 * Undo ONLY the last edit to `targetPath`, leaving earlier edits and all other
 * files in the working set intact. Consumes the restored checkpoint so repeated
 * calls walk backward one edit at a time (LIFO).
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
  const res = restoreRecoveryBackup(latest, targetPath)
  rmSync(latest, { force: true })
  rmSync(`${latest}.meta.json`, { force: true })
  return { ...res, consumedBackup: latest }
}

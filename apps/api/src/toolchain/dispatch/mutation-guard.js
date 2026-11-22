/**
 * Fail-closed unrecoverable-mutation guard and checksum-verified backup/recovery
 * helper for swarm state & repo operations.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

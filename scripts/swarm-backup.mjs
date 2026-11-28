#!/usr/bin/env node
/**
 * #302 — sqlite registry backups (edit safety).
 *
 * Zero-LLM, atomic snapshot of the state-side and board-side sqlite registries
 * (cases.sqlite, workspace.sqlite) into `backups/sqlite/` with timestamped names
 * and rotate keep-N. Complements protectedWriteFile's single-file lean backup:
 * registries that are mutated in place by many tools need whole-file snapshots.
 *
 * Never takes the orchestrator lease itself: it is read-only on the source
 * (copy via tmp + rename) and safe to run inside any entrypoint or the cron cycle.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { statePaths } from './swarm-state-paths.mjs'

export const BACKUP_SCHEMA = 'sqlite-registry-backup/v1'
export const DEFAULT_KEEP = 5

/** Copy one sqlite file atomically: tmp copy in the backup dir, then rename. */
export function backupOne(dbPath, backupDir, stamp, label) {
  if (!dbPath || !existsSync(dbPath)) return { label, ok: false, reason: 'db_not_found', dbPath }
  mkdirSync(backupDir, { recursive: true })
  const name = `${label}-${stamp}.sqlite`
  const tmp = join(backupDir, `${name}.tmp`)
  const final = join(backupDir, name)
  copyFileSync(dbPath, tmp)
  renameSync(tmp, final)
  return { label, ok: true, path: final, bytes: statSync(final).size }
}

/** Rotate old backups: keep the newest `keep` files per label. */
export function rotateBackups(backupDir, label, { keep = DEFAULT_KEEP } = {}) {
  const prefix = `${label}-`
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.sqlite'))
    .sort()
  const removed = files.slice(0, Math.max(0, files.length - keep)).map((f) => {
    unlinkSync(join(backupDir, f))
    return f
  })
  return removed
}

export function backupRegistries({
  stateDir = statePaths().root,
  boardPath = join(process.cwd(), 'apps', 'api', 'data', 'workspace.sqlite'),
  backupDir = join(stateDir, 'backups', 'sqlite'),
  keep = DEFAULT_KEEP,
  stamp = new Date().toISOString().replace(/[:.]/g, '-')
} = {}) {
  const casesPath = join(stateDir, 'queue', 'cases', 'cases.sqlite')
  const results = [
    backupOne(casesPath, backupDir, stamp, 'cases'),
    backupOne(boardPath, backupDir, stamp, 'workspace-board')
  ]
  const rotated = {}
  for (const label of ['cases', 'workspace-board']) {
    if (results.find((r) => r.label === label)?.ok) rotated[label] = rotateBackups(backupDir, label, { keep })
  }
  return { ok: results.every((r) => r.ok || r.reason === 'db_not_found'), schema: BACKUP_SCHEMA, stamp, backupDir, results, rotated }
}

const isMain = process.argv[1] && process.argv[1].endsWith('swarm-backup.mjs')

if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-backup.mjs [options]
      --state-dir <dir>   State root (default: ~/.local/state/curl-ai-bridge)
      --board <path>      Board sqlite path (default: <cwd>/apps/api/data/workspace.sqlite)
      --keep <n>          Backups to retain per registry (default: 5)
      --json              JSON output
  -h, --help              Show this help
`)
    process.exit(0)
  }
  const opt = (flag, fb = null) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb }
  const res = backupRegistries({
    stateDir: opt('--state-dir') || undefined,
    boardPath: opt('--board') || undefined,
    keep: Number(opt('--keep')) || DEFAULT_KEEP
  })
  process.stdout.write(`${JSON.stringify(res)}\n`)
}

/**
 * SP-009 / #235 Case Registry: unified SQLite-backed store (`case_registry_records` in
 * `apps/api/data/workspace.sqlite` or a directory-scoped `cases.sqlite` for isolated tests)
 * for multi-option cases, per-option sandbox findings, and governed promotion authority.
 *
 * Legacy `.json` case files are rejected fail-closed (`legacy_json_case_files_unsupported`)
 * so there is never a split-brain second JSON case home.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { statePaths } from '../../../../../scripts/swarm-state-paths.mjs'

function nowIso() {
  return new Date().toISOString()
}

/** #231/#235: canonical cases directory derived from the state-root contract. */
export function canonicalCasesDir(env = process.env) {
  return statePaths(env).casesDir
}

function assertNoLegacyJsonCases(dir) {
  if (!dir || !existsSync(dir)) return
  const legacy = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (legacy.length > 0) {
    throw new Error(`legacy_json_case_files_unsupported:${dir}:${legacy.join(',')}`)
  }
}

function openCaseStore(dir) {
  const rootDir = dir ?? canonicalCasesDir()
  assertNoLegacyJsonCases(rootDir)
  mkdirSync(rootDir, { recursive: true })
  const dbPath = join(rootDir, 'cases.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_registry_records (
      case_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return { db, dbPath }
}

export function readCases(dir = canonicalCasesDir()) {
  const rootDir = dir ?? canonicalCasesDir()
  assertNoLegacyJsonCases(rootDir)
  const dbPath = join(rootDir, 'cases.sqlite')
  if (!existsSync(dbPath)) return []
  const { db } = openCaseStore(rootDir)
  try {
    const rows = db.prepare('SELECT payload_json FROM case_registry_records ORDER BY case_id ASC').all()
    return rows.map((r) => JSON.parse(r.payload_json))
  } finally {
    db.close()
  }
}

export function readCase(dir, id) {
  const rootDir = dir ?? canonicalCasesDir()
  assertNoLegacyJsonCases(rootDir)
  const dbPath = join(rootDir, 'cases.sqlite')
  if (!existsSync(dbPath)) return null
  const { db } = openCaseStore(rootDir)
  try {
    const row = db.prepare('SELECT payload_json FROM case_registry_records WHERE case_id = ?').get(String(id))
    return row ? JSON.parse(row.payload_json) : null
  } finally {
    db.close()
  }
}

export function writeCase(dir, record) {
  const rootDir = dir ?? canonicalCasesDir()
  const { db, dbPath } = openCaseStore(rootDir)
  try {
    const updatedAt = nowIso()
    const next = {
      ...record,
      findings: record.findings || {},
      registry: { path: dbPath, store: 'sqlite', updatedAt, revision: (record.registry?.revision ?? 0) + 1 }
    }
    db.prepare(`
      INSERT INTO case_registry_records (case_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(String(record.id), JSON.stringify(next), updatedAt)
    return next
  } finally {
    db.close()
  }
}

/** Record a sandbox/worktree/temp simulation finding for one option of a case. */
export function recordOptionFinding(caseRecord, {
  optionId,
  ok = false,
  score = 0,
  latencyMs = null,
  sandboxType = 'temp',
  notes = ''
}) {
  const valid = (caseRecord.options || []).some((o) => o.id === optionId)
  if (!valid) throw new Error(`invalid_case_option:${caseRecord.id}:${optionId}`)
  return {
    ...caseRecord,
    findings: {
      ...(caseRecord.findings || {}),
      [optionId]: {
        optionId,
        ok: Boolean(ok),
        score: Number(score) || 0,
        latencyMs: latencyMs === null ? null : Number(latencyMs),
        sandboxType,
        notes: String(notes || ''),
        measuredAt: nowIso()
      }
    }
  }
}

/**
 * Pick the highest-scoring passing (`ok: true`) option and hand the decision to a
 * governed promoter. The file registry never creates tasks itself: promotion
 * authority lives in the governed SQLite case store (#231). Fails closed when no
 * passing finding exists or no promoter is supplied.
 */
export function selectBestOptionAndPromote(caseRecord, { promote = null } = {}) {
  const passing = Object.values(caseRecord.findings || {})
    .filter((f) => f && f.ok === true)
    .sort((a, b) => (b.score - a.score) || ((a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)) || a.optionId.localeCompare(b.optionId))

  if (!passing.length) {
    throw new Error(`no_passing_option_finding:${caseRecord.id}`)
  }
  if (typeof promote !== 'function') {
    throw new Error('case_promotion_authority_required')
  }
  const winner = passing[0]
  return promote(caseRecord, winner.optionId, {
    reason: `best_sandbox_finding:score=${winner.score},sandbox=${winner.sandboxType}`
  })
}

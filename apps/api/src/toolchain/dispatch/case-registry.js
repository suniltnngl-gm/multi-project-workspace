/**
 * SP-009 Case Registry: atomic store for multi-option cases, per-option sandbox
 * simulation findings (temp/worktree/sandbox), and evidence-based promotion to task.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { statePaths } from '../../../../../scripts/swarm-state-paths.mjs'

function nowIso() {
  return new Date().toISOString()
}

/** #231: the one canonical cases directory, derived from the state-root contract. */
export function canonicalCasesDir(env = process.env) {
  return statePaths(env).casesDir
}

function casePath(dir, id) {
  return join(dir, `${id}.json`)
}

export function readCases(dir = canonicalCasesDir()) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

export function readCase(dir, id) {
  const p = casePath(dir ?? canonicalCasesDir(), id)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function writeCase(dir, record) {
  const rootDir = dir ?? canonicalCasesDir()
  mkdirSync(rootDir, { recursive: true })
  const target = casePath(rootDir, record.id)
  const next = {
    ...record,
    findings: record.findings || {},
    registry: { path: target, updatedAt: nowIso(), revision: (record.registry?.revision ?? 0) + 1 }
  }
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, target)
  return next
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

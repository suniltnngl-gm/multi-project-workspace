/**
 * SPLIT-BRAIN GUARD (#211) — CAS state versions, lease-gated writes, state sets.
 *
 * Three deterministic invariants live here:
 *   1. Lease gate: a registry mutation may only proceed while the caller holds the
 *      CURRENT, unexpired resource lease (`assertCurrentLease`). Fail-closed reasons:
 *      `no_lease`, `orchestrator_lock_held`, `stale_lease_generation`, `lease_expired`.
 *   2. CAS state version: every record carries a monotonic `stateVersion`; a write must
 *      present the version it read (`If-Match`). Mismatch -> `stale_state_version`,
 *      which is the signal that another writer won the race.
 *   3. State sets: resting vs active, used by discovery reconciliation so an in-flight
 *      item is never archived or demoted (#212 consumes this).
 *
 * This module is pure except for `assertCurrentLease`, which reads the lease file through
 * an injectable `readFileSync` so tests need no real locks.
 */
import { join } from 'node:path'
import { readFileSync as defaultReadFileSync } from 'node:fs'

/** Mirrors ORCHESTRATOR_LOCK_SCHEMA in scripts/swarm-orchestrator-lock.mjs (single source of truth). */
export const LEASE_SCHEMA = 'orchestrator-lock/v1'

/**
 * States in which discovery consolidation may merge, deduplicate or archive an item.
 * Never an active item: archiving a scheduled/building item is the reconcile hazard.
 */
export const RESTING_STATES = Object.freeze(['open_case', 'queued', 'parked', 'PENDING', 'BLOCKED'])

/** States that mean the item is leased, planned, building, reviewing or publishing. */
export const ACTIVE_STATES = Object.freeze([
  'scheduled', 'studying', 'planning', 'building', 'reviewing', 'publishing',
  'ASSIGNED', 'RUNNING'
])

export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'CANCELLED', 'done', 'closed', 'resolved', 'retired'])

export function isResting(state) {
  return RESTING_STATES.includes(String(state))
}

export function isActive(state) {
  return ACTIVE_STATES.includes(String(state))
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(String(state))
}

/** Discovery may reconcile this state (resting and not terminal-by-activity). */
export function isReconcilable(state) {
  return isResting(state) && !isActive(state)
}

/** Resolve the lease path for a resource. Kept local so the registry layer stays decoupled. */
export function leaseLockPath(leaseDir, resource) {
  const name = String(resource || '').trim()
  if (!name) throw new Error('resource_required')
  return join(String(leaseDir), `${name}.lock.json`)
}

/**
 * Assert the caller holds the current, unexpired lease for a resource.
 * Returns { ok: true, lock, lockPath } or { ok: false, reason, ...diagnostics }.
 */
export function assertCurrentLease({
  leaseDir,
  resource = 'relay-ring',
  runId = null,
  pid = null,
  generation = null,
  nowMs = Date.now(),
  readFileSync: readFn = defaultReadFileSync
} = {}) {
  const read = readFn || defaultReadFileSync
  const path = leaseLockPath(leaseDir, resource)
  let doc = null
  try {
    doc = JSON.parse(String(read(path, 'utf8')))
  } catch {
    doc = null
  }
  if (!doc || doc.schema !== LEASE_SCHEMA) return { ok: false, reason: 'no_lease', lockPath: path }
  if (runId !== null && String(doc.runId) !== String(runId)) {
    return { ok: false, reason: 'orchestrator_lock_held', lockPath: path, holder: doc.runId, expectedRunId: String(runId) }
  }
  if (pid !== null && Number(doc.pid) !== Number(pid)) {
    return { ok: false, reason: 'orchestrator_lock_held', lockPath: path, holder: doc.runId, pid: doc.pid }
  }
  if (generation !== null && Number(doc.generation) !== Number(generation)) {
    return { ok: false, reason: 'stale_lease_generation', lockPath: path, holder: doc.runId, generation: doc.generation, expectedGeneration: Number(generation) }
  }
  const expiresMs = Number.isFinite(Number(doc.expiresAtMs)) ? Number(doc.expiresAtMs) : Date.parse(doc.expiresAt)
  if (!Number.isFinite(expiresMs) || nowMs > expiresMs) {
    return { ok: false, reason: 'lease_expired', lockPath: path, holder: doc.runId, expiresAt: doc.expiresAt }
  }
  return { ok: true, lock: doc, lockPath: path }
}

/** Current CAS version of a record; absent means 0 (never written through the registry). */
export function currentStateVersion(record) {
  const n = Number(record?.stateVersion)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Bump the CAS version. Every accepted write goes through here exactly once. */
export function withNextStateVersion(record) {
  return { ...record, stateVersion: currentStateVersion(record) + 1 }
}

/**
 * If-Match check. Pass the version the caller read; `null`/`undefined` means "no read"
 * and is rejected, because blind writes are exactly the split-brain case.
 */
export function assertCasWrite(record, expectedStateVersion) {
  const current = currentStateVersion(record)
  if (expectedStateVersion === null || expectedStateVersion === undefined) {
    throw new Error(`stale_state_version:missing_if_match:${current}`)
  }
  if (Number(expectedStateVersion) !== current) {
    throw new Error(`stale_state_version:${current}:${Number(expectedStateVersion)}`)
  }
  return true
}

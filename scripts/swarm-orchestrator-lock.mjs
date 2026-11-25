#!/usr/bin/env node
/**
 * Orchestrator mutual exclusion (#206).
 *
 * Scope (#206): wired into `swarm-relay --execute` only. The other mutating
 * entrypoints (`run`, `overnight`, `queue-run`, `case-solve`) do NOT take this lock
 * yet, so cross-entrypoint exclusion is partial — tracked as case MC-206-LOCK-SCOPE.
 * Within relay, two `--execute` runs cannot mutate ring state / ledgers / artifacts
 * at once — the split-brain this prevents.
 *
 * Contract:
 *   - Only `--execute` runs take the lock; dry-runs and read-only probes never do.
 *   - Acquisition is atomic (exclusive create). A live holder is NEVER preempted.
 *   - Reclamation requires BOTH an expired lease AND a dead PID (ESRCH), mirroring
 *     scripts/project-writer-lease.mjs, so a live process whose clock drifted keeps
 *     its lease.
 *   - Release is idempotent and owner-checked (runId + generation + pid).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ORCHESTRATOR_LOCK_SCHEMA = 'orchestrator-lock/v1'
export const DEFAULT_ORCHESTRATOR_LOCK_TTL_MS = 30 * 60 * 1000
export const DEFAULT_ORCHESTRATOR_RESOURCE = 'orchestrator'

/**
 * Resolve a resource-scoped lease path: `<stateDir>/<resource>.lock.json`.
 * The default keeps the historical `orchestrator.lock.json` name so existing
 * callers are unaffected; shared resources (quota ledger, queue) get their own
 * name so unrelated modes never block each other.
 */
export function orchestratorLockPath(stateDir, { resource = DEFAULT_ORCHESTRATOR_RESOURCE } = {}) {
  const name = String(resource || '').trim()
  if (!name) throw new Error('resource_required')
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`resource_name_invalid:${name}`)
  return join(String(stateDir), `${name}.lock.json`)
}

function parseLock(text) {
  try {
    const doc = JSON.parse(String(text))
    if (!doc || doc.schema !== ORCHESTRATOR_LOCK_SCHEMA) return null
    return doc
  } catch {
    return null
  }
}

/** Read the current lock; null when absent or unreadable/corrupt (never throws). */
export function readOrchestratorLock(lockPath, { readFileSync: readFn = readFileSync } = {}) {
  if (!existsSync(lockPath)) return null
  return parseLock(readFn(lockPath, 'utf8'))
}

/** A PID counts as alive unless kill(pid, 0) says ESRCH; EPERM means it exists. */
function pidAlive(pid, killFn) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    killFn(n, 0)
    return true
  } catch (err) {
    return String(err?.code) === 'EPERM'
  }
}

function expiryMs(lock) {
  const raw = Number.isFinite(Number(lock.expiresAtMs)) ? Number(lock.expiresAtMs) : Date.parse(lock.expiresAt)
  return Number.isFinite(raw) ? raw : NaN
}

function serialize(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`
}

/**
 * Try to take the orchestrator lock.
 * Returns { ok: true, lock, path, reclaimedFrom? } or
 *        { ok: false, reason: 'orchestrator_lock_held', ...diagnostics }.
 */
export function acquireOrchestratorLock({
  stateDir,
  runId,
  resource = DEFAULT_ORCHESTRATOR_RESOURCE,
  holder = 'swarm-relay',
  pid = process.pid,
  nowMs = Date.now(),
  ttlMs = DEFAULT_ORCHESTRATOR_LOCK_TTL_MS,
  killFn = process.kill,
  readFileSync: readFn = readFileSync,
  writeFileSync: writeFn = writeFileSync,
  unlinkSync: unlinkFn = unlinkSync
} = {}) {
  const path = orchestratorLockPath(stateDir, { resource })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fresh = () => ({
    schema: ORCHESTRATOR_LOCK_SCHEMA,
    holder: String(holder),
    resource: String(resource),
    runId: String(runId),
    pid: Number(pid),
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Number(ttlMs)).toISOString(),
    expiresAtMs: nowMs + Number(ttlMs),
    generation: 1
  })

  const refuse = (existing) => {
    const startedMs = Date.parse(existing.startedAt)
    return {
      ok: false,
      reason: 'orchestrator_lock_held',
      lockPath: path,
      holder: existing.holder,
      runId: existing.runId,
      pid: existing.pid,
      generation: existing.generation,
      startedAt: existing.startedAt,
      expiresAt: existing.expiresAt,
      ageSec: Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : null
    }
  }

  try {
    // Atomic claim: exclusive create fails with EEXIST when a lock already exists.
    writeFn(path, serialize(fresh()), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { ok: true, lock: readOrchestratorLock(path, { readFileSync: readFn }), path }
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
  }

  const existing = readOrchestratorLock(path, { readFileSync: readFn })
  if (!existing) {
    // Vanished between EEXIST and read: one retry, then fail closed.
    try {
      writeFn(path, serialize(fresh()), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { ok: true, lock: readOrchestratorLock(path, { readFileSync: readFn }), path }
    } catch (err2) {
      if (err2?.code !== 'EEXIST') throw err2
    }
    return refuse(readOrchestratorLock(path, { readFileSync: readFn }) || { holder: 'unknown', runId: null, pid: null, startedAt: new Date(nowMs).toISOString(), expiresAt: null })
  }

  const expired = Number.isFinite(expiryMs(existing)) && nowMs > expiryMs(existing)
  if (!expired || pidAlive(existing.pid, killFn)) return refuse(existing)

  // Expired AND the holder is gone: reclaim, bumping the generation.
  try {
    unlinkFn(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const next = { ...fresh(), generation: Number(existing.generation || 0) + 1 }
  writeFn(path, serialize(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { ok: true, lock: readOrchestratorLock(path, { readFileSync: readFn }), path, reclaimedFrom: existing }
}

/**
 * Release the lock. Owner-checked so one run can never clear another's lease;
 * releasing twice (or after a reclaim) is a no-op success.
 */
export function releaseOrchestratorLock({
  stateDir,
  runId,
  generation = null,
  pid = process.pid,
  resource = DEFAULT_ORCHESTRATOR_RESOURCE,
  readFileSync: readFn = readFileSync,
  unlinkSync: unlinkFn = unlinkSync
} = {}) {
  const path = orchestratorLockPath(stateDir, { resource })
  const existing = readOrchestratorLock(path, { readFileSync: readFn })
  if (!existsSync(path) || !existing) return { ok: true, released: false, reason: 'no_lock', lockPath: path }
  if (
    String(existing.runId) !== String(runId)
    || Number(existing.pid) !== Number(pid)
    || (generation !== null && Number(existing.generation) !== Number(generation))
  ) {
    return { ok: false, released: false, reason: 'lock_owner_mismatch', lockPath: path, holder: existing.runId }
  }
  try {
    unlinkFn(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return { ok: true, released: true, lockPath: path }
}

/**
 * Heartbeat renewal (#209, case-swarm-lease-lifecycle). Owner-checked on runId,
 * generation and pid: a superseded or foreign writer cannot extend a lease it does
 * not hold. Extends `expiresAt` by `ttlMs` from `nowMs` and stamps `renewedAt`.
 */
export function renewOrchestratorLock({
  stateDir,
  runId,
  generation,
  pid = process.pid,
  resource = DEFAULT_ORCHESTRATOR_RESOURCE,
  nowMs = Date.now(),
  ttlMs = DEFAULT_ORCHESTRATOR_LOCK_TTL_MS,
  readFileSync: readFn = readFileSync,
  writeFileSync: writeFn = writeFileSync
} = {}) {
  const path = orchestratorLockPath(stateDir, { resource })
  const existing = readOrchestratorLock(path, { readFileSync: readFn })
  if (!existsSync(path) || !existing) return { ok: false, reason: 'no_lock', lockPath: path }
  const ownerMatches = String(existing.runId) === String(runId)
    && Number(existing.pid) === Number(pid)
    && (generation === null || Number(existing.generation) === Number(generation))
  if (!ownerMatches) {
    return { ok: false, reason: 'lock_owner_mismatch', lockPath: path, holder: existing.runId }
  }
  const renewed = {
    ...existing,
    expiresAt: new Date(nowMs + Number(ttlMs)).toISOString(),
    expiresAtMs: nowMs + Number(ttlMs),
    renewedAt: new Date(nowMs).toISOString()
  }
  writeFn(path, serialize(renewed), { encoding: 'utf8', mode: 0o600 })
  return { ok: true, lock: readOrchestratorLock(path, { readFileSync: readFn }), lockPath: path }
}

/** Audit line for an operator/automatic reclaim; best-effort, never blocks the reclaim. */
function appendReclaimAudit(stateDir, reclaimedFrom) {
  try {
    const path = join(String(stateDir), 'lifecycle-transitions.jsonl')
    const line = `${JSON.stringify({
      event: 'lease_reclaimed_split_brain_guard',
      holder: reclaimedFrom?.holder ?? null,
      runId: reclaimedFrom?.runId ?? null,
      generation: reclaimedFrom?.generation ?? null,
      pid: reclaimedFrom?.pid ?? null,
      at: new Date().toISOString()
    })}\n`
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
  } catch { /* audit is observational; a failed append must not strand the lease */ }
}

/**
 * Operator-facing reclaim (#209, case-swarm-lease-lifecycle). Applies exactly the same
 * rule as automatic reclamation — expired AND dead holder PID — so a live process is
 * never preempted by an operator action. Use this instead of unlinking a lock by hand.
 */
export function reclaimExpiredOrchestratorLock({
  stateDir,
  resource = DEFAULT_ORCHESTRATOR_RESOURCE,
  nowMs = Date.now(),
  killFn = process.kill,
  readFileSync: readFn = readFileSync,
  unlinkSync: unlinkFn = unlinkSync
} = {}) {
  const path = orchestratorLockPath(stateDir, { resource })
  const existing = readOrchestratorLock(path, { readFileSync: readFn })
  if (!existsSync(path) || !existing) return { ok: true, reclaimed: false, reason: 'no_lock', lockPath: path }

  const expiresMs = Number.isFinite(Number(existing.expiresAtMs))
    ? Number(existing.expiresAtMs)
    : Date.parse(existing.expiresAt)
  const expired = Number.isFinite(expiresMs) && nowMs > expiresMs
  if (!expired) return { ok: false, reclaimed: false, reason: 'lease_not_expired', lockPath: path, holder: existing.runId, expiresAt: existing.expiresAt }
  if (pidAlive(existing.pid, killFn)) return { ok: false, reclaimed: false, reason: 'holder_pid_alive', lockPath: path, holder: existing.runId, pid: existing.pid }

  try {
    unlinkFn(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  appendReclaimAudit(stateDir, existing)
  return { ok: true, reclaimed: true, lockPath: path, reclaimedFrom: existing }
}

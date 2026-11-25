/**
 * REG-LATTICE-001 — work-item registry store and slot claims.
 *
 * A work-item is a scheduled job (REG-LATTICE-001 §5.2): it carries the core fields of
 * `schemas/work-item.schema.json` plus scheduling-only fields (`slotRef`, `runRef`,
 * `scheduledAt`). Slot bindings live under `<dir>/slots/<slotRef>.json`.
 *
 * Atomicity: registry writes are tmp+rename with a monotonic `registry.revision`
 * compare-and-set, matching `case-registry.js` and `job-registry.js`.
 * Concurrency: a slot is claimed by exclusive create and released by owner check,
 * mirroring `swarm-orchestrator-lock.mjs`. A live holder is NEVER preempted; reclamation
 * requires BOTH an expired lease AND a dead holder PID (ESRCH), so a live process whose
 * clock drifted keeps its slot.
 *
 * Scope limit: per-host store, not a distributed lock.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORK_ITEM_SLOT_SCHEMA = 'work-item-slot/v1'
export const DEFAULT_SLOT_TTL_MS = 30 * 60 * 1000

function nowIso() {
  return new Date().toISOString()
}

function workItemPath(dir, id) {
  return join(String(dir), `${id}.json`)
}

export function slotPath(dir, slotRef) {
  return join(String(dir), 'slots', `${slotRef}.json`)
}

/** Read every work-item, deterministically ordered by workItemId. */
export function readWorkItems(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

/** Read one work-item; null when absent. */
export function readWorkItem(dir, workItemId) {
  const p = workItemPath(dir, workItemId)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * Atomically write a work-item. `expectedRevision` enforces compare-and-set; a stale
 * writer is rejected with `revision_conflict:<workItemId>:<current>`.
 */
export function writeWorkItem(dir, record, { expectedRevision = null } = {}) {
  if (!record?.workItemId) throw new Error('work_item_id_required')
  mkdirSync(dir, { recursive: true })
  const target = workItemPath(dir, record.workItemId)
  if (expectedRevision !== null && existsSync(target)) {
    const current = JSON.parse(readFileSync(target, 'utf8'))
    const currentRevision = current.registry?.revision ?? 0
    if (currentRevision !== expectedRevision) {
      throw new Error(`revision_conflict:${record.workItemId}:${currentRevision}`)
    }
  }
  const next = {
    ...record,
    updatedAt: nowIso(),
    registry: { path: target, updatedAt: nowIso(), revision: (record.registry?.revision ?? 0) + 1 }
  }
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, target)
  return next
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

function parseSlot(text) {
  try {
    const doc = JSON.parse(String(text))
    if (!doc || doc.schema !== WORK_ITEM_SLOT_SCHEMA) return null
    return doc
  } catch {
    return null
  }
}

function readSlot(slotFilePath, { readFileSync: readFn = readFileSync } = {}) {
  if (!existsSync(slotFilePath)) return null
  return parseSlot(readFn(slotFilePath, 'utf8'))
}

function serialize(slot) {
  return `${JSON.stringify(slot, null, 2)}\n`
}

/**
 * Claim a slot for a work-item. Returns `{ ok: true, slot, path, reclaimedFrom? }` or
 * `{ ok: false, reason: 'slot_held', ...diagnostics }`.
 */
export function claimSlot({
  dir,
  slotRef,
  workItemId,
  runId = null,
  pid = process.pid,
  nowMs = Date.now(),
  ttlMs = DEFAULT_SLOT_TTL_MS,
  killFn = process.kill,
  readFileSync: readFn = readFileSync,
  writeFileSync: writeFn = writeFileSync,
  unlinkSync: unlinkFn = unlinkSync
} = {}) {
  const path = slotPath(dir, slotRef)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fresh = () => ({
    schema: WORK_ITEM_SLOT_SCHEMA,
    slotRef: String(slotRef),
    workItemId: String(workItemId),
    holder: String(workItemId),
    runId: runId ? String(runId) : null,
    pid: Number(pid),
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Number(ttlMs)).toISOString(),
    expiresAtMs: nowMs + Number(ttlMs),
    generation: 1
  })

  const refuse = (existing) => ({
    ok: false,
    reason: 'slot_held',
    slotPath: path,
    holder: existing.holder,
    workItemId: existing.holder,
    pid: existing.pid,
    generation: existing.generation,
    startedAt: existing.startedAt,
    expiresAt: existing.expiresAt,
    ageSec: Math.max(0, Math.round((nowMs - Date.parse(existing.startedAt)) / 1000))
  })

  try {
    writeFn(path, serialize(fresh()), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { ok: true, slot: readSlot(path, { readFileSync: readFn }), path }
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
  }

  const existing = readSlot(path, { readFileSync: readFn })
  if (!existing) {
    // Vanished between EEXIST and read: one retry, then fail closed.
    try {
      writeFn(path, serialize(fresh()), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { ok: true, slot: readSlot(path, { readFileSync: readFn }), path }
    } catch (err2) {
      if (err2?.code !== 'EEXIST') throw err2
    }
    const reread = readSlot(path, { readFileSync: readFn })
    return reread ? refuse(reread) : { ok: false, reason: 'slot_unreadable', slotPath: path }
  }

  const expiresMs = Number.isFinite(Number(existing.expiresAtMs))
    ? Number(existing.expiresAtMs)
    : Date.parse(existing.expiresAt)
  const expired = Number.isFinite(expiresMs) && nowMs > expiresMs
  if (!expired || pidAlive(existing.pid, killFn)) return refuse(existing)

  try {
    unlinkFn(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const next = { ...fresh(), generation: Number(existing.generation || 0) + 1 }
  writeFn(path, serialize(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { ok: true, slot: readSlot(path, { readFileSync: readFn }), path, reclaimedFrom: existing }
}

/**
 * Release a slot. Owner-checked on workItemId and pid; releasing twice (or after a
 * reclaim) is a no-op success so a de-scheduling transition cannot strand a slot.
 */
export function releaseSlot({
  dir,
  slotRef,
  workItemId,
  pid = process.pid,
  readFileSync: readFn = readFileSync,
  unlinkSync: unlinkFn = unlinkSync
} = {}) {
  const path = slotPath(dir, slotRef)
  const existing = readSlot(path, { readFileSync: readFn })
  if (!existsSync(path) || !existing) return { ok: true, released: false, reason: 'no_slot', slotPath: path }
  if (String(existing.holder) !== String(workItemId) || Number(existing.pid) !== Number(pid)) {
    return { ok: false, released: false, reason: 'slot_owner_mismatch', slotPath: path, holder: existing.holder }
  }
  try {
    unlinkFn(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return { ok: true, released: true, slotPath: path }
}

/**
 * REG-LATTICE-001 — job registry store.
 *
 * File-backed registry of jobs (REG-LATTICE-001 §5.2). Each job is one JSON record
 * named `<jobId>.json` under the registry directory. Mirrors the conventions already
 * established by `case-registry.js`: atomic tmp+rename writes so a reader never sees a
 * partial record, and a monotonic `registry.revision` compare-and-set so a lost update
 * is rejected instead of silently clobbering a newer write.
 *
 * Scope limit: this is a per-host store, not a distributed lock and not the project
 * writer lease. It records *what is admitted to execution*; it does not fence writers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertCurrentLease, assertCasWrite, currentStateVersion } from './cas-state.js'

function nowIso() {
  return new Date().toISOString()
}

function jobPath(dir, jobId) {
  return join(String(dir), `${jobId}.json`)
}

/** Read every job in the registry, deterministically ordered by jobId. */
export function readJobs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

/** Read one job; null when absent. */
export function readJob(dir, jobId) {
  const p = jobPath(dir, jobId)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * Atomically write a job. Fail-closed on two independent guards:
 *  - `lease` must name the resource lease the caller holds (`{ dir, resource, runId, pid, generation }`);
 *    a missing or non-current lease throws `lease_required` / `orchestrator_lock_held`.
 *  - `expectedStateVersion` is an If-Match check against the stored record, so a writer
 *    that lost the race throws `stale_state_version` instead of clobbering.
 * `expectedRevision` additionally enforces compare-and-set on the registry revision.
 */
export function writeJob(dir, record, { expectedRevision = null, expectedStateVersion, lease } = {}) {
  if (!record?.jobId) throw new Error('job_id_required')
  if (!lease) throw new Error(`lease_required:${record.jobId}`)
  const gate = assertCurrentLease({
    leaseDir: lease.dir,
    resource: lease.resource || 'relay-ring',
    runId: lease.runId ?? null,
    pid: lease.pid ?? null,
    generation: lease.generation ?? null
  })
  if (!gate.ok) throw new Error(`${gate.reason}:${record.jobId}`)

  mkdirSync(dir, { recursive: true })
  const target = jobPath(dir, record.jobId)
  const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null
  assertCasWrite(existing ?? {}, expectedStateVersion)
  if (expectedRevision !== null && existing) {
    const currentRevision = existing.registry?.revision ?? 0
    if (currentRevision !== expectedRevision) {
      throw new Error(`revision_conflict:${record.jobId}:${currentRevision}`)
    }
  }
  const next = {
    ...record,
    stateVersion: (existing ? currentStateVersion(existing) : 0) + 1,
    registry: { path: target, updatedAt: nowIso(), revision: ((existing?.registry?.revision) ?? (record.registry?.revision ?? 0)) + 1 }
  }
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, target)
  return next
}

/** Registry statistics: counts by state plus the highest revision seen. */
export function jobRegistryStats(dir) {
  const jobs = readJobs(dir)
  const byState = {}
  for (const job of jobs) {
    const state = String(job.state || 'unknown')
    byState[state] = (byState[state] || 0) + 1
  }
  return { total: jobs.length, byState, highestRevision: jobs.reduce((max, j) => Math.max(max, j.registry?.revision ?? 0), 0) }
}

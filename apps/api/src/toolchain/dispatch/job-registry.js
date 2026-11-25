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
 * Atomically write a job. `expectedRevision` enforces compare-and-set: a stale writer
 * is rejected with `revision_conflict:<jobId>:<current>` and the on-disk record wins.
 */
export function writeJob(dir, record, { expectedRevision = null } = {}) {
  if (!record?.jobId) throw new Error('job_id_required')
  mkdirSync(dir, { recursive: true })
  const target = jobPath(dir, record.jobId)
  if (expectedRevision !== null && existsSync(target)) {
    const current = JSON.parse(readFileSync(target, 'utf8'))
    const currentRevision = current.registry?.revision ?? 0
    if (currentRevision !== expectedRevision) {
      throw new Error(`revision_conflict:${record.jobId}:${currentRevision}`)
    }
  }
  const next = {
    ...record,
    registry: { path: target, updatedAt: nowIso(), revision: (record.registry?.revision ?? 0) + 1 }
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

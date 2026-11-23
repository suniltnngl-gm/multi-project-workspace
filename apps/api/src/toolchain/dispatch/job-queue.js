import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rankTasks } from './task-prioritizer.js'

/**
 * SP-007 / SP-009 bounded-job queue store with priority ranking and bounded replan.
 *
 * Atomicity: every write goes to a sibling temp file and is renameSync'd over the
 * target, so a reader never observes a partial task record.
 * Concurrency: a monotonic `revision` lets a writer detect that another tick won the
 * race. Lost updates are rejected, never silently applied.
 */

export const JOB_TYPES = Object.freeze(['plan', 'replan', 'build', 'publish', 'review'])

export const DEFAULT_JOB_TIMEOUT_MS = Object.freeze({
  plan: 180_000,
  replan: 180_000,
  build: 300_000,
  review: 120_000,
  publish: 180_000
})

export function shouldHarvestTimeoutArtifact({ planDocPath, jobStartedAtMs, minBytes = 200 } = {}) {
  if (!planDocPath || !existsSync(planDocPath)) return { harvest: false, reason: 'artifact_missing' }
  const st = statSync(planDocPath)
  if (st.size < minBytes) return { harvest: false, reason: 'artifact_too_small', bytes: st.size }
  if (typeof jobStartedAtMs === 'number' && jobStartedAtMs > 0 && st.mtimeMs < jobStartedAtMs - 1000) {
    return { harvest: false, reason: 'artifact_stale', mtimeMs: st.mtimeMs, jobStartedAtMs }
  }
  return { harvest: true, reason: 'fresh_verified_artifact', bytes: st.size, mtimeMs: st.mtimeMs }
}

const TERMINAL_STATES = new Set(['done', 'parked', 'ready_to_publish', 'waiting_remote'])
const VALID_STATES = new Set([
  'queued', 'planning', 'replanning', 'building', 'review_plan', 'review_build',
  'waiting_remote', 'ready_to_publish', 'publishing', 'done', 'parked'
])

function nowIso() {
  return new Date().toISOString()
}

function taskPath(dir, taskId) {
  return join(dir, `${taskId}.json`)
}

/** Read every task in the queue, deterministically ordered by taskId. */
export function readQueue(dir) {
  if (!existsSync(dir)) return []
  const tasks = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const raw = readFileSync(join(dir, name), 'utf8')
    tasks.push(JSON.parse(raw))
  }
  return tasks
}

export function readTask(dir, taskId) {
  const p = taskPath(dir, taskId)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * Atomically write a task. `expectedRevision` enforces compare-and-set: if the on-disk
 * revision differs, the write is rejected instead of clobbering a newer tick.
 */
export function writeTask(dir, task, { expectedRevision = null } = {}) {
  mkdirSync(dir, { recursive: true })
  const target = taskPath(dir, task.taskId)
  if (expectedRevision !== null && existsSync(target)) {
    const current = JSON.parse(readFileSync(target, 'utf8'))
    if (current.queue?.revision !== expectedRevision) {
      throw new Error(`queue_revision_conflict:${task.taskId}:${current.queue?.revision}`)
    }
  }
  const next = {
    ...task,
    queue: { path: target, updatedAt: nowIso(), revision: (task.queue?.revision ?? 0) + 1 }
  }
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, target)
  return next
}

/** Create a task from a minimal descriptor. */
export function createTask(dir, {
  taskId,
  jobs = [],
  state = 'queued',
  pinned = null,
  priority = 'P2',
  blocker = false,
  unblocksCount = 0,
  costTier = 'daily',
  maxReplans = 2,
  replanCount = 0
}) {
  if (!VALID_STATES.has(state)) throw new Error(`queue_state_invalid:${state}`)
  const task = {
    taskId,
    state,
    priority,
    blocker: Boolean(blocker),
    unblocksCount: Number(unblocksCount) || 0,
    costTier,
    maxReplans: Number(maxReplans) ?? 2,
    replanCount: Number(replanCount) || 0,
    pinned: pinned && pinned.sessionId ? pinned : null,
    jobs: jobs.map((j, i) => ({
      id: j.id ?? `j${i + 1}`,
      type: j.type,
      status: j.status ?? 'pending',
      attempts: j.attempts ?? 0,
      timeoutMs: j.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS[j.type],
      result: j.result ?? {},
      verdict: j.verdict ?? null,
      reason: j.reason ?? null,
      reviewedAt: j.reviewedAt ?? null
    })),
    queue: { path: taskPath(dir, taskId), updatedAt: nowIso(), revision: 0 }
  }
  return writeTask(dir, task)
}

/** Next actionable job for a task, or null when the task is waiting/exited. */
export function nextPendingJob(task) {
  if (TERMINAL_STATES.has(task.state)) return null
  return task.jobs.find((j) => j.status === 'pending') ?? null
}

/**
 * Record a review verdict. Fail-closed: an absent or malformed verdict leaves the task
 * in its review state with the job still pending.
 */
export function applyVerdict(task, { verdict, reason = null, reviewedAt = null }) {
  const normalized = typeof verdict === 'string' ? verdict.toUpperCase() : ''
  if (!['ACCEPT', 'REJECT'].includes(normalized)) {
    return { ...task, state: task.state, jobs: task.jobs.map((j) => (j.type === 'review' && j.status === 'pending' ? j : j)) }
  }
  const job = task.jobs.find((j) => j.type === 'review' && j.status === 'pending')
  if (!job) return task
  const jobs = task.jobs.map((j) => (j.id === job.id
    ? { ...j, status: 'done', verdict: normalized, reason, reviewedAt: reviewedAt ?? nowIso() }
    : j))
  return { ...task, jobs }
}

/** Mark a job's outcome and advance the task state. */
export function completeJob(task, jobId, { status, result = {}, reason = null, state = null }) {
  const jobs = task.jobs.map((j) => (j.id === jobId ? { ...j, status, result, reason } : j))
  return { ...task, jobs, ...(state ? { state } : {}) }
}

/**
 * Bounded replan transition (SP-009): on worker REJECT, enqueue a `replan` job
 * up to `maxReplans`; once exhausted, fail-closed to `parked`.
 * Fail-closed wrapper/policy rejections (`source: 'fail_closed'`) are tracked
 * separately (`failClosedCount`) and do NOT consume the worker `replanCount` budget.
 */
export function transitionToReplan(task, { reason = null, source = 'worker_reject' } = {}) {
  if (source === 'fail_closed') {
    return {
      ...task,
      failClosedCount: Number(task.failClosedCount || 0) + 1,
      lastFailClosedReason: reason
    }
  }
  const maxReplans = Number.isFinite(task.maxReplans) ? task.maxReplans : 2
  const current = Number(task.replanCount || 0)
  if (current >= maxReplans) {
    return { ...task, state: 'parked', parkReason: reason ? `max_replans_exceeded:${reason}` : 'max_replans_exceeded' }
  }
  const nextCount = current + 1
  const replanJob = {
    id: `replan-${nextCount}`,
    type: 'replan',
    status: 'pending',
    attempts: 0,
    timeoutMs: DEFAULT_JOB_TIMEOUT_MS.replan,
    result: {},
    verdict: null,
    reason,
    reviewedAt: null
  }
  return {
    ...task,
    state: 'replanning',
    replanCount: nextCount,
    jobs: [...task.jobs, replanJob]
  }
}

/** Priority-first, pool-LRU deterministic selection (SP-009). */
export function selectNextTask(tasks, { lastUsedByPool = {} } = {}) {
  const actionable = tasks.filter((t) => !TERMINAL_STATES.has(t.state) && nextPendingJob(t))
  if (!actionable.length) return null
  return rankTasks(actionable, { lastUsedByPool })[0]
}

export function queueStats(dir) {
  const tasks = readQueue(dir)
  const by = (s) => tasks.filter((t) => t.state === s).length
  return {
    total: tasks.length,
    queued: by('queued'),
    ready_to_publish: by('ready_to_publish'),
    done: by('done'),
    parked: by('parked'),
    active: tasks.length - by('done') - by('parked')
  }
}

export function removeTask(dir, taskId) {
  const p = taskPath(dir, taskId)
  if (existsSync(p)) rmSync(p, { force: true })
}

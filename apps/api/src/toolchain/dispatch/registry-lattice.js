/**
 * REG-LATTICE-001 — case / task / job / work-item registry lattice.
 *
 * One lattice, four tiers, six legal transitions:
 *
 *   case <──promote (select exactly one option)──> task
 *   task <──prioritize (authorize + admit)───────> job
 *   job  <──schedule (bind a slot)───────────────> work-item
 *
 * and the reverse of each. Every transition is fail-closed, appends an immutable
 * history entry, and never destroys the source record's identity.
 *
 * Composition, not duplication: the case<->task pair delegates to
 * `./case-task-lifecycle.js` (SP-009), which remains the owner of those rules.
 *
 * Naming divergence (recorded, not resolved here): `schemas/work-item.schema.json`
 * already describes a Work Item as an assigned/authorized unit, and
 * `case-task-lifecycle.createWorkItem` uses the phrase "work item" for the
 * case|task object. This module uses "work-item" strictly for the scheduled
 * (slot-bound) tier described by that schema.
 *
 * This module is pure: no filesystem or database access.
 */
import { promoteCaseToTask, demoteTaskToCase } from './case-task-lifecycle.js'

export const TIERS = Object.freeze({
  CASE: 'case',
  TASK: 'task',
  JOB: 'job',
  WORK_ITEM: 'work-item'
})

/** authority: true means the transition grants execution power and needs an authorization ref. */
export const TRANSITIONS = Object.freeze({
  'case>task': { authority: false },
  'task>case': { authority: false },
  'task>job': { authority: true },
  'job>task': { authority: false },
  'job>work-item': { authority: true },
  'work-item>job': { authority: false }
})

/** Source states from which a transition is legal. Absent state = not checked. */
const LEGAL_SOURCE_STATES = Object.freeze({
  'case>task': Object.freeze(['open_case']),
  'task>case': Object.freeze(['queued']),
  'task>job': Object.freeze(['queued']),
  'job>task': Object.freeze(['queued']),
  'job>work-item': Object.freeze(['queued']),
  'work-item>job': Object.freeze(['PENDING', 'ASSIGNED', 'BLOCKED'])
})

function nowIso() {
  return new Date().toISOString()
}

function transitionKey(fromTier, toTier) {
  return `${fromTier}>${toTier}`
}

/**
 * Fail-closed gate for every transition. Throws on an unknown tier, an illegal
 * pairing, a source state that may not move, or a missing authorization ref.
 */
export function assertLegalTransition(fromTier, toTier, record, ctx = {}) {
  if (!Object.values(TIERS).includes(fromTier)) throw new Error(`unknown_tier:${fromTier}`)
  if (!Object.values(TIERS).includes(toTier)) throw new Error(`unknown_tier:${toTier}`)
  const key = transitionKey(fromTier, toTier)
  const rule = TRANSITIONS[key]
  if (!rule) throw new Error(`illegal_transition:${key}`)

  const legalStates = LEGAL_SOURCE_STATES[key]
  const sourceState = record?.state ?? record?.status
  if (legalStates && sourceState !== undefined && !legalStates.includes(sourceState)) {
    throw new Error(`illegal_source_state:${key}:${sourceState}`)
  }

  if (rule.authority && !String(ctx.authorizationRef || '').trim()) {
    throw new Error(`transition_requires_authorization_ref:${key}`)
  }
  return true
}

/**
 * case -> task: select exactly one option. Owned by SP-009 (`case-task-lifecycle`), which
 * validates the source kind and the option id; this wrapper only adds lattice context.
 */
export function promoteCaseToTaskRecord(item, optionId, ctx = {}) {
  return promoteCaseToTask(item, optionId, { reason: ctx.reason || null })
}

/** task -> case: the work resolved to two or more viable options. Owned by SP-009. */
export function demoteTaskToCaseRecord(item, newOptions, ctx = {}) {
  return demoteTaskToCase(item, newOptions, { reason: ctx.reason || null })
}

function defaultJobPlan() {
  return [{ type: 'plan', status: 'pending' }]
}

/**
 * task -> job: admit an authorized board task into the job registry at a priority,
 * carrying an explicit job plan. Requires an authorization reference.
 */
export function prioritizeTaskAsJob(task, {
  priority = 'P2',
  jobPlan = null,
  authorizationRef = null,
  jobId = null,
  reason = null
} = {}) {
  assertLegalTransition(TIERS.TASK, TIERS.JOB, task, { authorizationRef })
  const taskId = task?.taskId ?? task?.id
  if (taskId === undefined || taskId === null) throw new Error('prioritize_requires_task_id')
  return {
    jobId: jobId || `JOB-${taskId}`,
    taskId,
    title: task.title ?? null,
    priority,
    state: 'queued',
    jobPlan: Array.isArray(jobPlan) ? jobPlan : defaultJobPlan(),
    originTier: TIERS.TASK,
    originId: String(taskId),
    authorizationRef: String(authorizationRef),
    history: [{
      event: 'promoted_to_job',
      sourceTaskId: String(taskId),
      reason: reason || null,
      at: nowIso()
    }]
  }
}

/**
 * job -> task: withdraw a queued job from the registry. The board task is untouched;
 * the returned descriptor points back at the job so nothing is lost.
 */
export function deprioritizeJobAsTask(job, ctx = {}) {
  assertLegalTransition(TIERS.JOB, TIERS.TASK, job, ctx)
  return {
    kind: TIERS.TASK,
    id: job.taskId,
    title: job.title ?? null,
    state: 'queued',
    parentJobId: job.jobId ?? null,
    parentCaseId: job.parentCaseId ?? null,
    history: [{
      event: 'demoted_to_task',
      jobState: 'deprioritized',
      reason: ctx.reason || null,
      at: nowIso()
    }]
  }
}

/**
 * job -> work-item: bind a queued job to a concrete slot/run/worker. The resulting
 * record carries the core fields of `schemas/work-item.schema.json`; scheduling-only
 * fields (`slotRef`, `runRef`, `scheduledAt`) live beside them.
 */
export function scheduleJobAsWorkItem(job, {
  slotRef = null,
  runRef = null,
  workerId = null,
  sessionId = null,
  quotaPool = null,
  authorizationRef = null,
  policyVersion = 'swarm-plan-v1',
  reason = null
} = {}) {
  assertLegalTransition(TIERS.JOB, TIERS.WORK_ITEM, job, { authorizationRef })
  if (!slotRef) throw new Error(`schedule_requires_slot:${job?.jobId}`)
  const now = nowIso()
  return {
    workItemId: `WI-${job.jobId}`,
    jobId: job.jobId,
    taskId: job.taskId,
    title: job.title ?? null,
    status: 'ASSIGNED',
    origin: 'job-registry',
    assignedParent: workerId ?? null,
    assignedSiblings: [],
    policyVersion,
    authorizationRef: String(authorizationRef),
    mutationClass: 'REVERSIBLE_MUTATE',
    scope: [],
    sessionId: sessionId ?? null,
    quotaPool: quotaPool ?? null,
    slotRef,
    runRef: runRef ?? null,
    scheduledAt: now,
    createdAt: now,
    updatedAt: now,
    history: [{
      event: 'scheduled_from_job',
      jobState: 'queued',
      slotRef,
      reason: reason || null,
      at: now
    }]
  }
}

/** work-item -> job: release the slot and return the job to the queued registry tier. */
export function descheduleWorkItemAsJob(workItem, ctx = {}) {
  assertLegalTransition(TIERS.WORK_ITEM, TIERS.JOB, workItem, ctx)
  const now = nowIso()
  const releasedSlotRef = workItem.slotRef ?? null
  return {
    jobId: workItem.jobId,
    taskId: workItem.taskId,
    title: workItem.title ?? null,
    priority: workItem.priority ?? 'P2',
    state: 'queued',
    jobPlan: Array.isArray(workItem.jobPlan) ? workItem.jobPlan : [],
    originTier: TIERS.WORK_ITEM,
    originId: workItem.workItemId ?? null,
    authorizationRef: workItem.authorizationRef ?? null,
    slotRef: null,
    runRef: null,
    releasedSlotRef,
    history: [{
      event: 'descheduled_to_job',
      releasedSlotRef,
      reason: ctx.reason || null,
      at: now
    }]
  }
}

/** Ordered, immutable history projection for a record. */
export function transitionLog(record) {
  return Array.isArray(record?.history) ? [...record.history] : []
}

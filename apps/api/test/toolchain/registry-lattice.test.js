import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TIERS,
  TRANSITIONS,
  assertLegalTransition,
  promoteCaseToTaskRecord,
  demoteTaskToCaseRecord,
  prioritizeTaskAsJob,
  deprioritizeJobAsTask,
  scheduleJobAsWorkItem,
  descheduleWorkItemAsJob
} from '../../src/toolchain/dispatch/registry-lattice.js'
import { createWorkItem } from '../../src/toolchain/dispatch/case-task-lifecycle.js'

function caseItem(over = {}) {
  return {
    ...createWorkItem({ id: 'CASE-1', title: 'Pick an approach', options: ['a', 'b'] }),
    ...over
  }
}

function taskItem(over = {}) {
  return {
    ...createWorkItem({ id: 'TASK-1', title: 'Do the work', options: ['a'] }),
    ...over
  }
}

function jobRecord(over = {}) {
  return {
    jobId: 'JOB-1',
    taskId: 'TASK-1',
    title: 'Do the work',
    priority: 'P1',
    state: 'queued',
    jobPlan: [{ type: 'plan', status: 'pending' }],
    originTier: 'task',
    originId: 'TASK-1',
    authorizationRef: 'authz-1',
    history: [{ event: 'promoted_from_task', at: '2026-11-25T00:00:00.000Z' }],
    ...over
  }
}

test('negative: illegal transitions are refused before any state changes', () => {
  assert.throws(() => assertLegalTransition('task', 'work-item', taskItem()), /illegal_transition:task>work-item/)
  assert.throws(() => assertLegalTransition('nonsense', 'task', {}), /unknown_tier/)
  assert.equal(TRANSITIONS['case>task'].authority, false)
  assert.equal(TRANSITIONS['task>job'].authority, true)
})

test('negative: promoting a case with an unknown option fails closed', () => {
  assert.throws(() => promoteCaseToTaskRecord(caseItem(), 'nope'), /invalid_case_option:CASE-1:nope/)
})

test('negative: a non-case cannot be promoted', () => {
  assert.throws(() => promoteCaseToTaskRecord(taskItem(), 'a'), /cannot_promote_non_case:TASK-1:task/)
})

test('case -> task promotes exactly one option and records history', () => {
  const promoted = promoteCaseToTaskRecord(caseItem(), 'opt-1', { reason: 'operator picked' })
  assert.equal(promoted.kind, 'task')
  assert.equal(promoted.state, 'queued')
  assert.equal(promoted.selectedOption.id, 'opt-1')
  assert.equal(promoted.parentCaseId, 'CASE-1')
  const last = promoted.history[promoted.history.length - 1]
  assert.equal(last.event, 'promoted_to_task')
  assert.equal(last.optionId, 'opt-1')
  assert.equal(last.reason, 'operator picked')
})

test('negative: demoting a task with fewer than two options fails closed', () => {
  assert.throws(() => demoteTaskToCaseRecord(taskItem(), ['only-one']), /demote_requires_multiple_options:TASK-1:1/)
})

test('negative: a non-task cannot be demoted', () => {
  assert.throws(() => demoteTaskToCaseRecord(caseItem(), ['a', 'b']), /cannot_demote_non_task:CASE-1:case/)
})

test('task -> case demotes and preserves the origin task', () => {
  const demoted = demoteTaskToCaseRecord(taskItem(), ['a', 'b'], { reason: 'split discovered' })
  assert.equal(demoted.kind, 'case')
  assert.equal(demoted.state, 'open_case')
  assert.equal(demoted.selectedOption, null)
  assert.equal(demoted.options.length, 2)
  assert.equal(demoted.history[demoted.history.length - 1].event, 'demoted_to_case')
})

test('negative: prioritizing a task without an authorization reference fails closed', () => {
  assert.throws(
    () => prioritizeTaskAsJob(taskItem(), { priority: 'P1' }),
    /transition_requires_authorization_ref:task>job/
  )
})

test('negative: a task that is not queued cannot be prioritized', () => {
  assert.throws(
    () => prioritizeTaskAsJob(taskItem({ state: 'done' }), { authorizationRef: 'authz-1' }),
    /illegal_source_state:task>job:done/
  )
})

test('task -> job admits a queued job carrying the task identity and job plan', () => {
  const job = prioritizeTaskAsJob(taskItem(), {
    priority: 'P0',
    jobPlan: [
      { type: 'plan', status: 'pending' },
      { type: 'build', status: 'pending' }
    ],
    authorizationRef: 'authz-42',
    jobId: 'JOB-9',
    reason: 'operator prioritized'
  })
  assert.equal(TIERS.JOB, 'job')
  assert.equal(job.jobId, 'JOB-9')
  assert.equal(job.taskId, 'TASK-1')
  assert.equal(job.title, 'Do the work')
  assert.equal(job.state, 'queued')
  assert.equal(job.priority, 'P0')
  assert.equal(job.jobPlan.length, 2)
  assert.equal(job.originTier, 'task')
  assert.equal(job.authorizationRef, 'authz-42')
  const last = job.history[job.history.length - 1]
  assert.equal(last.event, 'promoted_to_job')
  assert.equal(last.sourceTaskId, 'TASK-1')
})

test('negative: de-prioritizing a job that already left the queue fails closed', () => {
  assert.throws(
    () => deprioritizeJobAsTask(jobRecord({ state: 'deprioritized' }), {}),
    /illegal_source_state:job>task:deprioritized/
  )
})

test('job -> task de-prioritizes without destroying the board task', () => {
  const out = deprioritizeJobAsTask(jobRecord(), { reason: 'deferred' })
  assert.equal(out.kind, 'task')
  assert.equal(out.id, 'TASK-1')
  assert.equal(out.title, 'Do the work')
  assert.equal(out.state, 'queued')
  assert.equal(out.parentJobId, 'JOB-1')
  const last = out.history[out.history.length - 1]
  assert.equal(last.event, 'demoted_to_task')
  assert.equal(last.jobState, 'deprioritized')
})

test('negative: scheduling a job requires a slot and an authorization reference', () => {
  assert.throws(
    () => scheduleJobAsWorkItem(jobRecord(), { authorizationRef: 'authz-1' }),
    /schedule_requires_slot:JOB-1/
  )
  assert.throws(
    () => scheduleJobAsWorkItem(jobRecord(), { slotRef: 'slot-1' }),
    /transition_requires_authorization_ref:job>work-item/
  )
})

test('job -> work-item binds a slot and aligns to the work-item schema core', () => {
  const wi = scheduleJobAsWorkItem(jobRecord(), {
    slotRef: 'slot-7',
    runRef: 'run-7',
    workerId: 'hermes',
    sessionId: 'sess-1',
    quotaPool: 'nous-hermes-free',
    authorizationRef: 'authz-1',
    policyVersion: 'swarm-plan-v1'
  })
  assert.equal(wi.workItemId, 'WI-JOB-1')
  assert.equal(wi.jobId, 'JOB-1')
  assert.equal(wi.taskId, 'TASK-1')
  assert.equal(wi.status, 'ASSIGNED')
  assert.equal(wi.origin, 'job-registry')
  assert.equal(wi.slotRef, 'slot-7')
  assert.equal(wi.runRef, 'run-7')
  assert.equal(wi.sessionId, 'sess-1')
  assert.equal(wi.quotaPool, 'nous-hermes-free')
  assert.equal(wi.policyVersion, 'swarm-plan-v1')
  assert.ok(wi.scheduledAt)
  // Required by schemas/work-item.schema.json
  for (const field of ['workItemId', 'status', 'origin', 'policyVersion', 'authorizationRef', 'createdAt']) {
    assert.ok(field in wi, `missing schema field ${field}`)
  }
  assert.deepEqual(wi.assignedSiblings, [])
  assert.equal(wi.mutationClass, 'REVERSIBLE_MUTATE')
})

test('negative: a terminal work-item cannot be de-scheduled', () => {
  const wi = { ...scheduleJobAsWorkItem(jobRecord(), { slotRef: 's', authorizationRef: 'a' }), status: 'COMPLETED' }
  assert.throws(() => descheduleWorkItemAsJob(wi, {}), /illegal_source_state:work-item>job:COMPLETED/)
})

test('work-item -> job de-schedules, releases the slot and returns the job to queued', () => {
  const wi = scheduleJobAsWorkItem(jobRecord(), {
    slotRef: 'slot-7', runRef: 'run-7', authorizationRef: 'authz-1', sessionId: 'sess-1'
  })
  const job = descheduleWorkItemAsJob(wi, { reason: 'slot pre-empted' })
  assert.equal(job.jobId, 'JOB-1')
  assert.equal(job.state, 'queued')
  assert.equal(job.slotRef, null)
  assert.equal(job.releasedSlotRef, 'slot-7')
  assert.equal(job.originTier, 'work-item')
  assert.equal(job.history[job.history.length - 1].event, 'descheduled_to_job')
  assert.equal(job.history[job.history.length - 1].releasedSlotRef, 'slot-7')
})

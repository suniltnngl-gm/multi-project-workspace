/**
 * REG-PIPE-001 (#210) — self-healing delivery pipeline stage machine.
 *
 * Maps the W1..W5 gate chain onto deterministic stage verdicts and bounded loop-backs,
 * and owns the adjacent-tier demotion rule: when replanCount or rebuildCount exceeds its
 * bound, the Work-Item walks DOWN one tier at a time (Work-Item -> Job -> Task -> Case).
 * There is deliberately NO direct Work-Item -> Case shortcut: every tier keeps its ledger
 * and its audit entry.
 *
 * Pure module: transitions come from ./registry-lattice.js, verdicts from
 * ./plan-binding.js, the dirty-tree guard from ./worktree-quarantine.js.
 */
import {
  descheduleWorkItemAsJob,
  deprioritizeJobAsTask,
  demoteTaskToCaseRecord
} from './registry-lattice.js'
import { verifyPlanBinding } from './plan-binding.js'
import { readFileSync as defaultReadFileSync } from 'node:fs'
import { appendLifecycleTransition } from './lifecycle-audit.js'

export { appendLifecycleTransition }

export const STAGE_VERDICTS = Object.freeze({
  PLAN_APPROVE: 'APPROVE_BUILD',
  PLAN_REPLAN: 'REPLAN',
  BUILD_STAGE: 'STAGE_READY',
  BUILD_REBUILD: 'REBUILD',
  CI_VERIFIED: 'CI_VERIFIED',
  CI_FAILED: 'CI_FAILED'
})

export const DEFAULT_MAX_REPLANS = 2
export const DEFAULT_MAX_REBUILDS = 2

/** Ordered adjacent-tier demotion. Index order IS the execution order. */
export const ADJACENT_DEMOTION_HOPS = Object.freeze([
  { from: 'work-item', to: 'job', apply: 'descheduleWorkItemAsJob' },
  { from: 'job', to: 'task', apply: 'deprioritizeJobAsTask' },
  { from: 'task', to: 'case', apply: 'demoteTaskToCase' }
])

/**
 * Record a REPLAN attempt. Returns `{ action: 'replan', replanCount }` while within budget
 * and `{ action: 'demote', reason: 'max_replans_exceeded', replanCount }` once exceeded.
 */
export function recordReplanAttempt(workItem, { maxReplans = DEFAULT_MAX_REPLANS } = {}) {
  const used = Number(workItem?.replanCount) || 0
  const next = used + 1
  if (next > Number(maxReplans)) {
    return { action: 'demote', reason: 'max_replans_exceeded', replanCount: used, maxReplans: Number(maxReplans) }
  }
  return { action: 'replan', replanCount: next, maxReplans: Number(maxReplans) }
}

/** Same contract for REBUILD. */
export function recordRebuildAttempt(workItem, { maxRebuilds = DEFAULT_MAX_REBUILDS } = {}) {
  const used = Number(workItem?.rebuildCount) || 0
  const next = used + 1
  if (next > Number(maxRebuilds)) {
    return { action: 'demote', reason: 'max_rebuilds_exceeded', rebuildCount: used, maxRebuilds: Number(maxRebuilds) }
  }
  return { action: 'rebuild', rebuildCount: next, maxRebuilds: Number(maxRebuilds) }
}

/**
 * Walk the adjacent tiers. Each hop is applied in order and appended to the returned trail;
 * an illegal hop (wrong source kind/state, bad options) throws and stops the walk, so a
 * half-demoted item is visible rather than silently skipped.
 */
export function adjacentTierDemotion({ workItem, options = null, ctx = {} }) {
  const trail = []
  if (!workItem || workItem.workItemId === undefined || workItem.jobId === undefined) {
    throw new Error('demotion_requires_work_item')
  }

  // Hop 1: Work-Item -> Job (slot released, job back to queued).
  const asJob = descheduleWorkItemAsJob(workItem, { ...ctx, reason: ctx.reason || 'max_replans_exceeded' })
  trail.push({ hop: 'work-item>job', ok: true, jobId: asJob.jobId })

  // Hop 2: Job -> Task (board task untouched; descriptor points back at the job).
  const asTask = deprioritizeJobAsTask(asJob, { ...ctx, reason: ctx.reason || 'max_replans_exceeded' })
  trail.push({ hop: 'job>task', ok: true, taskId: asTask.id ?? asTask.taskId })

  // Hop 3: Task -> Case (only legal with two or more viable options).
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(`demote_requires_multiple_options:${asTask?.id ?? 'unknown'}:${Array.isArray(options) ? options.length : 0}`)
  }
  const asCase = demoteTaskToCaseRecord(asTask, options, { ...ctx, reason: ctx.reason || 'max_replans_exceeded' })
  trail.push({ hop: 'task>case', ok: true, caseId: asCase.id })

  return { ok: true, trail, job: asJob, task: asTask, case: asCase }
}

/**
 * W2 verdict handler (#213). Within budget: bump replanCount and planRevision so any plan
 * artifact carrying the old revision is rejected by verifyPlanBinding. Over budget: walk
 * the adjacent tiers into a Case instead of looping back.
 */
export function applyReplanVerdict({ workItem, caseOptions = null, ctx = {}, persist = null, auditDir = null }) {
  const attempt = recordReplanAttempt(workItem)
  if (attempt.action === 'replan') {
    const nextPlanRevision = (Number(workItem?.currentPlanRevision) || 0) + 1
    const updated = typeof persist === 'function'
      ? persist({ ...workItem, replanCount: attempt.replanCount, currentPlanRevision: nextPlanRevision })
      : { ...workItem, replanCount: attempt.replanCount, currentPlanRevision: nextPlanRevision }
    if (auditDir) appendLifecycleTransition(auditDir, {
      event: 'plan_replan', workItemId: workItem.workItemId,
      replanCount: attempt.replanCount, planRevision: nextPlanRevision
    })
    return { ok: true, action: 'replan', replanCount: attempt.replanCount, nextPlanRevision, workItem: updated }
  }
  const demotion = adjacentTierDemotion({ workItem, options: caseOptions, ctx })
  if (auditDir) appendLifecycleTransition(auditDir, {
    event: 'demoted_to_case', workItemId: workItem.workItemId, reason: attempt.reason,
    trail: demotion.trail.map((t) => t.hop)
  })
  return { ok: true, action: 'demoted_to_case', reason: attempt.reason, trail: demotion.trail, case: demotion.case }
}

/** W4 verdict handler (#213). Same contract with rebuildCount. */
export function applyRebuildVerdict({ workItem, caseOptions = null, ctx = {}, persist = null, auditDir = null }) {
  const attempt = recordRebuildAttempt(workItem)
  if (attempt.action === 'rebuild') {
    const updated = typeof persist === 'function'
      ? persist({ ...workItem, rebuildCount: attempt.rebuildCount })
      : { ...workItem, rebuildCount: attempt.rebuildCount }
    if (auditDir) appendLifecycleTransition(auditDir, {
      event: 'build_rebuild', workItemId: workItem.workItemId, rebuildCount: attempt.rebuildCount
    })
    return { ok: true, action: 'rebuild', rebuildCount: attempt.rebuildCount, workItem: updated }
  }
  const demotion = adjacentTierDemotion({ workItem, options: caseOptions, ctx })
  if (auditDir) appendLifecycleTransition(auditDir, {
    event: 'demoted_to_case', workItemId: workItem.workItemId, reason: attempt.reason,
    trail: demotion.trail.map((t) => t.hop)
  })
  return { ok: true, action: 'demoted_to_case', reason: attempt.reason, trail: demotion.trail, case: demotion.case }
}

/**
 * Pre-build guard: prove the plan is still current, then ensure the tree is safe to edit.
 * Fail-closed. `quarantine` is injectable for tests.
 */
export function preBuildGuard({
  repoDir,
  workItemId = null,
  planPath = null,
  workItem = null,
  headSha = null,
  backupRoot = null,
  allowRestore = false,
  quarantine = null,
  auditDir = null,
  readFile = defaultReadFileSync
} = {}) {
  if (planPath && workItem) {
    let plan = null
    try {
      plan = JSON.parse(readFile(planPath, 'utf8'))
    } catch (err) {
      return { ok: false, reason: 'plan_unreadable', detail: String(err?.message || err) }
    }
    const binding = verifyPlanBinding({ plan, workItem, headSha, auditDir })
    if (!binding.ok) return { ok: false, reason: binding.reason, detail: binding }
  }

  if (!quarantine) return { ok: true, reason: 'no_quarantine_fn', quarantined: [] }
  const q = quarantine({
    repoDir,
    workItemId,
    activeLease: false,
    allowRestore,
    backupRoot,
    // A relay run owns everything it has already written this round; only leftovers from
    // an aborted earlier turn are orphans.
    isOwned: () => false
  })
  if (!q.ok) return { ok: false, reason: q.reason, detail: q, quarantined: [] }
  return { ok: true, reason: q.reason, quarantined: q.quarantined, restored: Boolean(q.restored) }
}

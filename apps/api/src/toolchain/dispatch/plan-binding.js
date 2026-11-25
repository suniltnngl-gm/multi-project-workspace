/**
 * SPLIT-BRAIN GUARD (#212) — monotonic plan revision binding.
 *
 * Stale-plan execution is a generation-drift split brain: a build window runs on the
 * assumptions of Plan v1 while replan already moved the Work-Item to v2. Every plan
 * artifact therefore carries `planRevision` and the `baseHeadSha` it was written
 * against, and a build window must prove both still hold before it edits anything.
 *
 * Pure module: no filesystem or git access.
 */

export const PLAN_BINDING_SCHEMA = 'swarm-build-plan/v1'

/**
 * Build a plan artifact record. `planRevision` is the caller's responsibility to make
 * monotonic; `nextPlanRevision` is the helper for that.
 */
export function createPlanRecord({
  workItemId,
  planRevision,
  baseHeadSha,
  allowlist = [],
  testTargets = [],
  acceptance = []
} = {}) {
  if (!workItemId) throw new Error('work_item_id_required')
  const rev = Number(planRevision)
  if (!Number.isInteger(rev) || rev < 1) throw new Error(`plan_revision_invalid:${planRevision}`)
  if (!String(baseHeadSha || '').trim()) throw new Error('base_head_sha_required')
  return {
    schema: PLAN_BINDING_SCHEMA,
    workItemId: String(workItemId),
    planRevision: rev,
    baseHeadSha: String(baseHeadSha),
    allowlist: [...allowlist],
    testTargets: [...testTargets],
    acceptance: [...acceptance],
    createdAt: new Date().toISOString()
  }
}

/** Next monotonic revision for a work-item (absent/0 means this is rev 1). */
export function nextPlanRevision(workItem) {
  const current = Number(workItem?.currentPlanRevision) || 0
  return current + 1
}

/**
 * Gate a build/rebuild window. Returns { ok: true } or
 * { ok: false, reason: 'missing_plan_binding' | 'stale_plan_revision' | 'stale_base_head' }.
 */
export function verifyPlanBinding({ plan, workItem = null, headSha = null } = {}) {
  if (!plan || plan.schema !== PLAN_BINDING_SCHEMA) {
    return { ok: false, reason: 'missing_plan_binding' }
  }
  const expectedRev = Number(workItem?.currentPlanRevision) || 0
  if (expectedRev === 0) return { ok: false, reason: 'missing_plan_binding', detail: 'work_item_has_no_current_plan_revision' }
  if (Number(plan.planRevision) !== expectedRev) {
    return {
      ok: false,
      reason: 'stale_plan_revision',
      planRevision: Number(plan.planRevision),
      currentPlanRevision: expectedRev
    }
  }
  if (headSha !== null && String(plan.baseHeadSha) !== String(headSha)) {
    return { ok: false, reason: 'stale_base_head', planBaseHeadSha: plan.baseHeadSha, headSha: String(headSha) }
  }
  return { ok: true, planRevision: expectedRev, baseHeadSha: String(plan.baseHeadSha) }
}

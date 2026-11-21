/** Normalize the frozen SP-003 v1.1 planner contract for the SP-004 executor. */
export function normalizeExecutionRequest(plannerPlan, { prompt, cwd } = {}) {
  if (!plannerPlan || typeof plannerPlan !== 'object' || Array.isArray(plannerPlan)) throw new TypeError('planner plan must be an object')
  if (plannerPlan.schemaVersion !== 'session-pool-dispatch/v1.1') throw new TypeError(`unsupported planner schemaVersion: ${plannerPlan.schemaVersion}`)
  if (plannerPlan.mode !== 'plan' || plannerPlan.readOnly !== true) throw new TypeError('planner contract must be read-only mode=plan')
  if (plannerPlan.cliArtifactBoundary?.mergeNativeArtifacts !== false) throw new TypeError('planner artifact boundary must prohibit native artifact merging')
  const action = plannerPlan.action
  if (['blocked', 'deferred', 'await_in_flight'].includes(action)) {
    return { executable: false, record: { idempotencyKey: plannerPlan.idempotencyKey ?? null, decidedAt: plannerPlan.decidedAt, action, outcome: action, cliArtifactBoundary: { mergeNativeArtifacts: false }, reason: (plannerPlan.reasons || []).join('; ') || action, nextEligibleAt: plannerPlan.nextEligibleAt ?? null, exitCode: action === 'blocked' ? 2 : 3, signal: null, durationMs: null } }
  }
  if (!['reuse_session', 'create_session'].includes(action)) throw new TypeError(`unsupported planner action: ${action}`)
  const selected = plannerPlan.selectedSession
  if (!selected || typeof selected !== 'object') throw new TypeError('executable planner action requires selectedSession')
  if (typeof selected.cli !== 'string' || !selected.cli || typeof selected.model !== 'string' || !selected.model) throw new TypeError('selectedSession requires cli and model')
  if (!plannerPlan.idempotencyKey || typeof plannerPlan.idempotencyKey !== 'string') throw new TypeError('executable planner plan requires a non-null idempotencyKey')
  if (selected.lease && (selected.lease.holder !== plannerPlan.idempotencyKey || selected.lease.compositeKey !== selected.compositeKey || !Number.isSafeInteger(selected.lease.ttlMs) || selected.lease.ttlMs <= 0)) throw new TypeError('planner lease intent is invalid')
  if (selected.compositeKey && !selected.lease) throw new TypeError('selected session compositeKey requires planner lease intent')
  return {
    executable: true,
    plan: {
      schemaVersion: 'v1.1', decidedAt: plannerPlan.decidedAt, idempotencyKey: plannerPlan.idempotencyKey,
      action, compositeKey: selected.compositeKey, sessionId: selected.sessionId, cli: selected.cli,
      model: selected.model, provider: selected.provider, prompt, cwd,
      leaseTtlMs: selected.lease?.ttlMs,
      cliArtifactBoundary: { mergeNativeArtifacts: false }
    }
  }
}

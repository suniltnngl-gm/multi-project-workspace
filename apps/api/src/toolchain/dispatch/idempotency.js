import { createHash } from 'node:crypto'
import { parseIsoStrict } from './portability.js'

/** Model/session/pool are deliberately excluded so a fallback retry keeps the same key. */
export function deriveIdempotencyKey({ workItem, role, repository, attemptScope = 'default' } = {}) {
  if (workItem === undefined || workItem === null || String(workItem) === '') return null
  return createHash('sha256')
    .update([workItem, role ?? '', repository ?? '', attemptScope ?? 'default'].map(String).join('\u0000'))
    .digest('hex')
}

/**
 * Outcome precedence for entries sharing a key:
 * running+live lease -> await; succeeded -> completed (unless forceRetry); running+expired -> expired_retry;
 * failed -> failed; else none.
 */
export function evaluateInFlight(inFlight = [], idempotencyKey, nowMs, { forceRetry = false } = {}) {
  const mine = idempotencyKey ? (Array.isArray(inFlight) ? inFlight : []).filter((e) => e?.idempotencyKey === idempotencyKey) : []
  const failedCompositeKeys = new Set(mine.filter((e) => e.status === 'failed' && e.compositeKey).map((e) => String(e.compositeKey)))
  const leaseMs = (e) => parseIsoStrict(e.leaseExpiresAt)
  const live = mine.find((e) => e.status === 'running' && (leaseMs(e) ?? 0) > nowMs)
  if (live) return { outcome: 'await', entry: live, nextEligibleAtMs: leaseMs(live), reasons: [`await_in_flight:${idempotencyKey}`], failedCompositeKeys }
  if (!forceRetry && mine.some((e) => e.status === 'succeeded')) {
    return { outcome: 'completed', entry: null, nextEligibleAtMs: null, reasons: [`already_completed:${idempotencyKey}`], failedCompositeKeys }
  }
  if (mine.some((e) => e.status === 'running')) {
    return { outcome: 'expired_retry', entry: null, nextEligibleAtMs: null, reasons: ['in_flight_lease_expired', 'verify_worktree_before_retry'], failedCompositeKeys }
  }
  if (failedCompositeKeys.size) return { outcome: 'failed', entry: null, nextEligibleAtMs: null, reasons: [], failedCompositeKeys }
  return { outcome: 'none', entry: null, nextEligibleAtMs: null, reasons: [], failedCompositeKeys }
}

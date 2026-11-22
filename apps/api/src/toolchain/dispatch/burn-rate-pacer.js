/**
 * SP-008: Quota Burn-Rate Pacer.
 *
 * Paces resetting quota pools (5h / daily / weekly / monthly) so available quota is
 * utilized smoothly before reset without running dry early, while keeping
 * rate-limit-only endpoints governed solely by endpoint concurrency and 429 cooldowns.
 *
 * Pure and deterministic: all clock values are injected via `nowMs`.
 */
import { parseIsoStrict } from './portability.js'

export const WINDOW_DURATION_MS = Object.freeze({
  '5h': 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
})

export const DEFAULT_SAFETY_RESERVE = 0.05
export const DEFAULT_BOOST_WINDOW_FRACTION = 0.2
export const DEFAULT_BOOST_MIN_REMAINING_PCT = 30

const PACE_RANK = Object.freeze({
  boost: 0,
  normal: 1,
  rate_limit_only: 1,
  throttled: 2,
  cooldown: 3,
  exhausted: 4
})

function toMs(iso) {
  if (!iso) return null
  if (typeof iso === 'number' && Number.isFinite(iso)) return iso
  const parsed = parseIsoStrict(iso)
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  return parsed?.ok && Number.isFinite(parsed.ms) ? parsed.ms : null
}

/**
 * Evaluate pacing state for a single quota pool.
 *
 * @param {object} pool
 * @param {string} pool.quotaPool
 * @param {'5h'|'daily'|'weekly'|'monthly'|'rate_limit_only'} [pool.cadence='rate_limit_only']
 * @param {number|null} [pool.remainingPct] - 0..100 for resetting pools
 * @param {string|number|null} [pool.resetAt] - ISO-8601 (with offset) or epoch ms
 * @param {number} [pool.observedBurnRatePerHour=0] - pct points burned per hour
 * @param {number} [pool.activeConcurrency=0]
 * @param {number} [pool.maxConcurrency=1]
 * @param {string|number|null} [pool.cooldownUntil]
 * @param {number} [nowMs=Date.now()]
 * @param {object} [opts]
 */
export function evaluatePoolPacing(pool, nowMs = Date.now(), opts = {}) {
  const safetyReserve = opts.safetyReserve ?? DEFAULT_SAFETY_RESERVE
  const boostWindowFraction = opts.boostWindowFraction ?? DEFAULT_BOOST_WINDOW_FRACTION
  const boostMinRemainingPct = opts.boostMinRemainingPct ?? DEFAULT_BOOST_MIN_REMAINING_PCT
  const cadence = pool?.cadence || 'rate_limit_only'
  const quotaPool = String(pool?.quotaPool || 'unknown')

  const cooldownMs = toMs(pool?.cooldownUntil)
  if (cooldownMs !== null && cooldownMs > nowMs) {
    return {
      quotaPool,
      cadence,
      verdict: 'cooldown',
      admitted: false,
      allowedRatePerHour: null,
      nextEligibleAt: new Date(cooldownMs).toISOString(),
      reason: 'endpoint_cooldown_active'
    }
  }

  const active = Number(pool?.activeConcurrency || 0)
  const maxConc = Number(pool?.maxConcurrency ?? 1)
  if (active >= maxConc) {
    return {
      quotaPool,
      cadence,
      verdict: 'throttled',
      admitted: false,
      allowedRatePerHour: null,
      nextEligibleAt: null,
      reason: 'endpoint_concurrency_cap_reached'
    }
  }

  // Non-resetting, rate-limit-only endpoints are always available when under concurrency & not cooling down.
  if (cadence === 'rate_limit_only' || !WINDOW_DURATION_MS[cadence]) {
    return {
      quotaPool,
      cadence: 'rate_limit_only',
      verdict: 'rate_limit_only',
      admitted: true,
      allowedRatePerHour: null,
      nextEligibleAt: null,
      reason: 'endpoint_rate_limit_only'
    }
  }

  const remainingPct = pool?.remainingPct
  const resetMs = toMs(pool?.resetAt)

  if (typeof remainingPct === 'number' && remainingPct <= 0) {
    return {
      quotaPool,
      cadence,
      verdict: 'exhausted',
      admitted: false,
      allowedRatePerHour: 0,
      nextEligibleAt: resetMs && resetMs > nowMs ? new Date(resetMs).toISOString() : null,
      reason: 'quota_exhausted_until_reset'
    }
  }

  // If resetAt is missing or already elapsed, treat pool as freshly available.
  if (resetMs === null || resetMs <= nowMs || typeof remainingPct !== 'number') {
    return {
      quotaPool,
      cadence,
      verdict: 'normal',
      admitted: true,
      allowedRatePerHour: null,
      nextEligibleAt: null,
      reason: 'quota_window_unbounded_or_reset'
    }
  }

  const timeUntilResetMs = resetMs - nowMs
  const hoursUntilReset = timeUntilResetMs / (60 * 60 * 1000)
  const usablePct = Math.max(0, remainingPct * (1 - safetyReserve))
  const allowedRatePerHour = Number((usablePct / hoursUntilReset).toFixed(4))
  const observedRate = Number(pool?.observedBurnRatePerHour || 0)

  if (observedRate > allowedRatePerHour) {
    // Smooth backoff: wait until burn rate aligns, capped at 15 min so caller can re-evaluate.
    const ratio = allowedRatePerHour > 0 ? Math.min(observedRate / allowedRatePerHour, 4) : 4
    const deferMs = Math.min(Math.round(ratio * 60 * 1000), 15 * 60 * 1000)
    return {
      quotaPool,
      cadence,
      verdict: 'throttled',
      admitted: false,
      allowedRatePerHour,
      nextEligibleAt: new Date(Math.min(nowMs + deferMs, resetMs)).toISOString(),
      reason: 'burn_rate_exceeds_reset_pace'
    }
  }

  const windowMs = WINDOW_DURATION_MS[cadence]
  const remainingWindowFraction = timeUntilResetMs / windowMs
  if (remainingWindowFraction <= boostWindowFraction && remainingPct >= boostMinRemainingPct) {
    return {
      quotaPool,
      cadence,
      verdict: 'boost',
      admitted: true,
      allowedRatePerHour,
      nextEligibleAt: null,
      reason: 'use_remaining_quota_before_reset'
    }
  }

  return {
    quotaPool,
    cadence,
    verdict: 'normal',
    admitted: true,
    allowedRatePerHour,
    nextEligibleAt: null,
    reason: 'within_reset_pace'
  }
}

/**
 * Rank pools deterministically: boost (use before reset) -> normal/rate_limit_only -> throttled -> cooldown -> exhausted.
 */
export function rankPoolsByPacing(pools, nowMs = Date.now(), opts = {}) {
  return (Array.isArray(pools) ? pools : [])
    .map((p, index) => ({
      ...evaluatePoolPacing(p, nowMs, opts),
      _remaining: typeof p?.remainingPct === 'number' ? p.remainingPct : 50,
      _index: index
    }))
    .sort((a, b) => {
      const ra = PACE_RANK[a.verdict] ?? 9
      const rb = PACE_RANK[b.verdict] ?? 9
      if (ra !== rb) return ra - rb
      if (b._remaining !== a._remaining) return b._remaining - a._remaining
      return a._index - b._index
    })
    .map(({ _remaining, _index, ...rest }) => rest)
}

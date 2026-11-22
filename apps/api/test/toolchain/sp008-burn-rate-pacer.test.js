import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluatePoolPacing,
  rankPoolsByPacing,
  evaluateFiveHourCap,
  evaluateMonthlyDailyBudget,
  WINDOW_DURATION_MS
} from '../../src/toolchain/dispatch/burn-rate-pacer.js'

const NOW = Date.parse('2026-11-22T12:00:00Z')

test('rate-limit-only pool is always admitted when under concurrency and not cooling down', () => {
  const res = evaluatePoolPacing({
    quotaPool: 'cline-free',
    cadence: 'rate_limit_only',
    activeConcurrency: 0,
    maxConcurrency: 1
  }, NOW)
  assert.strictEqual(res.verdict, 'rate_limit_only')
  assert.strictEqual(res.admitted, true)

  const cooling = evaluatePoolPacing({
    quotaPool: 'cline-free',
    cadence: 'rate_limit_only',
    cooldownUntil: '2026-11-22T12:05:00Z'
  }, NOW)
  assert.strictEqual(cooling.verdict, 'cooldown')
  assert.strictEqual(cooling.admitted, false)
  assert.strictEqual(cooling.nextEligibleAt, '2026-11-22T12:05:00.000Z')
})

test('resetting pool throttles when observed burn rate exceeds allowed pace until reset', () => {
  // 20% remaining with 10h left -> usable = 19%, allowedRate = 1.9%/hr. Observed 5%/hr -> throttled.
  const res = evaluatePoolPacing({
    quotaPool: 'agy-gemini',
    cadence: 'weekly',
    remainingPct: 20,
    resetAt: new Date(NOW + 10 * 3600 * 1000).toISOString(),
    observedBurnRatePerHour: 5
  }, NOW)
  assert.strictEqual(res.verdict, 'throttled')
  assert.strictEqual(res.admitted, false)
  assert.strictEqual(res.allowedRatePerHour, 1.9)
  assert.ok(res.nextEligibleAt)
})

test('resetting pool boosts priority when ample quota remains near reset (use-it-or-lose-it)', () => {
  // Daily window: 2h left (<20% of 24h) and 50% remaining -> boost!
  const res = evaluatePoolPacing({
    quotaPool: 'mistral-vibe',
    cadence: 'daily',
    remainingPct: 50,
    resetAt: new Date(NOW + 2 * 3600 * 1000).toISOString(),
    observedBurnRatePerHour: 5
  }, NOW)
  assert.strictEqual(res.verdict, 'boost')
  assert.strictEqual(res.admitted, true)
  assert.strictEqual(res.reason, 'use_remaining_quota_before_reset')
})

test('exhausted resetting pool defers until resetAt', () => {
  const resetIso = new Date(NOW + 48 * 3600 * 1000).toISOString()
  const res = evaluatePoolPacing({
    quotaPool: 'agy-claude-gpt',
    cadence: 'weekly',
    remainingPct: 0,
    resetAt: resetIso
  }, NOW)
  assert.strictEqual(res.verdict, 'exhausted')
  assert.strictEqual(res.admitted, false)
  assert.strictEqual(res.nextEligibleAt, resetIso)
})

test('rankPoolsByPacing orders boost -> normal/rate_limit_only -> throttled -> exhausted', () => {
  const ranked = rankPoolsByPacing([
    { quotaPool: 'agy-claude-gpt', cadence: 'weekly', remainingPct: 0, resetAt: new Date(NOW + WINDOW_DURATION_MS.weekly).toISOString() },
    { quotaPool: 'agy-gemini', cadence: '5h', remainingPct: 10, resetAt: new Date(NOW + 4 * 3600 * 1000).toISOString(), observedBurnRatePerHour: 10 },
    { quotaPool: 'cline-free', cadence: 'rate_limit_only' },
    { quotaPool: 'github-copilot', cadence: 'monthly', remainingPct: 60, resetAt: new Date(NOW + 2 * 24 * 3600 * 1000).toISOString(), observedBurnRatePerHour: 0.5 }
  ], NOW)

  assert.deepStrictEqual(
    ranked.map((r) => [r.quotaPool, r.verdict]),
    [
      ['github-copilot', 'boost'],
      ['cline-free', 'rate_limit_only'],
      ['agy-gemini', 'throttled'],
      ['agy-claude-gpt', 'exhausted']
    ]
  )
})

test('evaluateFiveHourCap enforces copilot=1/5h, agy=4/5h per pool, and uncapped for opencode/daily/local', () => {
  assert.strictEqual(evaluateFiveHourCap({ quotaPool: 'github-copilot', callsInWindow: 0 }).admitted, true)
  assert.strictEqual(evaluateFiveHourCap({ quotaPool: 'github-copilot', callsInWindow: 1 }).admitted, false)

  for (const agyPool of ['agy-gemini', 'agy-argon', 'agy-claude-gpt']) {
    assert.strictEqual(evaluateFiveHourCap({ quotaPool: agyPool, callsInWindow: 3 }).admitted, true)
    assert.strictEqual(evaluateFiveHourCap({ quotaPool: agyPool, callsInWindow: 4 }).admitted, false)
  }

  for (const openPool of ['opencode-tidepool-free', 'opencode-console-google', 'local-llama-cpp', 'cline-free']) {
    const res = evaluateFiveHourCap({ quotaPool: openPool, callsInWindow: 25 })
    assert.strictEqual(res.admitted, true)
    assert.strictEqual(res.cap, null)
  }
})

test('evaluateMonthlyDailyBudget paces 3%/day (90% in 30d + 10% reserve) and falls back to 1/5h when remainingPct is unknown', () => {
  // 15 days left -> floor = 10% + 15*3% = 55%
  const ok = evaluateMonthlyDailyBudget({ remainingPct: 60, daysRemaining: 15 })
  assert.strictEqual(ok.mode, 'daily_pct_budget')
  assert.strictEqual(ok.admitted, true)
  assert.strictEqual(ok.targetFloorPct, 55)

  const throttled = evaluateMonthlyDailyBudget({ remainingPct: 54, daysRemaining: 15 })
  assert.strictEqual(throttled.admitted, false)
  assert.strictEqual(throttled.reason, 'monthly_daily_pct_floor_reached')

  // Unknown remainingPct -> falls back to static 1/5h cap
  const fb0 = evaluateMonthlyDailyBudget({ remainingPct: null, callsIn5hWindow: 0 })
  assert.strictEqual(fb0.mode, 'fallback_5h_cap')
  assert.strictEqual(fb0.admitted, true)
  assert.strictEqual(evaluateMonthlyDailyBudget({ remainingPct: null, callsIn5hWindow: 1 }).admitted, false)
})

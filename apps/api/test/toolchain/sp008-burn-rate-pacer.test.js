import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluatePoolPacing,
  rankPoolsByPacing,
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

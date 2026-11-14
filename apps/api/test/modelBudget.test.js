import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDatabase } from '../src/database.js'
import { createModelBudget } from '../src/modelBudget.js'
import { agyQuotaPoolForScope } from '../src/modelRegistry.js'

const MINUTE = 60000
const HOUR = 60 * MINUTE

function clockAt(iso) {
  let now = Date.parse(iso)
  return {
    now: () => now,
    advance(ms) { now += ms },
    set(iso) { now = Date.parse(iso) }
  }
}

test('legacy daily request limits keep the flat budget shape', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    env: { KAGGLE_AI_MAX_REQUESTS_PER_DAY: '1' },
    now: clock.now
  })

  assert.equal(budget.snapshot('kaggle-3b').window, 'day')
  assert.equal(budget.snapshot('kaggle-3b').limit, 1)
  assert.equal(budget.check('kaggle-3b').ok, true)
  budget.record('kaggle-3b')

  const blocked = budget.check('kaggle-3b')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.budget.remaining, 0)
  assert.equal(blocked.budget.day, '2026-01-15')
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 24 * 60 * 60)

  clock.advance(24 * HOUR)
  assert.equal(budget.check('kaggle-3b').ok, true)
})

test('rolling request windows refill as old events expire', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'requests', limit: 2, window: 'minute', reset: 'rolling' }]
    },
    now: clock.now
  })

  budget.record('api')
  budget.record('api')
  const blocked = budget.check('api')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, 60)
  assert.equal(blocked.budget.remaining, 0)

  clock.advance(MINUTE)
  assert.equal(budget.check('api').ok, true)
})

test('rolling token windows settle provider usage and flag unsupported usage', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'tokens', limit: 100, window: 'minute', reset: 'rolling' }]
    },
    now: clock.now
  })

  budget.recordUsage('api', { promptTokens: 40, completionTokens: 20, totalTokens: 60 })
  assert.equal(budget.snapshot('api').limiters[0].usageSupported, true)
  assert.equal(budget.check('api').ok, true)

  budget.recordUsage('api', { promptTokens: 30, completionTokens: 20, totalTokens: 50 })
  const blocked = budget.check('api')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.budget.used, 110)
  assert.equal(blocked.retryAfter, 60)

  clock.advance(MINUTE)
  assert.equal(budget.check('api').ok, true)

  budget.recordUsage('api', undefined)
  assert.equal(budget.snapshot('api').limiters[0].usageSupported, false)
})

test('session windows are anchored at first use and reset after the window', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'requests', limit: 2, window: 'session', reset: 'fixed', hours: 5 }]
    },
    now: clock.now
  })

  budget.record('api')
  budget.record('api')
  assert.equal(budget.check('api').ok, false)

  clock.advance(4 * HOUR)
  assert.equal(budget.check('api').ok, false)

  clock.advance(HOUR)
  assert.equal(budget.check('api').ok, true)
  assert.equal(budget.snapshot('api').used, 0)
})

test('fixed day windows align to the configured time zone', () => {
  const clock = clockAt('2026-01-15T04:00:00Z') // 23:00 on Jan 14 in New York
  const budget = createModelBudget({
    profiles: {
      api: [{
        unit: 'requests',
        limit: 1,
        window: 'day',
        reset: 'fixed',
        timezone: 'America/New_York'
      }]
    },
    now: clock.now
  })

  assert.equal(budget.snapshot('api').day, '2026-01-14')
  budget.record('api')
  assert.equal(budget.check('api').ok, false)

  clock.set('2026-01-15T04:30:00Z')
  assert.equal(budget.check('api').ok, false)

  clock.set('2026-01-15T05:00:01Z') // 00:00:01 on Jan 15 in New York
  assert.equal(budget.check('api').ok, true)
  assert.equal(budget.snapshot('api').day, '2026-01-15')
})

test('fixed week windows reset on Monday in UTC', () => {
  const clock = clockAt('2026-01-15T12:00:00Z') // Thursday
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'requests', limit: 1, window: 'week', reset: 'fixed', timezone: 'UTC' }]
    },
    now: clock.now
  })

  budget.record('api')
  assert.equal(budget.check('api').ok, false)

  clock.set('2026-01-18T23:59:59Z') // Sunday
  assert.equal(budget.check('api').ok, false)

  clock.set('2026-01-19T00:00:01Z') // Monday
  assert.equal(budget.check('api').ok, true)
})

test('tokens-per-second and tokens-per-minute limiters roll independently', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [
        { policy: 'tps', unit: 'tokens', limit: 1000, window: 'second', reset: 'rolling' },
        { policy: 'tpm', unit: 'tokens', limit: 5000, window: 'minute', reset: 'rolling' },
        { policy: 'rpm', unit: 'requests', limit: 3, window: 'minute', reset: 'rolling' }
      ]
    },
    now: clock.now
  })

  budget.record('api')
  budget.recordUsage('api', { totalTokens: 800 })
  budget.record('api')
  budget.recordUsage('api', { totalTokens: 300 })

  const blocked = budget.check('api')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.budget.limiters.find((limiter) => limiter.policy === 'tps').used, 1100)
  assert.equal(blocked.budget.limiters.find((limiter) => limiter.policy === 'tpm').used, 1100)
  assert.equal(blocked.budget.limiters.find((limiter) => limiter.policy === 'rpm').used, 2)
  assert.equal(blocked.retryAfter, 1)

  clock.advance(1000)
  const refilled = budget.snapshot('api')
  assert.equal(refilled.limiters.find((limiter) => limiter.policy === 'tps').used, 0)
  assert.equal(refilled.limiters.find((limiter) => limiter.policy === 'tpm').used, 1100)
  assert.equal(budget.check('api').ok, true)
})

test('session, daily, and weekly resets compose for every billing category', () => {
  const clock = clockAt('2026-01-15T22:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [
        { policy: 'rpd', unit: 'requests', limit: 1, window: 'day', reset: 'fixed' },
        { policy: 'session', unit: 'requests', limit: 1, window: 'session', reset: 'fixed', hours: 5 },
        { policy: 'weekly', unit: 'requests', limit: 1, window: 'week', reset: 'fixed' }
      ]
    },
    now: clock.now
  })

  budget.record('api')
  assert.equal(budget.check('api').ok, false)

  // Five hours later the session and UTC day have reset, but the weekly cap
  // still applies: billing category never turns a quota into unlimited use.
  clock.advance(5 * HOUR + 1000)
  const weeklyBlocked = budget.check('api')
  assert.equal(weeklyBlocked.ok, false)
  assert.equal(
    weeklyBlocked.budget.limiters.find((limiter) => limiter.policy === 'session').used,
    0
  )
  assert.equal(
    weeklyBlocked.budget.limiters.find((limiter) => limiter.policy === 'rpd').used,
    0
  )
  assert.equal(
    weeklyBlocked.budget.limiters.find((limiter) => limiter.policy === 'weekly').used,
    1
  )

  clock.set('2026-01-19T00:00:01Z') // Monday in UTC
  assert.equal(budget.check('api').ok, true)
})

test('depleting pools never reset on their own', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'compute_seconds', limit: 10, reset: 'pool' }]
    },
    now: clock.now
  })

  budget.recordUsage('api', { computeSeconds: 10 })
  const blocked = budget.check('api')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, null)

  clock.advance(400 * 24 * HOUR)
  assert.equal(budget.check('api').ok, false)
})

test('a 429 cooldown blocks the slot until it expires', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'requests', limit: 100, window: 'minute', reset: 'rolling' }]
    },
    now: clock.now
  })

  assert.equal(budget.check('api').ok, true)
  budget.cooldown('api', 30)

  const blocked = budget.check('api')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, 30)
  assert.equal(blocked.budget.cooldownSeconds, 30)

  clock.advance(31 * 1000)
  assert.equal(budget.check('api').ok, true)
})

test('an explicit profile overrides a legacy daily limit', () => {
  const budget = createModelBudget({
    env: { SERVERLESS_AI_MAX_REQUESTS_PER_DAY: '1' },
    profiles: {
      serverless: [{ unit: 'requests', limit: 3, window: 'minute', reset: 'rolling' }]
    }
  })

  const snapshot = budget.snapshot('serverless')
  assert.equal(snapshot.limit, 3)
  assert.equal(snapshot.window, 'minute')
})

test('quota profiles reject shapes the engine cannot enforce', () => {
  assert.throws(
    () => createModelBudget({
      profiles: { api: [{ unit: 'requests', limit: 1, window: 'day', reset: 'rolling' }] }
    }),
    /cannot roll a day window/
  )
  assert.throws(
    () => createModelBudget({
      profiles: { api: [{ unit: 'nonsense', limit: 1 }] }
    }),
    /unknown unit/
  )
  assert.throws(
    () => createModelBudget({
      profiles: { api: [{ unit: 'requests', limit: 1, window: 'session', reset: 'fixed' }] }
    }),
    /needs windowMs or hours/
  )
  assert.throws(
    () => createModelBudget({
      env: { AI_QUOTA_PROFILES: '{not json' }
    }),
    /valid JSON/
  )
  assert.throws(
    () => createModelBudget({
      profiles: { api: [{ unit: 'requests', limit: 1, timezone: 'Nowhere/Invalid' }] }
    }),
    /unknown time zone/
  )
})

test('fixed buckets persist across budget instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-quota-'))
  const database = createDatabase(join(directory, 'quota.sqlite'))
  const clock = clockAt('2026-01-15T10:00:00Z')
  const profiles = {
    api: [{ unit: 'requests', limit: 2, window: 'session', reset: 'fixed', hours: 5 }]
  }
  try {
    const first = createModelBudget({ profiles, now: clock.now, repository: database })
    first.record('api')
    first.record('api')
    assert.equal(first.check('api').ok, false)

    const restarted = createModelBudget({ profiles, now: clock.now, repository: database })
    const snapshot = restarted.snapshot('api')
    assert.equal(snapshot.used, 2)
    assert.equal(snapshot.remaining, 0)
    assert.equal(restarted.check('api').ok, false)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('observation counts requests for models without quota profiles', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({ env: {}, now: clock.now })

  assert.equal(budget.snapshot('opencode'), undefined)
  assert.equal(budget.check('opencode').ok, true)

  budget.record('opencode')
  budget.record('opencode')
  const snapshot = budget.snapshot('opencode')
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.observed.requests, 2)
  assert.deepEqual(snapshot.limiters, [])
  assert.equal(budget.check('opencode').ok, true)

  // Token usage is never guessed into the observation ledger.
  budget.recordUsage('opencode', { totalTokens: 500 })
  const after = budget.snapshot('opencode')
  assert.equal(after.observed.requests, 2)
  assert.equal(after.observed.cap, undefined)
})

test('a live 429 records a learned cap, a cooldown, and a day reset', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({ env: {}, now: clock.now })

  budget.record('opencode')
  budget.record('opencode')
  budget.record('opencode')
  budget.observe429('opencode', { retryAfter: 60 })

  const blocked = budget.check('opencode')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.budget.cooldownSeconds, 60)
  assert.equal(blocked.budget.observed.requests, 3)
  assert.equal(blocked.budget.observed.cap, 3)
  assert.equal(blocked.budget.limit, 3)
  const observedLimiter = blocked.budget.limiters.find((limiter) => limiter.observed)
  assert.equal(observedLimiter.limit, 3)
  assert.equal(observedLimiter.resetsInSeconds, 14 * 60 * 60) // until UTC midnight

  clock.advance(61 * 1000)
  const stillBlocked = budget.check('opencode')
  assert.equal(stillBlocked.ok, false)
  assert.equal(stillBlocked.budget.cooldownSeconds, undefined)
  assert.ok(stillBlocked.retryAfter > 0 && stillBlocked.retryAfter <= 14 * 60 * 60)
  assert.equal(stillBlocked.budget.observed.cap, 3)

  clock.set('2026-01-16T10:00:00Z')
  assert.equal(budget.check('opencode').ok, true)
  assert.equal(budget.snapshot('opencode'), undefined)
})

test('learned caps tighten with smaller markers and never loosen', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({ env: {}, now: clock.now })

  budget.record('opencode')
  budget.observe429('opencode', { retryAfter: 30 })
  assert.equal(budget.snapshot('opencode').observed.cap, 1)

  clock.advance(5 * 1000)
  budget.record('opencode')
  budget.observe429('opencode', { retryAfter: 30 })
  const snapshot = budget.snapshot('opencode')
  assert.equal(snapshot.observed.cap, 1)
  assert.equal(snapshot.observed.requests, 2)
  const observed = snapshot.limiters.find((limiter) => limiter.observed)
  assert.equal(observed.limit, 1)
  assert.equal(observed.ok, false)
})

test('observed cooldowns and learned caps survive restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-observed-'))
  const database = createDatabase(join(directory, 'observed.sqlite'))
  const clock = clockAt('2026-01-15T10:00:00Z')
  try {
    const first = createModelBudget({ env: {}, now: clock.now, repository: database })
    first.record('opencode')
    first.record('opencode')
    first.observe429('opencode', { retryAfter: 2 * HOUR / 1000 })
    assert.equal(first.check('opencode').ok, false)

    clock.advance(30 * 60 * 1000) // still inside the cooldown
    const restarted = createModelBudget({ env: {}, now: clock.now, repository: database })
    const restored = restarted.check('opencode')
    assert.equal(restored.ok, false)
    assert.equal(restored.budget.cooldownSeconds, 90 * 60)
    assert.equal(restored.budget.observed.cap, 2)
    assert.equal(restored.budget.observed.requests, 2)

    clock.set('2026-01-15T23:00:00Z') // cooldown expired, still the same day
    const later = createModelBudget({ env: {}, now: clock.now, repository: database })
    const stillCapped = later.check('opencode')
    assert.equal(stillCapped.ok, false)
    assert.equal(stillCapped.budget.cooldownSeconds, undefined)
    assert.equal(stillCapped.budget.observed.cap, 2)

    clock.set('2026-01-16T10:00:00Z')
    const nextDay = createModelBudget({ env: {}, now: clock.now, repository: database })
    assert.equal(nextDay.check('opencode').ok, true)
    assert.equal(nextDay.snapshot('opencode'), undefined)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('observed cooldowns are scoped to the effective CLI model', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({ env: {}, now: clock.now })

  budget.record('opencode', 1, 'model-a')
  budget.observe429('opencode', { retryAfter: 3600, scope: 'model-a' })

  const blocked = budget.check('opencode', 'model-a')
  assert.equal(blocked.ok, false)
  assert.ok(blocked.budget.cooldownSeconds > 0)

  // Switching the configured OpenCode model must not inherit the previous
  // provider's 429 cooldown or learned request cap.
  assert.equal(budget.check('opencode', 'model-b').ok, true)
})

test('observation never overwrites configured profiles', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    env: {},
    profiles: {
      api: [
        { unit: 'requests', limit: 10, window: 'day', reset: 'fixed' },
        { unit: 'tokens', limit: 5000, window: 'day', reset: 'fixed' }
      ]
    },
    now: clock.now
  })

  budget.record('api')
  budget.record('api')
  budget.recordUsage('api', { totalTokens: 300 })
  budget.observe429('api', { retryAfter: 60 })

  const snapshot = budget.snapshot('api')
  assert.equal(snapshot.limiters[0].limit, 10)
  assert.equal(snapshot.limiters[0].used, 2)
  assert.equal(snapshot.limiters[1].limit, 5000)
  assert.equal(snapshot.limiters[1].used, 300)
  assert.equal(snapshot.observed.requests, 2)
  assert.equal(snapshot.observed.cap, 2)
  const observed = snapshot.limiters.find((limiter) => limiter.observed)
  assert.equal(observed.limit, 2)
  assert.equal(observed.ok, false)
  assert.equal(budget.check('api').ok, false)
})

test('cloud compute-utilization shorthands track compute_seconds per session and week', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    env: {
      COLAB_AI_MAX_COMPUTE_SECONDS_PER_SESSION: '600',
      COLAB_AI_SESSION_HOURS: '12',
      KAGGLE_AI_MAX_COMPUTE_SECONDS_PER_WEEK: '1200'
    },
    now: clock.now
  })

  assert.equal(budget.snapshot('colab-3b').unit, 'compute_seconds')
  assert.equal(budget.snapshot('colab-3b').window, 'session')
  budget.recordUsage('colab-3b', { computeSeconds: 600 })
  assert.equal(budget.check('colab-3b').ok, false)

  clock.advance(12 * HOUR + 1000)
  assert.equal(budget.check('colab-3b').ok, true)

  assert.equal(budget.snapshot('kaggle-3b').unit, 'compute_seconds')
  assert.equal(budget.snapshot('kaggle-3b').window, 'week')
  budget.recordUsage('kaggle-3b', { computeSeconds: 1200 })
  assert.equal(budget.check('kaggle-3b').ok, false)
})

test('provider/model scoped limiters isolate request and token usage across models', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '5',
      AI_QUOTA_PROFILES: JSON.stringify({
        'opencode@console-groq': [
          { policy: 'rpm', unit: 'requests', limit: 2, window: 'minute', reset: 'rolling' },
          { policy: 'tpm', unit: 'tokens', limit: 500, window: 'minute', reset: 'rolling' }
        ],
        'opencode@console-nvidia': [
          { policy: 'rpm', unit: 'requests', limit: 4, window: 'minute', reset: 'rolling' }
        ]
      })
    },
    now: clock.now
  })

  const groqModel = 'console-groq/openai/gpt-oss-120b'
  const nvidiaModel = 'console-nvidia/deepseek-ai/deepseek-v4.1-flash'

  budget.record('opencode', 1, groqModel)
  budget.recordUsage('opencode', { promptTokens: 200, completionTokens: 300, totalTokens: 500 }, groqModel)

  const groqCheck = budget.check('opencode', groqModel)
  assert.equal(groqCheck.ok, false)
  assert.equal(groqCheck.budget.limiters.find((l) => l.policy === 'tpm').used, 500)

  const nvidiaCheck = budget.check('opencode', nvidiaModel)
  assert.equal(nvidiaCheck.ok, true)
  assert.equal(nvidiaCheck.budget.limiters.find((l) => l.policy === 'rpm').limit, 4)
  assert.equal(nvidiaCheck.budget.limiters.find((l) => l.policy === 'rpm').used, 0)

  // Models without an explicit provider profile still isolate their counters on the base model limiter.
  budget.record('opencode', 1, 'opencode/big-pickle')
  assert.equal(budget.snapshot('opencode', 'opencode/big-pickle').used, 1)
  assert.equal(budget.snapshot('opencode', 'opencode/beam-free').used, 0)
})

test('antigravity (agy) shares weekly quotas and 429 cooldowns within each of its 3 pools', () => {
  assert.equal(agyQuotaPoolForScope('gemini-3.8-flash-medium'), 'gemini')
  assert.equal(agyQuotaPoolForScope('gemini-4-hydrogen-medium'), 'gemini')
  assert.equal(agyQuotaPoolForScope('claude-sonnet-5-5-medium'), 'claude-gpt')
  assert.equal(agyQuotaPoolForScope('gpt-oss-120b-medium'), 'claude-gpt')
  assert.equal(agyQuotaPoolForScope('gemini-4-argon-high'), 'gemini-4-argon')
  assert.equal(agyQuotaPoolForScope('agy@gemini-3.8-flash-medium'), 'gemini')
  assert.equal(agyQuotaPoolForScope('agy:claude-sonnet-5-5-medium'), 'claude-gpt')
  assert.equal(agyQuotaPoolForScope('google/gemini-3.8-flash-medium'), 'gemini')
  assert.equal(agyQuotaPoolForScope('anthropic/claude-sonnet-5-5-medium'), 'claude-gpt')
  assert.equal(agyQuotaPoolForScope('openai/o3-pro'), 'claude-gpt')
  assert.equal(agyQuotaPoolForScope('google/gemini-4-argon-high'), 'gemini-4-argon')
  assert.equal(agyQuotaPoolForScope('not-a-model'), null)

  const clock = clockAt('2026-01-12T10:00:00Z') // Monday UTC
  const budget = createModelBudget({
    env: {
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '20',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '5',
      AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '8'
    },
    now: clock.now
  })

  // Models in the same AGY weekly pool share one counter and reservation ledger.
  const reservation = budget.reserve('agy', { scope: 'claude-sonnet-5-5-medium', calls: 2 })
  assert.equal(reservation.ok, true)
  assert.equal(budget.snapshot('agy', 'gpt-oss-120b-medium').used, 2)
  assert.equal(budget.snapshot('agy', 'gpt-oss-120b-medium').remaining, 3)
  assert.equal(budget.snapshot('agy', 'gemini-3.8-flash-medium').used, 0)
  assert.equal(budget.snapshot('agy', 'gemini-4-argon-medium').used, 0)

  budget.settle(reservation.reservationId)
  budget.record('agy', 1, 'gpt-oss-120b-medium')
  assert.equal(budget.snapshot('agy', 'claude-sonnet-5-5-medium').used, 3)

  // A 429 on one claude-gpt model cools down the whole claude-gpt pool, not gemini or argon.
  budget.observe429('agy', { scope: 'claude-sonnet-5-5-medium', retryAfter: 300 })
  assert.equal(budget.check('agy', 'gpt-oss-120b-medium').ok, false)
  assert.equal(budget.check('agy', 'gemini-3.8-flash-high').ok, true)
  assert.equal(budget.check('agy', 'gemini-4-argon-medium').ok, true)

  // Cooldown expires after 300s, learned daily cap clears at next UTC midnight while weekly count stays,
  // and weekly quota resets the following Monday.
  clock.advance(301 * 1000)
  const sameDayAfterCooldown = budget.check('agy', 'gpt-oss-120b-medium')
  assert.equal(sameDayAfterCooldown.ok, false)
  assert.equal(sameDayAfterCooldown.budget.cooldownSeconds, undefined)
  assert.equal(sameDayAfterCooldown.budget.observed.cap, 3)

  clock.set('2026-01-13T00:01:00Z')
  assert.equal(budget.check('agy', 'gpt-oss-120b-medium').ok, true)
  assert.equal(budget.snapshot('agy', 'claude-sonnet-5-5-medium').used, 3)

  clock.set('2026-01-19T00:01:00Z')
  assert.equal(budget.snapshot('agy', 'claude-sonnet-5-5-medium').used, 0)
})

test('weekly quota pacing flags ahead-of-pace burn early in the week and recovers late in the week', () => {
  const clock = clockAt('2026-01-12T06:00:00Z') // Early Monday
  const budget = createModelBudget({
    env: { AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '10' },
    now: clock.now
  })

  budget.record('agy', 4, 'claude-sonnet-5-5-medium') // 40% used on Monday morning
  const early = budget.headroom('agy', 'claude-sonnet-5-5-medium')
  assert.equal(early.ok, true)
  assert.equal(early.ratio, 0.6)
  assert.equal(early.pacing.aheadOfPace, true)
  assert.ok(early.pacedHeadroom < early.ratio)

  clock.set('2026-01-17T12:00:00Z') // Saturday (5.5 / 7 days elapsed)
  const late = budget.headroom('agy', 'claude-sonnet-5-5-medium')
  assert.equal(late.ok, true)
  assert.equal(late.ratio, 0.6)
  assert.equal(late.pacing.aheadOfPace, false)
  assert.equal(late.pacedHeadroom, 0.6)
})

test('AGY dual 5-hour session and weekly limits keep harvestableSession and persist synced state in SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mpw-budget-sync-'))
  const dbPath = join(dir, 'workspace.sqlite')
  const clock = clockAt('2026-11-14T06:35:00Z')
  const env = {
    AGY_AI_SESSION_HOURS: '5',
    AGY_AI_GEMINI_MAX_REQUESTS_PER_5H: '45',
    AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '200',
    AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_5H: '40',
    AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '200',
    AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '100'
  }

  let db = createDatabase(dbPath)
  try {
    const budget = createModelBudget({ repository: db, env, now: clock.now })
    budget.syncPoolState('agy', {
      scope: 'gemini-3.8-flash-medium',
      weeklyRemainingPercent: 91.81,
      weeklyResetSeconds: (163 * 3600) + (15 * 60),
      sessionRemainingPercent: 71.33,
      sessionResetSeconds: 15 * 60
    })
    budget.syncPoolState('agy', {
      scope: 'claude-sonnet-5-5-medium',
      weeklyRemainingPercent: 99.95,
      weeklyResetSeconds: (138 * 3600) + (36 * 60),
      sessionRemainingPercent: 100
    })
    budget.syncPoolState('agy', {
      scope: 'gemini-4-argon-medium',
      weeklyRemainingPercent: 57.19,
      weeklyResetSeconds: (163 * 3600) + (10 * 60)
    })

    const gemini = budget.headroom('agy', 'gemini-3.8-flash-medium')
    assert.equal(gemini.harvestableSession, true)
    assert.equal(gemini.sessionWindow.resetsInSeconds, 15 * 60)
    assert.equal(gemini.pacing.aheadOfPace, false)

    const claude = budget.headroom('agy', 'claude-sonnet-5-5-medium')
    assert.equal(claude.harvestableSession, true)
    assert.equal(claude.pacing.aheadOfPace, false)

    const argon = budget.headroom('agy', 'gemini-4-argon-medium')
    assert.equal(argon.pacing.aheadOfPace, true)
    assert.ok(argon.pacing.usedFraction > 0.4)
    assert.ok(argon.pacedHeadroom < argon.ratio)

    db.close()
    db = createDatabase(dbPath)
    const reloaded = createModelBudget({ repository: db, env, now: clock.now })
    const reloadedArgon = reloaded.headroom('agy', 'gemini-4-argon-medium')
    assert.equal(reloadedArgon.pacing.aheadOfPace, true)
    assert.equal(reloadedArgon.pacing.resetsInSeconds, (163 * 3600) + (10 * 60))

    // Advancing 16m refreshes Gemini 5-hour session bucket while keeping weekly count intact.
    clock.advance(16 * MINUTE)
    const refreshedGemini = reloaded.snapshot('agy', 'gemini-3.8-flash-medium')
    assert.equal(refreshedGemini.limiters.find((w) => w.window === 'session').remaining, 45)
    assert.equal(refreshedGemini.limiters.find((w) => w.window === 'week').remaining, 184)

    // Advancing past synced weekly reset restores full argon weekly capacity.
    clock.advance(164 * HOUR)
    const resetArgon = reloaded.headroom('agy', 'gemini-4-argon-medium')
    assert.equal(resetArgon.ratio, 1)
    assert.equal(resetArgon.pacing.aheadOfPace, false)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('opencode console-google keeps per-model failover ledgers, stays isolated from agy, and resets at Pacific midnight', () => {
  // Winter PST is UTC-8: 2026-01-14T23:55:00Z is 15:55 PST on Jan 14.
  const clock = clockAt('2026-01-14T23:55:00Z')
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_GOOGLE_MAX_REQUESTS_PER_DAY: '2',
      OPENCODE_AI_GOOGLE_MAX_REQUESTS_PER_MINUTE: '10',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '5'
    },
    now: clock.now
  })

  // Recording & 429 on console-google/gemini-3.8-flash leaves sibling flash-lite and OAuth agy ready for failover.
  budget.record('opencode', 1, 'console-google/gemini-3.8-flash')
  budget.observe429('opencode', { scope: 'console-google/gemini-3.8-flash', retryAfter: 30 })
  budget.record('opencode', 1, 'console-google/gemini-3.8-flash')

  assert.equal(budget.check('opencode', 'console-google/gemini-3.8-flash').ok, false)
  assert.equal(budget.snapshot('opencode', 'console-google/gemini-3.5-flash-lite').used, 0)
  assert.equal(budget.check('opencode', 'console-google/gemini-3.5-flash-lite').ok, true)
  assert.equal(budget.snapshot('agy', 'gemini-3.8-flash-medium').used, 0)

  // Configured daily RPD and learned 429 cap stay active past cooldown & UTC midnight (00:05Z = 16:05 PST)
  // until midnight America/Los_Angeles (08:00Z in winter PST).
  clock.set('2026-01-15T00:05:00Z')
  assert.equal(budget.check('opencode', 'console-google/gemini-3.8-flash').ok, false)

  clock.set('2026-01-15T07:59:00Z') // 23:59 PST on Jan 14
  assert.equal(budget.check('opencode', 'console-google/gemini-3.8-flash').ok, false)

  clock.set('2026-01-15T08:01:00Z') // 00:01 PST on Jan 15 -> daily RPD & learned 429 reset
  assert.equal(budget.check('opencode', 'console-google/gemini-3.8-flash').ok, true)
  assert.equal(budget.snapshot('opencode', 'console-google/gemini-3.8-flash').used, 0)
})

test('gemini-api tracks per-model ledgers independently, stays isolated from agy, and resets at Pacific midnight', () => {
  const clock = clockAt('2026-01-14T23:55:00Z')
  const budget = createModelBudget({
    env: {
      GEMINI_API_MAX_REQUESTS_PER_DAY: '2',
      GEMINI_API_MAX_REQUESTS_PER_MINUTE: '10',
      GEMINI_API_TIMEZONE: 'America/Los_Angeles',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '5'
    },
    now: clock.now
  })

  budget.record('gemini-api', 1, 'gemini-3.8-flash')
  budget.observe429('gemini-api', { scope: 'gemini-3.8-flash', retryAfter: 30 })
  budget.record('gemini-api', 1, 'gemini-3.8-flash')

  assert.equal(budget.check('gemini-api', 'gemini-3.8-flash').ok, false)
  assert.equal(budget.snapshot('gemini-api', 'gemini-3.5-flash-lite').used, 0)
  assert.equal(budget.check('gemini-api', 'gemini-3.5-flash-lite').ok, true)
  assert.equal(budget.snapshot('agy', 'gemini-3.8-flash-medium').used, 0)

  // Configured daily RPD & learned 429 stay active past cooldown and UTC midnight (00:05Z = 16:05 PST)
  // until midnight America/Los_Angeles (08:00Z in winter PST).
  clock.set('2026-01-15T00:05:00Z')
  assert.equal(budget.check('gemini-api', 'gemini-3.8-flash').ok, false)

  clock.set('2026-01-15T07:59:00Z')
  assert.equal(budget.check('gemini-api', 'gemini-3.8-flash').ok, false)

  clock.set('2026-01-15T08:01:00Z')
  assert.equal(budget.check('gemini-api', 'gemini-3.8-flash').ok, true)
  assert.equal(budget.snapshot('gemini-api', 'gemini-3.8-flash').used, 0)
})

test('gemini-api-paid enforces local prepay safety-ratio USD & token depleting pools across SQLite restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-budget-paid-'))
  const dbPath = join(dir, 'quota.sqlite')
  try {
    const env = {
      GEMINI_API_PAID_PREPAY_BALANCE_USD: '5',
      GEMINI_API_PAID_MAX_TOKENS: '500000',
      GEMINI_API_MAX_REQUESTS_PER_DAY: '50'
    }
    const db1 = createDatabase(dbPath)
    try {
      const budget1 = createModelBudget({ env, repository: db1 })
      const initialSnap = budget1.snapshot('gemini-api-paid', 'gemini-4-argon')
      assert.equal(initialSnap.ok, true)
      const usdLimiter = initialSnap.limiters.find((entry) => entry.unit === 'usd_micros')
      const tokenLimiter = initialSnap.limiters.find((entry) => entry.unit === 'tokens' && entry.reset === 'pool')
      assert.equal(usdLimiter.limitUsd, 4)
      assert.equal(usdLimiter.limit, 4_000_000)
      assert.equal(tokenLimiter.limit, 500_000)

      // $2/1M input + $12/1M output+thought on argon:
      // 100k input = $0.20 (200k micros), 250k completion+thought = $3.00 (3,000k micros) => $3.20
      budget1.recordUsage('gemini-api-paid', {
        promptTokens: 100_000,
        completionTokens: 250_000
      }, 'gemini-4-argon')
      assert.equal(budget1.check('gemini-api-paid', 'gemini-4-argon').ok, true)
      const afterFirst = budget1.snapshot('gemini-api-paid', 'gemini-4-argon')
      const usdAfterFirst = afterFirst.limiters.find((entry) => entry.unit === 'usd_micros')
      assert.equal(usdAfterFirst.usedUsd, 3.2)
      assert.equal(usdAfterFirst.remainingUsd, 0.8)
      assert.equal(budget1.snapshot('gemini-api', 'gemini-3.8-flash').used, 0)

      // Second call adds 100k completion ($1.20) => $4.40 > $4.00 safety cap -> trips circuit breaker
      budget1.recordUsage('gemini-api-paid', {
        promptTokens: 0,
        completionTokens: 100_000
      }, 'gemini-4-argon')
      assert.equal(budget1.check('gemini-api-paid', 'gemini-4-argon').ok, false)
      assert.equal(budget1.reserve('gemini-api-paid', { scope: 'gemini-4-argon' }).ok, false)
      // Free lane remains unaffected
      assert.equal(budget1.check('gemini-api', 'gemini-3.8-flash').ok, true)
    } finally {
      db1.close()
    }

    // Reopen SQLite and verify depleted pool persists across restart
    const db2 = createDatabase(dbPath)
    try {
      const budget2 = createModelBudget({ env, repository: db2 })
      assert.equal(budget2.check('gemini-api-paid', 'gemini-4-argon').ok, false)
      const reloadedUsd = budget2.snapshot('gemini-api-paid', 'gemini-4-argon').limiters.find((e) => e.unit === 'usd_micros')
      assert.equal(reloadedUsd.usedUsd, 4.4)
      assert.equal(reloadedUsd.remainingUsd, 0)

      // Calibrate after partial adjustment, then reset pool after a fresh Prepay top-up
      budget2.syncPoolState('gemini-api-paid', {
        scope: 'gemini-4-argon',
        poolUsdSpent: 1.5,
        poolTokensUsed: 120_000
      })
      assert.equal(budget2.check('gemini-api-paid', 'gemini-4-argon').ok, true)
      const adjustedSnap = budget2.snapshot('gemini-api-paid', 'gemini-4-argon')
      assert.equal(adjustedSnap.limiters.find((e) => e.unit === 'usd_micros').usedUsd, 1.5)
      assert.equal(adjustedSnap.limiters.find((e) => e.unit === 'tokens' && e.reset === 'pool').used, 120_000)

      budget2.syncPoolState('gemini-api-paid', {
        scope: 'gemini-4-argon',
        resetPool: true
      })
      const resetSnap = budget2.snapshot('gemini-api-paid', 'gemini-4-argon')
      assert.equal(resetSnap.ok, true)
      assert.equal(resetSnap.limiters.find((e) => e.unit === 'usd_micros').usedUsd, 0)
      assert.equal(resetSnap.limiters.find((e) => e.unit === 'tokens' && e.reset === 'pool').used, 0)
    } finally {
      db2.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncAudit tracks calibration timestamp and flags elapsed synced reset or >24h staleness', () => {
  const clock = clockAt('2026-01-14T10:00:00Z')
  const budget = createModelBudget({
    env: {
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '200',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_5H: '45'
    },
    now: clock.now
  })

  assert.equal(budget.snapshot('agy', 'gemini-3.8-flash-medium').syncAudit, undefined)

  budget.syncPoolState('agy', {
    scope: 'gemini-3.8-flash-medium',
    weeklyRemainingPercent: 80,
    weeklyResetSeconds: 6 * 3600,
    sessionRemainingPercent: 100,
    sessionResetSeconds: 5 * 3600
  })

  const fresh = budget.headroom('agy', 'gemini-3.8-flash-medium')
  assert.equal(fresh.syncAudit.syncedWeekResetExpired, false)
  assert.equal(fresh.syncAudit.staleCalibration, false)
  assert.equal(fresh.syncAudit.syncAgeSeconds, 0)

  // Advance past the synced 6h weekly reset timer
  clock.advance(7 * HOUR)
  const expired = budget.headroom('agy', 'gemini-3.8-flash-medium')
  assert.equal(expired.syncAudit.syncedWeekResetExpired, true)
  assert.equal(expired.syncAudit.staleCalibration, true)
  assert.equal(expired.syncAudit.syncAgeSeconds, 7 * 3600)

  // Re-sync with a long reset window and advance >24h to check age-based staleness
  budget.syncPoolState('agy', {
    scope: 'gemini-3.8-flash-medium',
    weeklyRemainingPercent: 95,
    weeklyResetSeconds: 150 * 3600
  })
  clock.advance(25 * HOUR)
  const staleByAge = budget.headroom('agy', 'gemini-3.8-flash-medium')
  assert.equal(staleByAge.syncAudit.syncedWeekResetExpired, false)
  assert.equal(staleByAge.syncAudit.staleCalibration, true)
  assert.equal(staleByAge.syncAudit.syncAgeSeconds, 25 * 3600)
})

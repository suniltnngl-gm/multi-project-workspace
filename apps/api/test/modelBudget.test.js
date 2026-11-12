import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDatabase } from '../src/database.js'
import { createModelBudget } from '../src/modelBudget.js'

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

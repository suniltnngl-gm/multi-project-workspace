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

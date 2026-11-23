import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRelayPlan } from '../../../scripts/swarm-relay.mjs'
import { loadPoolBudgets, selectSlot, evaluateCopilotMonthly, resolveRing, poolForSibling } from '../../../scripts/swarm-quota-ring.mjs'

test('loadPoolBudgets excludes capped, weekly-exhausted and unknown-limit pools honestly', () => {
  const budgets = loadPoolBudgets({
    countCalls: (pool) => (pool === 'agy-gemini' ? 4 : 0),
    quota: { 'agy-claude-gpt': { weeklyRemainingPct: 0 } },
    conservePools: []
  })
  assert.equal(budgets['agy-gemini'].cap, 4)
  assert.equal(budgets['agy-gemini'].callsInWindow, 4)
  assert.equal(budgets['agy-gemini'].admitted, false)
  assert.equal(budgets['agy-gemini'].reason, 'five_hour_cap_reached')

  assert.equal(budgets['agy-claude-gpt'].admitted, false)
  assert.equal(budgets['agy-claude-gpt'].reason, 'weekly_quota_exhausted')

  assert.equal(budgets['nous-hermes-free'].admitted, true)
  // Cloudflare's provider daily limit is not surfaced by our tooling: no artificial cap.
  assert.equal(budgets['cloudflare-workers-ai'].limitKnown, false)
  assert.equal(budgets['cloudflare-workers-ai'].cap, null)
  assert.equal(budgets['cloudflare-workers-ai'].admitted, true)
})

test('selectSlot substitutes the next admitted sibling when the preferred one is excluded', () => {
  const ring = ['hermes', 'direct', 'gemini-api', 'opencode']
  const weekly = loadPoolBudgets({ countCalls: () => 0, quota: { 'nous-hermes-free': { weeklyRemainingPct: 0 } } })
  const picked = selectSlot({ ring, windowIndex: 0, budgets: weekly })
  assert.equal(picked.admitted, true)
  assert.equal(picked.sibling, 'direct')
  assert.equal(picked.substitutedFor, 'hermes')
  assert.equal(picked.reason, 'substitute_for:hermes')

  const capped = selectSlot({
    ring, windowIndex: 0,
    budgets: loadPoolBudgets({ countCalls: (pool) => (pool === 'nous-hermes-free' ? 99 : 0) })
  })
  // nous-hermes-free has no 5h cap, so the roster sibling is used as-is.
  assert.equal(capped.sibling, 'hermes')
  assert.equal(capped.substitutedFor, null)

  assert.equal(poolForSibling('direct'), 'cloudflare-workers-ai')
  assert.equal(poolForSibling('gemini-api'), 'gemini-api-key')
  assert.equal(poolForSibling('opencode'), 'opencode-tidepool-free')
  assert.equal(poolForSibling('agy'), 'agy-gemini')
  assert.equal(poolForSibling('copilot'), 'github-copilot')
})

test('selectSlot admits CONSERVE pools only with allowConserve and within the window budget', () => {
  const ring = ['hermes', 'agy']
  const budgets = loadPoolBudgets({ countCalls: () => 0, conservePools: ['agy-gemini'] })
  assert.equal(budgets['agy-gemini'].conserve, true)

  const blocked = selectSlot({ ring, windowIndex: 1, budgets })
  assert.equal(blocked.sibling, 'hermes')
  assert.equal(blocked.substitutedFor, 'agy')

  const admitted = selectSlot({ ring, windowIndex: 1, budgets, allowConserve: true, maxConserveWindows: 1 })
  assert.equal(admitted.sibling, 'agy')
  assert.equal(admitted.conserve, true)
  assert.equal(admitted.conserveWindowsUsed, 1)

  const exhausted = selectSlot({
    ring, windowIndex: 1, budgets, allowConserve: true, maxConserveWindows: 1, conserveWindowsUsed: 1
  })
  assert.equal(exhausted.sibling, 'hermes')
  assert.equal(exhausted.substitutedFor, 'agy')
})

test('selectSlot returns an explicit deferred verdict when no pool is admitted', () => {
  const ring = ['agy']
  const budgets = loadPoolBudgets({
    countCalls: () => 0,
    quota: { 'agy-gemini': { weeklyRemainingPct: 0 } },
    conservePools: ['agy-gemini']
  })
  const verdict = selectSlot({ ring, windowIndex: 0, budgets, allowConserve: true })
  assert.equal(verdict.admitted, false)
  assert.equal(verdict.reason, 'no_admitted_pool')
})

test('copilot monthly daily-budget gate composes with the 1-call/5h cap', () => {
  assert.equal(evaluateCopilotMonthly({ remainingPct: 40, daysRemaining: 10 }).targetFloorPct, 40)
  assert.equal(evaluateCopilotMonthly({ remainingPct: 40, daysRemaining: 10 }).admitted, false)
  assert.equal(evaluateCopilotMonthly({ remainingPct: 60, daysRemaining: 10 }).admitted, true)

  const ring = ['copilot', 'hermes']
  const budgets = loadPoolBudgets({ countCalls: () => 0 })
  assert.equal(budgets['github-copilot'].cap, 1)
  const deferred = selectSlot({
    ring, windowIndex: 0, budgets, copilotMonthly: { remainingPct: 5, daysRemaining: 20 }
  })
  assert.equal(deferred.sibling, 'hermes')
  assert.equal(deferred.substitutedFor, 'copilot')

  const capped = selectSlot({ ring, windowIndex: 0, budgets: loadPoolBudgets({ countCalls: () => 1 }) })
  assert.equal(capped.sibling, 'hermes')
  assert.equal(capped.substitutedFor, 'copilot')
})

test('resolveRing applies the tier1-ring preset and rejects unknown presets', () => {
  assert.deepEqual(resolveRing(null, 'tier1-ring'), ['hermes', 'direct', 'gemini-api', 'opencode'])
  assert.throws(() => resolveRing(null, 'nope'), /unknown_ring_preset/)
  const plan = buildRelayPlan({ preset: 'tier1-ring', windows: 4, reportDir: '/tmp/relay-preset' })
  assert.equal(plan.siblings.length, 4)
  assert.equal(plan.windows, 4)
  assert.equal(plan.assignments[3].pool, 'opencode-tidepool-free')
})

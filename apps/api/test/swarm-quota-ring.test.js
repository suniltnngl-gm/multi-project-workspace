import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRelayPlan } from '../../../scripts/swarm-relay.mjs'
import { loadPoolBudgets, selectSlot, evaluateCopilotMonthly, resolveRing, poolForSibling, readLiveSqliteQuota, guestFallbackCandidates } from '../../../scripts/swarm-quota-ring.mjs'
import {
  GEMINI_API_ROTATION_MODELS,
  advanceGeminiApiRotation,
  alternateModelForPrimary,
  primaryModelAtIndex,
  readRotationState
} from '../../../scripts/swarm-gemini-rotation.mjs'

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

test('k5-pipeline-ring preset rotates 5-stage jobs (discover->case-solve->build->review->publish), direct-vercel W4, and Round 6 Copilot guest W5', () => {
  assert.deepEqual(resolveRing(null, 'k5-pipeline-ring'), ['hermes', 'direct', 'gemini-api', 'direct-vercel', 'guest'])
  const plan = buildRelayPlan({ preset: 'k5-pipeline-ring', rounds: 6, reportDir: '/tmp/relay-k5' })
  assert.equal(plan.mode, 'pipeline')
  assert.equal(plan.windows, 5)
  assert.equal(plan.rounds, 6)
  assert.equal(plan.assignments.length, 30)

  // Round 1 (W1..W5): discover -> case-solve -> build -> review (direct-vercel) -> publish (live roster sibling; never the local dry-run default)
  assert.deepEqual(
    plan.assignments.slice(0, 5).map((a) => ({ job: a.job, sibling: a.sibling, pool: a.pool })),
    [
      { job: 'discover', sibling: 'hermes', pool: 'nous-hermes-free' },
      { job: 'case-solve', sibling: 'direct', pool: 'cloudflare-workers-ai' },
      { job: 'build', sibling: 'gemini-api', pool: 'gemini-api-key' },
      { job: 'review', sibling: 'direct-vercel', pool: 'vercel-ai-gateway' },
      { job: 'publish', sibling: 'hermes', pool: 'nous-hermes-free' }
    ]
  )

  // Round 6 W30 (index 29): Guest slot W5 admits github-copilot on cadence Round 6
  const w30 = plan.assignments[29]
  assert.equal(w30.round, 6)
  assert.equal(w30.job, 'publish')
  assert.equal(w30.sibling, 'copilot')
  assert.equal(w30.pool, 'github-copilot')

  // Verify runtime selectSlot guest admission on Round 1 vs Round 6
  const budgets = loadPoolBudgets({ countCalls: () => 0 })
  const r1Guest = selectSlot({ ring: plan.siblings, windowIndex: 4, round: 1, budgets })
  assert.equal(r1Guest.sibling, 'hermes')
  assert.equal(r1Guest.pool, 'nous-hermes-free')
  assert.equal(r1Guest.substitutedFor, 'guest')

  const r6Guest = selectSlot({ ring: plan.siblings, windowIndex: 29, round: 6, budgets })
  assert.equal(r6Guest.sibling, 'copilot')
  assert.equal(r6Guest.pool, 'github-copilot')

  // When Copilot 1/5h cap is reached on Round 6, guest falls back to a live roster sibling
  const r6Capped = selectSlot({
    ring: plan.siblings, windowIndex: 29, round: 6,
    budgets: loadPoolBudgets({ countCalls: (p) => (p === 'github-copilot' ? 1 : 0) })
  })
  assert.equal(r6Capped.sibling, 'hermes')
})

test('guestFallbackCandidates prefers copilot on cadence rounds, agy under allowConserve, then live roster siblings before local', () => {
  const list = ['hermes', 'direct', 'gemini-api', 'direct-vercel', 'guest']
  // Round 1, no conserve: first live roster sibling in ring order after `guest`.
  assert.equal(guestFallbackCandidates({ list, round: 1, allowConserve: false })[0], 'hermes')
  // Cadence round: copilot leads; CONSERVE round: agy leads.
  assert.equal(guestFallbackCandidates({ list, round: 6, allowConserve: false })[0], 'copilot')
  assert.equal(guestFallbackCandidates({ list, round: 1, allowConserve: true })[0], 'agy')
  // `local` is only ever the last resort while a live roster sibling exists.
  const candidates = guestFallbackCandidates({ list, round: 1, allowConserve: false })
  assert.ok(candidates.indexOf('local') > candidates.indexOf('hermes'))
  assert.ok(candidates.includes('direct-vercel'))
})

test('readLiveSqliteQuota loads live weeklyRemainingPct and conservePools from workspace SQLite database', () => {
  const live = readLiveSqliteQuota()
  assert.equal(live.ok, true)
  assert.equal(live.source, 'sqlite')
  assert.ok(typeof live.quota['agy-gemini']?.weeklyRemainingPct === 'number')
  assert.ok(typeof live.quota['agy-claude-gpt']?.weeklyRemainingPct === 'number')
  const budgets = loadPoolBudgets({
    countCalls: () => 0,
    quota: live.quota,
    conservePools: live.conservePools
  })
  // agy-claude-gpt is 0% weekly in live SQLite -> admitted must be false
  assert.equal(budgets['agy-claude-gpt'].weeklyRemainingPct, 0)
  assert.equal(budgets['agy-claude-gpt'].admitted, false)
  assert.equal(budgets['agy-claude-gpt'].reason, 'weekly_quota_exhausted')
  // agy-gemini is ~16.65% weekly and aheadOfPace -> conserve=true
  assert.ok(budgets['agy-gemini'].weeklyRemainingPct < 50)
  assert.equal(budgets['agy-gemini'].conserve, true)
})

test('gemini-api rotation roster is the four-model Free-tier cycle with a deterministic single alternate', () => {
  assert.deepEqual([...GEMINI_API_ROTATION_MODELS], [
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemma-4-31b-it'
  ])
  const seq = Array.from({ length: 6 }, (_, i) => primaryModelAtIndex(i))
  assert.deepEqual(seq, [
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemma-4-31b-it',
    'gemini-3.8-flash',
    'gemini-2.5-flash'
  ])
  assert.equal(alternateModelForPrimary('gemini-3.8-flash'), 'gemini-2.5-flash')
  assert.equal(alternateModelForPrimary('gemini-3.5-flash-lite'), 'gemma-4-31b-it')
  // The single retry wraps around the roster; it never repeats the failed primary.
  assert.equal(alternateModelForPrimary('gemma-4-31b-it'), 'gemini-3.8-flash')
})

test('gemini-api rotation persists across restarts so windows spread instead of piling on model #1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-rotation-'))
  try {
    const picks = []
    for (let i = 0; i < 4; i += 1) picks.push(advanceGeminiApiRotation(dir).primaryModel)
    assert.deepEqual(picks, [
      'gemini-3.8-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemma-4-31b-it'
    ])
    const state = readRotationState(dir)
    assert.equal(state.schema, 'gemini-model-rotation/v1')
    assert.equal(state.counter, 4)
    // A fresh process (restart) continues from the persisted counter...
    assert.equal(advanceGeminiApiRotation(dir).primaryModel, 'gemini-3.8-flash')
    // ...and a corrupt/missing ledger fails open to a fresh start, never throwing.
    writeFileSync(join(dir, 'gemini-model-rotation.json'), '{oops\n')
    assert.equal(readRotationState(dir), null)
    assert.equal(advanceGeminiApiRotation(dir).primaryModel, 'gemini-3.8-flash')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('conservePools/POOL_POLICY admission stays deterministic while gemini-api rotation advances', () => {
  const ring = ['hermes', 'gemini-api', 'agy']
  const budgets = loadPoolBudgets({
    countCalls: (pool) => (pool === 'github-copilot' ? 1 : 0),
    quota: { 'agy-claude-gpt': { weeklyRemainingPct: 0 }, 'gemini-api-key': { weeklyRemainingPct: 100 } },
    conservePools: ['agy-gemini']
  })
  assert.equal(budgets['agy-gemini'].conserve, true)
  assert.equal(budgets['github-copilot'].cap, 1)

  // Relay composition: admission first, then rotation for whichever gemini-api window
  // is actually admitted (the counter advances once per admitted gemini-api window).
  const compose = (startCounter) => {
    let rotation = startCounter
    return [0, 1, 2].map((windowIndex) => {
      const choice = selectSlot({ ring, windowIndex, budgets })
      if (!choice.admitted) return { sibling: choice.sibling, model: null, reason: choice.reason }
      if (choice.sibling !== 'gemini-api') return { sibling: choice.sibling, model: null, reason: choice.reason }
      const model = primaryModelAtIndex(rotation)
      rotation += 1
      return { sibling: 'gemini-api', model, reason: choice.reason }
    })
  }

  const runA = compose(0)
  const runB = compose(0)
  assert.deepEqual(runA, runB)
  // agy is CONSERVE-excluded (no --allow-conserve): W3 substitutes the next admitted sibling.
  assert.deepEqual(runA.map((a) => a.sibling), ['hermes', 'gemini-api', 'hermes'])
  assert.equal(runA[2].reason, 'substitute_for:agy')

  // Rotation offset shifts only the gemini-api models; admission itself is unchanged.
  const shifted = compose(1)
  assert.deepEqual(shifted.map((a) => a.sibling), runA.map((a) => a.sibling))
  assert.equal(runA[1].model, 'gemini-3.8-flash')
  assert.equal(shifted[1].model, 'gemini-2.5-flash')
})

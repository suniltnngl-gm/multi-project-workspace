import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import {
  SESSION_POOL_DISPATCH_SCHEMA_VERSION,
  resolveDispatchTarget
} from '../../src/toolchain/dispatch/session-pool-dispatcher.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schema = JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/src/toolchain/schemas/session-pool-dispatch.schema.json'), 'utf8'))
const now = () => Date.parse('2026-11-20T15:00:00Z')

const base = { cli: 'agy', repository: 'mpw', gateway: 'g1', provider: 'google', model: 'm-primary', status: 'idle' }
const request = { role: 'worker', repository: 'mpw', cli: 'agy', gateway: 'g1', provider: 'google', model: 'm-primary', workItem: 'SP-001' }

test('reuse prefers warm_observed session', () => {
  const sessions = [
    { ...base, role: 'worker', sessionId: 'cold', cacheState: 'unknown' },
    { ...base, role: 'worker', sessionId: 'warm', cacheState: 'warm_observed' }
  ]
  const plan = resolveDispatchTarget({ sessions, request, now })
  assert.equal(plan.action, 'reuse_session')
  assert.equal(plan.selectedSession.compositeKey, 'agy:warm')
  assert.equal(plan.cliArtifactBoundary.mergeNativeArtifacts, false)
  assertInventorySchema(plan, schema, 'reuse plan')
})

test('role isolation: reviewer session is never reused for worker', () => {
  const sessions = [{ ...base, role: 'reviewer', sessionId: 'r1', cacheState: 'warm_observed' }]
  const plan = resolveDispatchTarget({ sessions, request, now })
  assert.equal(plan.action, 'create_session')
  assert.equal(plan.selectedSession.sessionId, null)
  assertInventorySchema(plan, schema, 'create plan')
})

test('unavailable primary model falls back to persistent fallback session without switching models', () => {
  const sessions = [
    { ...base, role: 'worker', sessionId: 'p1', cacheState: 'warm_observed' },
    { ...base, role: 'worker', sessionId: 'f1', model: 'm-fallback', cacheState: 'warm_observed' }
  ]
  const plan = resolveDispatchTarget({
    sessions, request, now,
    unavailableModels: ['m-primary'],
    fallbackCandidates: [{ model: 'm-fallback' }]
  })
  assert.equal(plan.action, 'reuse_session')
  assert.equal(plan.fallbackUsed, true)
  assert.equal(plan.selectedSession.sessionId, 'f1')
  assert.equal(plan.selectedSession.model, 'm-fallback')
  assert.ok(plan.reasons.includes('model_not_switched'))
  assertInventorySchema(plan, schema, 'fallback plan')

  const created = resolveDispatchTarget({
    sessions: [sessions[0]], request, now,
    unavailableModels: ['m-primary'],
    fallbackCandidates: [{ model: 'm-fallback' }]
  })
  assert.equal(created.action, 'create_session')
  assert.equal(created.selectedSession.model, 'm-fallback')

  const blocked = resolveDispatchTarget({ sessions, request, now, unavailableModels: ['m-primary'] })
  assert.equal(blocked.action, 'blocked')
  assertInventorySchema(blocked, schema, 'blocked plan')
})

test('schema accepts plans and rejects invalid ones', () => {
  const plan = resolveDispatchTarget({ sessions: [], request, now })
  assert.equal(plan.schemaVersion, SESSION_POOL_DISPATCH_SCHEMA_VERSION)
  assert.deepEqual(validateInventorySchema(plan, schema), [])
  const bad = { ...plan, readOnly: false, action: 'merge', cliArtifactBoundary: { cli: 'agy', mergeNativeArtifacts: true }, extra: 1 }
  const errors = validateInventorySchema(bad, schema)
  assert.ok(errors.length >= 4, errors.join('\n'))
})

test('swarm-session-plan.mjs --json smoke test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp001-'))
  try {
    const registry = join(dir, 'registry.json')
    writeFileSync(registry, JSON.stringify({ sessions: [{ ...base, role: 'worker', sessionId: 'w1', cacheState: 'warm_observed' }] }))
    const r = spawnSync(process.execPath, [
      resolve(repoRoot, 'scripts/swarm-session-plan.mjs'),
      '--registry', registry, '--role', 'worker', '--repo', 'mpw', '--work-item', 'SP-001',
      '--cli', 'agy', '--model', 'm-primary', '--json'
    ], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.action, 'reuse_session')
    assert.equal(out.readOnly, true)
    assertInventorySchema(out, schema, 'cli plan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- SP-002: quota-pool-aware, session-affine scheduling ----
const T0 = '2026-11-20T14:30:00Z'
const obs = (quotaPool, extra = {}) => ({ quotaPool, observedAt: T0, ...extra })
const ses = (sessionId, extra = {}) => ({ ...base, role: 'worker', sessionId, cacheState: 'warm_observed', ...extra })

test('SP-002 backward compat: omitted quotaPool defaults to provider, then cli, then unknown', () => {
  const plan = resolveDispatchTarget({ sessions: [ses('a')], request, now })
  assert.equal(plan.selectedSession.quotaPool, 'google')
  assert.equal(plan.dispatchMode, 'fallback')
  assert.deepEqual(plan.quotaAssessment.map((q) => q.health), ['unknown'])
  assertInventorySchema(plan, schema, 'compat plan')
  const noProvider = resolveDispatchTarget({
    sessions: [], request: { role: 'worker', cli: 'agy', model: 'm' }, now
  })
  assert.equal(noProvider.selectedSession.quotaPool, 'agy')
  assert.equal(noProvider.cliArtifactBoundary.mergeNativeArtifacts, false)
})

test('SP-002 quotaPool is part of the affinity/routing key', () => {
  const sessions = [ses('a', { quotaPool: 'pool-a' }), ses('b', { quotaPool: 'pool-b' })]
  const plan = resolveDispatchTarget({ sessions, request: { ...request, quotaPool: 'pool-b' }, now })
  assert.equal(plan.selectedSession.sessionId, 'b')
  assert.ok(plan.routingKey.endsWith('|pool-b'))
  const none = resolveDispatchTarget({ sessions, request: { ...request, quotaPool: 'pool-z' }, now })
  assert.equal(none.action, 'create_session')
})

test('SP-002 scarce/conserve pool is avoided when a healthier independent pool has an eligible session', () => {
  const sessions = [ses('scarce', { quotaPool: 'acct-a' }), ses('ok', { quotaPool: 'acct-b', cacheState: 'unknown' })]
  for (const o of [obs('acct-a', { policy: 'conserve' }), obs('acct-a', { weeklyRemainingPct: 5 })]) {
    const plan = resolveDispatchTarget({ sessions, request, quotaObservations: [o, obs('acct-b', { weeklyRemainingPct: 80 })], now })
    assert.equal(plan.selectedSession.sessionId, 'ok')
    assert.equal(plan.selectedSession.quotaPool, 'acct-b')
    assertInventorySchema(plan, schema, 'conserve plan')
  }
  const only = resolveDispatchTarget({ sessions: [sessions[0]], request, quotaObservations: [obs('acct-a', { policy: 'conserve' })], now })
  assert.equal(only.action, 'reuse_session')
  assert.ok(only.reasons.some((r) => r.startsWith('scarce_pool_reused_no_healthier_alternative')))
})

test('SP-002 healthy warm session wins; quotaObservations are timestamped, latest wins, stale ignored', () => {
  const sessions = [ses('cold', { quotaPool: 'p1', cacheState: 'unknown' }), ses('warm', { quotaPool: 'p2' })]
  const healthy = resolveDispatchTarget({
    sessions, request, now,
    quotaObservations: [obs('p1', { weeklyRemainingPct: 90 }), obs('p2', { weeklyRemainingPct: 90 })]
  })
  assert.equal(healthy.selectedSession.sessionId, 'warm')
  assert.equal(healthy.quotaAssessment.find((q) => q.quotaPool === 'p2').observedAt, '2026-11-20T14:30:00.000Z')

  // later observation supersedes an earlier scarce one
  const recovered = resolveDispatchTarget({
    sessions, request, now,
    quotaObservations: [
      obs('p2', { weeklyRemainingPct: 2 }),
      { quotaPool: 'p2', observedAt: '2026-11-20T14:50:00Z', weeklyRemainingPct: 70 }
    ]
  })
  assert.equal(recovered.selectedSession.sessionId, 'warm')

  // stale scarce observation is not treated as permanent config
  const stale = resolveDispatchTarget({
    sessions, request, now,
    quotaObservations: [{ quotaPool: 'p2', observedAt: '2026-11-19T00:00:00Z', policy: 'conserve' }]
  })
  assert.equal(stale.selectedSession.sessionId, 'warm')
  assert.equal(stale.quotaAssessment.find((q) => q.quotaPool === 'p2').stale, true)
})

test('SP-002 shared quota pool: fallback prefers an independent pool over a same-pool model switch', () => {
  const sessions = [
    ses('claude', { model: 'claude', provider: 'anthropic', quotaPool: 'agy-claude-gpt' }),
    ses('gpt', { model: 'gpt', provider: 'openai', quotaPool: 'agy-claude-gpt' }),
    ses('gem', { model: 'gemini', provider: 'google', quotaPool: 'agy-gemini' })
  ]
  const plan = resolveDispatchTarget({
    sessions,
    request: { ...request, model: 'claude', provider: 'anthropic', quotaPool: 'agy-claude-gpt' },
    unavailableModels: ['claude'],
    fallbackCandidates: [
      { model: 'gpt', provider: 'openai', quotaPool: 'agy-claude-gpt' },
      { model: 'gemini', provider: 'google', quotaPool: 'agy-gemini' }
    ],
    quotaObservations: [obs('agy-claude-gpt', { policy: 'conserve' })],
    now
  })
  assert.equal(plan.action, 'reuse_session')
  assert.equal(plan.fallbackUsed, true)
  assert.equal(plan.selectedSession.sessionId, 'gem')
  assert.equal(plan.selectedSession.quotaPool, 'agy-gemini')
  assert.ok(plan.reasons.includes('fallback_independent_quota_pool:agy-gemini'))
  assertInventorySchema(plan, schema, 'shared-pool plan')

  // only a same-pool fallback exists: still allowed, flagged as shared
  const shared = resolveDispatchTarget({
    sessions, request: { ...request, model: 'claude', provider: 'anthropic', quotaPool: 'agy-claude-gpt' },
    unavailableModels: ['claude'],
    fallbackCandidates: [{ model: 'gpt', provider: 'openai', quotaPool: 'agy-claude-gpt' }],
    now
  })
  assert.equal(shared.selectedSession.sessionId, 'gpt')
  assert.ok(shared.reasons.includes('fallback_shares_quota_pool:agy-claude-gpt'))
})

test('SP-002 multi-role sessions and dispatch modes; role isolation still holds', () => {
  const multi = ses('multi', { role: undefined, roles: ['reviewer', 'worker'] })
  assert.equal(resolveDispatchTarget({ sessions: [multi], request, now }).selectedSession.sessionId, 'multi')
  assert.equal(resolveDispatchTarget({ sessions: [multi], request: { ...request, role: 'reviewer' }, now }).action, 'reuse_session')
  assert.equal(resolveDispatchTarget({ sessions: [multi], request: { ...request, role: 'publisher' }, now }).action, 'create_session')

  const rr = [ses('old', { lastUsedAt: '2026-11-20T10:00:00Z' }), ses('new', { lastUsedAt: '2026-11-20T14:00:00Z' })]
  const rrPlan = resolveDispatchTarget({ sessions: rr, request: { ...request, dispatchMode: 'round-robin' }, now })
  assert.equal(rrPlan.selectedSession.sessionId, 'old')

  const par = [ses('busy', { status: 'active' }), ses('free', { status: 'idle' })]
  assert.equal(resolveDispatchTarget({ sessions: par, request: { ...request, dispatchMode: 'parallel' }, now }).selectedSession.sessionId, 'free')

  const fbOnly = ses('fb', { dispatchModes: ['fallback'] })
  assert.equal(resolveDispatchTarget({ sessions: [fbOnly], request: { ...request, dispatchMode: 'parallel' }, now }).action, 'create_session')
  const bad = resolveDispatchTarget({ sessions: [], request: { ...request, dispatchMode: 'weird' }, now })
  assert.equal(bad.action, 'blocked')
  assertInventorySchema(bad, schema, 'bad-mode plan')
})

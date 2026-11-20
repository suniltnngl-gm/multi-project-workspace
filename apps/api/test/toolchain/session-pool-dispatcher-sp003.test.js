import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import {
  DEFAULT_COOLDOWNS_MS,
  DEFAULT_SESSION_TTL_MS,
  MAX_COOLDOWN_BACKOFF_MS,
  exitCodeForPlans,
  planParallelBatch,
  resolveDispatchTarget
} from '../../src/toolchain/dispatch/session-pool-dispatcher.js'
import { assessSessionHealth } from '../../src/toolchain/dispatch/session-health.js'
import { deriveIdempotencyKey } from '../../src/toolchain/dispatch/idempotency.js'
import { normalizeRepository, parseIsoStrict } from '../../src/toolchain/dispatch/portability.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schemaDir = resolve(repoRoot, 'apps/api/src/toolchain/schemas')
const schemas = {
  'session-pool-dispatch/v1.0': JSON.parse(readFileSync(resolve(schemaDir, 'session-pool-dispatch.schema.json'), 'utf8')),
  'session-pool-dispatch/v1.1': JSON.parse(readFileSync(resolve(schemaDir, 'session-pool-dispatch.v1.1.schema.json'), 'utf8'))
}
const schemaFor = (plan) => schemas[plan.schemaVersion]
const check = (plan, label = 'plan') => {
  assertInventorySchema(plan, schemaFor(plan), label)
  assert.equal(plan.readOnly, true)
  assert.equal(plan.cliArtifactBoundary.mergeNativeArtifacts, false)
  return plan
}

const GOLDEN_V10 = "[{\"schemaVersion\":\"session-pool-dispatch/v1.0\",\"mode\":\"plan\",\"readOnly\":true,\"decidedAt\":\"2026-11-20T15:00:00.000Z\",\"action\":\"reuse_session\",\"selectedSession\":{\"compositeKey\":\"agy:warm\",\"sessionId\":\"warm\",\"cli\":\"agy\",\"role\":\"worker\",\"repository\":\"mpw\",\"gateway\":\"g1\",\"provider\":\"google\",\"model\":\"m-primary\",\"quotaPool\":\"p2\",\"cacheState\":\"warm_observed\"},\"fallbackUsed\":false,\"routingKey\":\"worker|mpw|agy|g1|google|m-primary|*\",\"dispatchMode\":\"fallback\",\"quotaAssessment\":[{\"quotaPool\":\"google\",\"health\":\"unknown\",\"observedAt\":null,\"stale\":false},{\"quotaPool\":\"p1\",\"health\":\"healthy\",\"observedAt\":\"2026-11-20T14:30:00.000Z\",\"stale\":false},{\"quotaPool\":\"p2\",\"health\":\"unknown\",\"observedAt\":null,\"stale\":false},{\"quotaPool\":\"p3\",\"health\":\"unknown\",\"observedAt\":null,\"stale\":false}],\"cliArtifactBoundary\":{\"cli\":\"agy\",\"mergeNativeArtifacts\":false},\"reasons\":[\"matched_composite_key:agy:warm\",\"preferred_warm_observed\",\"quota_pool_healthy_preferred\"]},{\"schemaVersion\":\"session-pool-dispatch/v1.0\",\"mode\":\"plan\",\"readOnly\":true,\"decidedAt\":\"2026-11-20T15:00:00.000Z\",\"action\":\"reuse_session\",\"selectedSession\":{\"compositeKey\":\"agy:fb\",\"sessionId\":\"fb\",\"cli\":\"agy\",\"role\":\"worker\",\"repository\":\"mpw\",\"gateway\":\"g1\",\"provider\":\"openai\",\"model\":\"m-fb\",\"quotaPool\":\"p3\",\"cacheState\":\"warm_observed\"},\"fallbackUsed\":true,\"routingKey\":\"worker|mpw|agy|g1|google|m-primary|*\",\"dispatchMode\":\"fallback\",\"quotaAssessment\":[{\"quotaPool\":\"google\",\"health\":\"unknown\",\"observedAt\":null,\"stale\":false},{\"quotaPool\":\"p3\",\"health\":\"unknown\",\"observedAt\":null,\"stale\":false}],\"cliArtifactBoundary\":{\"cli\":\"agy\",\"mergeNativeArtifacts\":false},\"reasons\":[\"primary_model_unavailable:m-primary\",\"fallback_independent_quota_pool:p3\",\"fallback_session_reused:m-fb\",\"model_not_switched\"]}]"
const NOW = '2026-11-20T15:00:00Z'
const now = () => Date.parse(NOW)
const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString()
const ahead = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString()
const base = { cli: 'agy', repository: 'mpw', gateway: 'g1', provider: 'google', model: 'm1', status: 'idle', role: 'worker' }
const ses = (sessionId, extra = {}) => ({ ...base, sessionId, cacheState: 'warm_observed', ...extra })
const req = { role: 'worker', repository: 'mpw', cli: 'agy', gateway: 'g1', provider: 'google', model: 'm1', workItem: 'W-1' }
const plan11 = (args = {}) => check(resolveDispatchTarget({ schemaVersion: 'v1.1', now, request: req, ...args }))
const obs = (scope, target, kind, minAgo, extra = {}) => ({ scope, target, kind, observedAt: ago(minAgo), ...extra })
const fbc = (model, provider, quotaPool) => ({ model, provider, quotaPool })

test('constants: 7d TTL, cooldowns 503=5m 429=60s unavailable=15m, 30m backoff cap', () => {
  assert.equal(DEFAULT_SESSION_TTL_MS, 7 * 24 * 3600 * 1000)
  assert.deepEqual({ ...DEFAULT_COOLDOWNS_MS }, { unavailable_503: 300000, rate_limited: 60000, unavailable: 900000 })
  assert.equal(MAX_COOLDOWN_BACKOFF_MS, 1800000)
})

// ---- Health ----
test('H1/H2/H3/H4 session health gates', () => {
  const p1 = plan11({ sessions: [ses('dead', { status: 'retired' }), ses('ok')] })
  assert.equal(p1.selectedSession.sessionId, 'ok')
  assert.ok(p1.reasons.includes('session_excluded:agy:dead:unresumable'))

  const exp = plan11({ sessions: [ses('old', { lastUsedAt: ago(8 * 24 * 60) })] })
  assert.equal(exp.action, 'create_session')
  assert.equal(exp.selectedSession.model, 'm1')
  assert.equal(exp.fallbackUsed, false)
  assert.equal(plan11({ sessions: [ses('e', { expiresAt: ago(1) })] }).action, 'create_session')

  const deg = plan11({ sessions: [ses('int', { status: 'interrupted' }), ses('idle')] })
  assert.equal(deg.selectedSession.sessionId, 'idle')
  const onlyDeg = plan11({ sessions: [ses('int', { status: 'interrupted' })] })
  assert.equal(onlyDeg.selectedSession.health, 'degraded')
  assert.ok(onlyDeg.reasons.includes('degraded_session_reused'))

  const stale = plan11({ sessions: [ses('s', { health: { state: 'unresumable', observedAt: ago(600) } })] })
  assert.equal(stale.action, 'reuse_session')
})

test('Hermes: explicit future expiresAt beats lastUsedAt + TTL; past expiresAt expires', () => {
  const nowMs = now()
  const lastUsedAt = ago(30 * 24 * 60)
  assert.equal(assessSessionHealth({ lastUsedAt, expiresAt: ahead(60) }, nowMs).state, 'unknown')
  assert.equal(assessSessionHealth({ lastUsedAt }, nowMs).state, 'expired')
  assert.equal(assessSessionHealth({ lastUsedAt: ago(1), expiresAt: ago(1) }, nowMs).state, 'expired')
})

test('H5 probe is optional, read-only and never called by default', () => {
  let calls = 0
  const probe = (s) => { calls++; return { exists: s.sessionId !== 'ghost' } }
  assert.equal(plan11({ sessions: [ses('ghost'), ses('real', { cacheState: 'unknown' })], probe }).selectedSession.sessionId, 'real')
  assert.ok(calls >= 1)
  calls = 0
  plan11({ sessions: [ses('ghost')] })
  assert.equal(calls, 0)
})

// ---- Availability ----
test('A1-A4 cooldowns, expiry, retryAfter, backoff cap and ok-clearing', () => {
  const fb = [fbc('m2', 'openai', 'pool-o')]
  const sessions = [ses('p'), ses('f', { model: 'm2', provider: 'openai', quotaPool: 'pool-o' })]
  const cooling = plan11({ sessions, fallbackCandidates: fb, providerObservations: [obs('model', 'm1', 'unavailable_503', 2)] })
  assert.equal(cooling.fallbackUsed, true)
  assert.equal(cooling.selectedSession.sessionId, 'f')
  assert.ok(cooling.availability.some((a) => a.target === 'm1' && a.state === 'cooling_down'))
  assert.deepEqual(cooling.candidatesEvaluated.map((c) => c.verdict), ['skipped', 'selected'])

  assert.equal(plan11({ sessions, fallbackCandidates: fb, providerObservations: [obs('model', 'm1', 'unavailable_503', 6)] }).selectedSession.sessionId, 'p')

  const rl = plan11({ sessions, providerObservations: [obs('model', 'm1', 'rate_limited', 1, { retryAfterMs: 600000 })] })
  assert.equal(rl.action, 'deferred')
  assert.equal(rl.nextEligibleAt, ahead(9))

  const capped = plan11({ sessions, providerObservations: [obs('model', 'm1', 'unavailable_503', 0, { consecutive: 10 })] })
  assert.equal(capped.nextEligibleAt, ahead(30))

  const cleared = plan11({ sessions, providerObservations: [obs('model', 'm1', 'unavailable_503', 3), obs('model', 'm1', 'ok', 1)] })
  assert.equal(cleared.selectedSession.sessionId, 'p')
})

test('A5 provider cooldown skips its candidates; provider/gateway-scope ok clears', () => {
  const sessions = [ses('p'), ses('o', { model: 'm2', provider: 'openai', quotaPool: 'po' }), ses('a', { model: 'm3', provider: 'anthropic', quotaPool: 'pa' })]
  const fb = [fbc('m2', 'openai', 'po'), fbc('m3', 'anthropic', 'pa')]
  const p = plan11({
    sessions, fallbackCandidates: fb,
    providerObservations: [obs('model', 'm1', 'unavailable', 1), obs('provider', 'openai', 'unavailable_503', 1)]
  })
  assert.equal(p.selectedSession.sessionId, 'a')
  assert.equal(p.candidatesEvaluated[1].reason, 'provider_or_gateway_cooling')

  const providerCleared = plan11({ sessions, providerObservations: [obs('provider', 'google', 'unavailable_503', 3), obs('provider', 'google', 'ok', 1)] })
  assert.equal(providerCleared.selectedSession.sessionId, 'p')
  const gatewayCooling = plan11({ sessions, providerObservations: [obs('gateway', 'g1', 'unavailable_503', 1)] })
  assert.equal(gatewayCooling.action, 'deferred')
  const gatewayCleared = plan11({ sessions, providerObservations: [obs('gateway', 'g1', 'unavailable_503', 3), obs('gateway', 'g1', 'ok', 1)] })
  assert.equal(gatewayCleared.selectedSession.sessionId, 'p')
})

// ---- Quota ----
test('Q1-Q3 exhausted pools, reset elapsed and future reset beats staleness', () => {
  const sessions = [ses('p', { quotaPool: 'qp' })]
  const q = (extra, minAgo = 10) => ({ quotaPool: 'qp', observedAt: ago(minAgo), ...extra })
  const ex = plan11({ sessions, quotaObservations: [q({ weeklyRemainingPct: 0 })] })
  assert.notEqual(ex.action, 'reuse_session')
  assert.equal(ex.quotaAssessment.find((x) => x.quotaPool === 'qp').health, 'exhausted')

  const elapsed = plan11({ sessions, quotaObservations: [q({ weeklyRemainingPct: 0, resetAt: ago(1) })] })
  assert.equal(elapsed.action, 'reuse_session')
  assert.ok(elapsed.reasons.includes(`quota_reset_elapsed:qp@${new Date(Date.parse(ago(1))).toISOString()}`))

  const stale = plan11({ sessions, quotaObservations: [q({ exhausted: true, resetAt: ahead(120) }, 24 * 60)] })
  assert.notEqual(stale.action, 'reuse_session')
  assert.equal(stale.quotaAssessment.find((x) => x.quotaPool === 'qp').resetAt, ahead(120))

  const order = ['healthy', 'low', 'scarce'].map((h, i) => {
    const pct = { healthy: 80, low: 20, scarce: 5 }[h]
    return { quotaPool: `pool${i}`, observedAt: ago(5), weeklyRemainingPct: pct }
  })
  const o = plan11({
    sessions: [ses('s2', { quotaPool: 'pool2' }), ses('s1', { quotaPool: 'pool1' }), ses('s0', { quotaPool: 'pool0', cacheState: 'unknown' })],
    quotaObservations: order
  })
  assert.equal(o.selectedSession.sessionId, 's0')
  assert.deepEqual(o.quotaAssessment.filter((x) => x.quotaPool.startsWith('pool')).map((x) => x.health), ['healthy', 'low', 'scarce'])
})

// ---- Fallback ----
test('F1/F2 walk past exhausted candidate; exhausted primary pool triggers walk only in v1.1', () => {
  const sessions = [
    ses('p', { quotaPool: 'pp' }),
    ses('b', { model: 'm2', provider: 'openai', quotaPool: 'pb' }),
    ses('c', { model: 'm3', provider: 'anthropic', quotaPool: 'pc' })
  ]
  const fb = [fbc('m2', 'openai', 'pb'), fbc('m3', 'anthropic', 'pc')]
  const quotaObservations = [
    { quotaPool: 'pp', observedAt: ago(5), exhausted: true, resetAt: ahead(60) },
    { quotaPool: 'pb', observedAt: ago(5), weeklyRemainingPct: 0 }
  ]
  const p = plan11({ sessions, fallbackCandidates: fb, quotaObservations })
  assert.equal(p.selectedSession.sessionId, 'c')
  assert.deepEqual(p.candidatesEvaluated.map((c) => c.verdict), ['skipped', 'skipped', 'selected'])
  assert.ok(p.reasons.includes('fallback_independent_quota_pool:pc'))

  const v10 = resolveDispatchTarget({ sessions, request: req, fallbackCandidates: fb, quotaObservations, now })
  assert.equal(v10.fallbackUsed, false)
  assert.equal(v10.schemaVersion, 'session-pool-dispatch/v1.0')
})

test('F3/F4/F6 deferred vs blocked vs max depth', () => {
  const sessions = [ses('p')]
  const deferred = plan11({
    sessions, fallbackCandidates: [fbc('m2', 'openai', 'po')],
    providerObservations: [obs('model', 'm1', 'unavailable_503', 1), obs('model', 'm2', 'rate_limited', 0)]
  })
  assert.equal(deferred.action, 'deferred')
  assert.equal(deferred.nextEligibleAt, ahead(1)) // earliest of m1 (+4m) and m2 (+1m)
  assert.equal(exitCodeForPlans(deferred), 3)

  const blocked = plan11({ sessions, unavailableModels: ['m1', 'm2'], fallbackCandidates: [fbc('m2', 'openai', 'po')] })
  assert.equal(blocked.action, 'blocked')
  assert.equal(exitCodeForPlans(blocked), 2)

  const depth = plan11({
    sessions: [ses('p'), ses('b', { model: 'm2', provider: 'openai', quotaPool: 'po' }), ses('c', { model: 'm3', provider: 'x', quotaPool: 'px' })],
    unavailableModels: ['m1', 'm2'], maxFallbackDepth: 1,
    fallbackCandidates: [fbc('m2', 'openai', 'po'), fbc('m3', 'x', 'px')]
  })
  assert.equal(depth.action, 'blocked')
  assert.equal(depth.candidatesEvaluated[2].verdict, 'not_reached')
})

// ---- Round-robin ----
test('R1-R4 pool-LRU rotation across independent pools', () => {
  const rr = { ...req, dispatchMode: 'round-robin' }
  const mk = (id, pool, lastUsedAt) => ses(id, { quotaPool: pool, lastUsedAt })
  const r1 = plan11({
    request: rr,
    sessions: [mk('a-old', 'A', '2026-11-20T10:00:00Z'), mk('a-new', 'A', '2026-11-20T14:00:00Z'), mk('b', 'B', '2026-11-20T13:00:00Z')]
  })
  assert.equal(r1.selectedSession.sessionId, 'b')
  assert.equal(r1.rotation.strategy, 'pool-lru')

  const sessions = [mk('a', 'A', '2026-11-20T01:00:00Z'), mk('b', 'B', '2026-11-20T02:00:00Z'), mk('c', 'C', '2026-11-20T03:00:00Z')]
  const picks = []
  for (let i = 0; i < 4; i++) {
    const p = plan11({ request: rr, sessions, now: () => Date.parse('2026-11-20T15:00:00Z') + i * 1000 })
    picks.push(p.selectedSession.quotaPool)
    sessions.find((s) => s.sessionId === p.selectedSession.sessionId).lastUsedAt = `2026-11-20T1${i + 4}:00:00Z`
  }
  assert.deepEqual(picks, ['A', 'B', 'C', 'A'])

  const scarceObs = [{ quotaPool: 'A', observedAt: ago(5), policy: 'conserve' }]
  const two = [mk('a', 'A', '2026-11-20T01:00:00Z'), mk('b', 'B', '2026-11-20T14:00:00Z')]
  assert.equal(plan11({ request: rr, sessions: two, quotaObservations: scarceObs }).selectedSession.sessionId, 'b')
  assert.equal(plan11({ request: rr, sessions: [two[0]], quotaObservations: scarceObs }).selectedSession.sessionId, 'a')

  const usage = plan11({
    request: rr, sessions: two,
    poolUsage: [{ quotaPool: 'A', lastUsedAt: '2026-11-20T14:59:00Z' }, { quotaPool: 'B', lastUsedAt: '2026-11-20T01:00:00Z' }]
  })
  assert.equal(usage.selectedSession.sessionId, 'b')
  assert.deepEqual(usage.rotation.poolOrder, ['B', 'A'])
})

// ---- Parallel / leases / batch ----
test('P1-P4 leases, expired lease, batch exclusion and lease intent', () => {
  const sessions = [ses('warm'), ses('other', { cacheState: 'unknown' })]
  const pr = { ...req, dispatchMode: 'parallel' }
  const leased = plan11({ request: pr, sessions, leases: [{ compositeKey: 'agy:warm', holder: 'x', acquiredAt: ago(1), expiresAt: ahead(10) }] })
  assert.equal(leased.selectedSession.sessionId, 'other')
  const expired = plan11({ request: pr, sessions, leases: [{ compositeKey: 'agy:warm', holder: 'x', acquiredAt: ago(30), expiresAt: ago(5) }] })
  assert.equal(expired.selectedSession.sessionId, 'warm')
  assert.ok(expired.reasons.includes('lease_expired_ignored:agy:warm'))

  const batch = planParallelBatch({
    now, sessions, request: { role: 'worker', repository: 'mpw', cli: 'agy', gateway: 'g1', provider: 'google', model: 'm1' },
    requests: [{ workItem: 'a' }, { workItem: 'b' }, { workItem: 'c' }]
  })
  batch.forEach((b) => check(b, 'batch element'))
  assert.deepEqual(batch.map((b) => b.action), ['reuse_session', 'reuse_session', 'create_session'])
  const keys = batch.filter((b) => b.selectedSession.compositeKey).map((b) => b.selectedSession.compositeKey)
  assert.equal(new Set(keys).size, 2)

  const p = plan11({ sessions })
  assert.equal(p.selectedSession.lease.holder, p.idempotencyKey)
  assert.equal(p.selectedSession.lease.ttlMs > 0, true)
})

test('Hermes: lease is null (never a null holder) when there is no idempotencyKey', () => {
  const p = plan11({ request: { ...req, workItem: undefined }, sessions: [ses('s')] })
  assert.equal(p.idempotencyKey, null)
  assert.equal(p.selectedSession.lease, null)
  assert.equal(plan11({ sessions: [] }).selectedSession.lease, null)
})

// ---- Idempotency ----
test('I1-I5 idempotency and in-flight handling', () => {
  const k = deriveIdempotencyKey({ workItem: 'W', role: 'worker', repository: 'mpw' })
  assert.equal(k, deriveIdempotencyKey({ workItem: 'W', role: 'worker', repository: 'mpw' }))
  assert.notEqual(k, deriveIdempotencyKey({ workItem: 'W2', role: 'worker', repository: 'mpw' }))
  assert.equal(deriveIdempotencyKey({ role: 'worker' }), null)
  const sameKeyFallback = plan11({ request: { ...req, model: 'm9' }, sessions: [] })
  assert.equal(sameKeyFallback.idempotencyKey, plan11({ sessions: [] }).idempotencyKey)

  const key = plan11({ sessions: [] }).idempotencyKey
  const flight = (status, leaseExpiresAt, compositeKey = 'agy:s') => [{ idempotencyKey: key, compositeKey, startedAt: ago(20), leaseExpiresAt, status }]
  const sessions = [ses('s'), ses('t', { cacheState: 'unknown' })]

  const wait = plan11({ sessions, inFlight: flight('running', ahead(5)) })
  assert.equal(wait.action, 'await_in_flight')
  assert.equal(wait.selectedSession, null)
  assert.equal(wait.nextEligibleAt, ahead(5))
  assert.equal(exitCodeForPlans(wait), 3)

  const retry = plan11({ sessions, inFlight: flight('running', ago(5)) })
  assert.equal(retry.action, 'reuse_session')
  assert.ok(retry.reasons.includes('verify_worktree_before_retry'))

  const done = plan11({ sessions, inFlight: flight('succeeded', ago(5)) })
  assert.equal(done.action, 'blocked')
  assert.ok(done.reasons.includes(`already_completed:${key}`))
  assert.equal(check(resolveDispatchTarget({ schemaVersion: 'v1.1', now, sessions, request: { ...req, forceRetry: true }, inFlight: flight('succeeded', ago(5)) })).action, 'reuse_session')

  assert.equal(plan11({ sessions, inFlight: flight('failed', ago(5)) }).selectedSession.sessionId, 't')
})

// ---- Portability ----
test('X1/X2 repository normalisation and strict timestamps', () => {
  assert.equal(normalizeRepository('C:\\Repo\\MPW\\', 'win32'), normalizeRepository('c:/repo/mpw', 'win32'))
  assert.notEqual(normalizeRepository('/Repo/MPW', 'linux'), normalizeRepository('/repo/mpw', 'linux'))
  assert.notEqual(normalizeRepository('/Repo/MPW', 'darwin'), normalizeRepository('/repo/mpw', 'darwin'))
  assert.equal(normalizeRepository('mpw', 'win32'), 'mpw')
  assert.equal(parseIsoStrict('2026-11-20T15:00:00'), null)
  assert.equal(parseIsoStrict('2026-11-20T15:00:00+05:30'), Date.parse('2026-11-20T09:30:00Z'))

  const p = plan11({ sessions: [ses('s', { lastUsedAt: '2026-01-01T00:00:00' })] })
  assert.equal(p.action, 'reuse_session')
  assert.ok(p.reasons.includes('invalid_timestamp:agy:s.lastUsedAt'))
  const win = plan11({ platform: 'win32', request: { ...req, repository: 'C:\\Repo\\MPW' }, sessions: [ses('w', { repository: 'c:/repo/mpw/' })] })
  assert.equal(win.selectedSession.sessionId, 'w')
})

// ---- Compat / schema ----
test('C1 v1.0 default ignores SP-003 inputs; v1.0 output is byte-compatible with the SP-002 golden', () => {
  const sessions = [
    { ...base, sessionId: 'cold', cacheState: 'unknown', quotaPool: 'p1' },
    { ...base, sessionId: 'warm', cacheState: 'warm_observed', quotaPool: 'p2' },
    { ...base, sessionId: 'fb', model: 'm-fb', provider: 'openai', quotaPool: 'p3', cacheState: 'warm_observed' }
  ].map((s) => ({ ...s, model: s.model === 'm1' ? 'm-primary' : s.model }))
  const request = { ...req, model: 'm-primary', workItem: 'SP-003' }
  const a = resolveDispatchTarget({ sessions, request, now, quotaObservations: [{ quotaPool: 'p1', observedAt: '2026-11-20T14:30:00Z', weeklyRemainingPct: 50 }] })
  const b = resolveDispatchTarget({ sessions, request, now, unavailableModels: ['m-primary'], fallbackCandidates: [{ model: 'm-fb', provider: 'openai', quotaPool: 'p3' }] })
  assert.equal(JSON.stringify([a, b]), GOLDEN_V10)
  check(a); check(b)

  const ignored = resolveDispatchTarget({ sessions, request, now, providerObservations: [obs('model', 'm-primary', 'unavailable_503', 1)], leases: [] })
  assert.ok(ignored.reasons.includes('sp003_inputs_ignored:schema_v1.0'))
  assert.equal(ignored.selectedSession.sessionId, 'warm')
  assert.equal(ignored.schemaVersion, 'session-pool-dispatch/v1.0')
  check(ignored)
  assert.throws(() => resolveDispatchTarget({ schemaVersion: 'v9', request }), RangeError)
})

test('C2 v1.1 schema rejects invalid plans', () => {
  const good = plan11({ sessions: [ses('s')] })
  assert.deepEqual(validateInventorySchema(good, schemas['session-pool-dispatch/v1.1']), [])
  const { candidatesEvaluated, ...rest } = good
  const bad = { ...rest, readOnly: false, action: 'merge', cliArtifactBoundary: { cli: 'agy', mergeNativeArtifacts: true } }
  assert.ok(validateInventorySchema(bad, schemas['session-pool-dispatch/v1.1']).length >= 4)
})

test('B1 mergeNativeArtifacts is false and schema-valid for every action', () => {
  const actions = new Set()
  const cases = [
    plan11({ sessions: [ses('s')] }),
    plan11({ sessions: [] }),
    plan11({ sessions: [], unavailableModels: ['m1'] }),
    plan11({ sessions: [], providerObservations: [obs('model', 'm1', 'unavailable_503', 1)] }),
    plan11({ sessions: [ses('s')], inFlight: [{ idempotencyKey: deriveIdempotencyKey({ workItem: 'W-1', role: 'worker', repository: 'mpw' }), status: 'running', leaseExpiresAt: ahead(5) }] }),
    plan11({ sessions: [], request: { role: 'worker' } })
  ]
  for (const p of cases) { actions.add(p.action); assert.equal(p.cliArtifactBoundary.mergeNativeArtifacts, false) }
  assert.deepEqual([...actions].sort(), ['await_in_flight', 'blocked', 'create_session', 'deferred', 'reuse_session'])
})

// ---- CLI ----
const cli = (args, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sp003-'))
  try {
    const argv = []
    for (const [flag, [name, content, raw]] of Object.entries(files)) {
      const f = join(dir, name)
      writeFileSync(f, raw ? content : JSON.stringify(content))
      argv.push(flag, f)
    }
    const r = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/swarm-session-plan.mjs'), ...args, ...argv], { encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim().startsWith('[') || r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const cliBase = ['--role', 'worker', '--repo', 'mpw', '--cli', 'agy', '--model', 'm1', '--gateway', 'g1', '--provider', 'google', '--work-item', 'W-1', '--now', NOW, '--json']

test('X4 CLI v1.1 with BOM + CRLF registry and --now', () => {
  const body = `\uFEFF{\r\n  "sessions": ${JSON.stringify([ses('s')])}\r\n}\r\n`
  const r = cli(['--schema-version', 'v1.1', ...cliBase], { '--registry': ['r.json', body, true] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.schemaVersion, 'session-pool-dispatch/v1.1')
  assert.equal(r.json.decidedAt, '2026-11-20T15:00:00.000Z')
  check(r.json, 'cli plan')
})

test('CLI rejects offset-less --now via parseIsoStrict and unknown schema versions', () => {
  const r = cli([...cliBase.slice(0, -3), '--now', '2026-11-20T15:00:00', '--json'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--now/)
  assert.equal(cli(['--schema-version', 'v7', ...cliBase]).status, 1)
})

test('F5/F3/F4 CLI --fallback-candidates, deferred exit 3, blocked exit 2', () => {
  const registry = { '--registry': ['r.json', { sessions: [ses('p'), ses('g', { model: 'm2', provider: 'google2', quotaPool: 'independent' })] }] }
  const cand = { '--fallback-candidates': ['c.json', [fbc('m2', 'google2', 'independent')]] }
  const ok = cli(['--schema-version', 'v1.1', '--unavailable-model', 'm1', ...cliBase], { ...registry, ...cand })
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(ok.json.reasons.includes('fallback_independent_quota_pool:independent'))

  const deferred = cli(['--schema-version', 'v1.1', ...cliBase], { ...registry, '--provider-observations': ['o.json', [obs('model', 'm1', 'unavailable_503', 1)]] })
  assert.equal(deferred.status, 3)
  assert.equal(deferred.json.action, 'deferred')

  const blocked = cli(['--schema-version', 'v1.1', '--unavailable-model', 'm1', ...cliBase], registry)
  assert.equal(blocked.status, 2)
})

test('CLI --batch emits an array; mixed outcomes use precedence blocked(2) > deferred/await(3) > ok(0)', () => {
  const registry = { '--registry': ['r.json', { sessions: [ses('s1'), ses('s2', { cacheState: 'unknown' })] }] }
  const r = cli(['--schema-version', 'v1.1', ...cliBase], { ...registry, '--batch': ['b.json', [{ workItem: 'a' }, { workItem: 'b' }, { workItem: 'c' }]] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.length, 3)
  assert.deepEqual(r.json.map((p) => p.action), ['reuse_session', 'reuse_session', 'create_session'])
  r.json.forEach((p) => check(p, 'cli batch element'))

  assert.equal(exitCodeForPlans([{ action: 'reuse_session' }, { action: 'deferred' }]), 3)
  assert.equal(exitCodeForPlans([{ action: 'deferred' }, { action: 'blocked' }, { action: 'await_in_flight' }]), 2)
  assert.equal(exitCodeForPlans([{ action: 'create_session' }, { action: 'reuse_session' }]), 0)
  assert.equal(exitCodeForPlans([{ action: 'await_in_flight' }, { action: 'reuse_session' }]), 3)
})

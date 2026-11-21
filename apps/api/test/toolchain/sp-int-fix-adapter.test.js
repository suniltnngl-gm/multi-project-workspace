import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { resolveDispatchTarget } from '../../src/toolchain/dispatch/session-pool-dispatcher.js'
import { normalizeExecutionRequest } from '../../src/toolchain/dispatch/execution-request-adapter.js'
import { runDispatch } from '../../src/toolchain/dispatch/dispatch-executor.js'
import { createLeaseStore } from '../../src/toolchain/dispatch/lease-store.js'
import executionSchema from '../../src/toolchain/schemas/dispatch-execution.v1.schema.json' with { type: 'json' }

const now = () => Date.parse('2026-11-20T15:00:00.000Z')
const request = { role: 'worker', repository: 'mpw', cli: 'agy', gateway: 'g1', provider: 'google', model: 'm1', workItem: 'INT-FIX-07' }
const session = { sessionId: 'warm', cli: 'agy', role: 'worker', repository: 'mpw', gateway: 'g1', provider: 'google', model: 'm1', quotaPool: 'google', status: 'idle', cacheState: 'warm_observed' }

test('actual v1.1 planner output normalizes and passes through executor dry-run', async () => {
  const plannerPlan = resolveDispatchTarget({ schemaVersion: 'v1.1', now, request, sessions: [session] })
  const normalized = normalizeExecutionRequest(plannerPlan, { prompt: 'review this task', cwd: os.tmpdir() })
  assert.equal(normalized.executable, true)
  assert.equal(normalized.plan.schemaVersion, 'v1.1')
  assert.equal(normalized.plan.sessionId, 'warm')
  assert.equal(normalized.plan.compositeKey, 'agy:warm')
  assert.equal(normalized.plan.leaseTtlMs, plannerPlan.selectedSession.lease.ttlMs)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-int-adapter-'))
  try {
    const store = createLeaseStore({ stateDir: dir, now })
    const gate = { evaluateResourceGate: () => ({ verdict: 'admitted', limits: { maxConcurrentProcesses: 1 } }) }
    const result = await runDispatch({ plan: normalized.plan, store, gate, telemetry: {}, mode: 'dry-run', now })
    assert.equal(result.mode, 'dry-run')
    assert.equal(result.wouldSpawn.cwd, os.tmpdir())
    assert.equal(store.snapshot().leases.length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('planner non-executable outcomes pass through without invoking executor', () => {
  const initial = resolveDispatchTarget({ schemaVersion: 'v1.1', now, request, sessions: [] })
  const plannerPlan = resolveDispatchTarget({ schemaVersion: 'v1.1', now, request, sessions: [], inFlight: [{ idempotencyKey: initial.idempotencyKey, status: 'running', leaseExpiresAt: '2026-11-20T15:10:00.000Z' }] })
  assert.equal(plannerPlan.action, 'await_in_flight')
  const normalized = normalizeExecutionRequest(plannerPlan)
  assert.equal(normalized.executable, false)
  assert.equal(normalized.record.outcome, 'await_in_flight')
  assert.equal(normalized.record.exitCode, 3)
})

test('rejects null idempotency key for executable action and malformed lease intent', () => {
  const plannerPlan = resolveDispatchTarget({ schemaVersion: 'v1.1', now, request, sessions: [session] })
  assert.throws(() => normalizeExecutionRequest({ ...plannerPlan, idempotencyKey: null }), /idempotencyKey/)
  assert.throws(() => normalizeExecutionRequest({ ...plannerPlan, selectedSession: { ...plannerPlan.selectedSession, lease: { ...plannerPlan.selectedSession.lease, ttlMs: -1 } } }), /lease intent/)
})

test('rejects wrong schema version and unsafe artifact boundary', () => {
  assert.throws(() => normalizeExecutionRequest({ schemaVersion: 'v1.1' }), /unsupported planner schemaVersion/)
  const plannerPlan = resolveDispatchTarget({ schemaVersion: 'v1.1', now, request, sessions: [session] })
  assert.throws(() => normalizeExecutionRequest({ ...plannerPlan, cliArtifactBoundary: { mergeNativeArtifacts: true } }), /artifact boundary/)
})

test('executor contract rejection returns a schema-shaped blocked record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-int-invalid-'))
  try {
    const result = await runDispatch({ plan: { schemaVersion: 'v1.0', action: 'reuse_session', idempotencyKey: null }, store: createLeaseStore({ stateDir: dir, now }), mode: 'execute' })
    assert.equal(result.outcome, 'blocked')
    for (const key of executionSchema.required) assert.ok(Object.hasOwn(result, key), `missing ${key}`)
    assert.equal(result.idempotencyKey, null)
    assert.equal(result.action, 'reuse_session')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

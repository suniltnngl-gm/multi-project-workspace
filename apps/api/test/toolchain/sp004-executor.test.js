import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runDispatch } from '../../src/toolchain/dispatch/dispatch-executor.js'
import { createLeaseStore } from '../../src/toolchain/dispatch/lease-store.js'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { mock } from 'node:test'

describe('sp004-executor', () => {
  let stateDir, store, gate, telemetry

  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `exec-test-${Date.now()}-${Math.random()}`)
    store = createLeaseStore({ stateDir })
    gate = {
      evaluateResourceGate: () => ({ verdict: 'admitted', limits: { maxConcurrentProcesses: 2 }, primaryReason: null })
    }
    telemetry = { freeMemoryMb: 2000, loadAvg1: 0.1, cpuCount: 2, platform: 'linux' }
  })

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  const validPlan = {
    schemaVersion: 'v1.1',
    idempotencyKey: 'run-1',
    compositeKey: 'agy:sess-1',
    sessionId: 'sess-1',
    action: 'reuse_session',
    cli: 'agy',
    model: 'gpt-4',
    provider: 'openai',
    prompt: 'hello',
    cwd: os.tmpdir(),
    cliArtifactBoundary: { mergeNativeArtifacts: false }
  }

  test('blocks v1.0 plans', async () => {
    const plan = { ...validPlan, schemaVersion: 'v1.0' }
    const res = await runDispatch({ plan, store, gate, telemetry })
    assert.strictEqual(res.outcome, 'blocked')
    assert.ok(res.reason.includes('executor_contract_violation'))
  })

  test('blocks plans with mergeNativeArtifacts: true', async () => {
    const plan = { ...validPlan, cliArtifactBoundary: { mergeNativeArtifacts: true } }
    const res = await runDispatch({ plan, store, gate, telemetry })
    assert.strictEqual(res.outcome, 'blocked')
    assert.ok(res.reason.includes('mergeNativeArtifacts_must_be_false'))
  })

  test('performs dry-run without writes', async () => {
    const res = await runDispatch({ 
      plan: { ...validPlan, compositeKey: 'dry-run-sess', idempotencyKey: 'dry-run-id' }, 
      mode: 'dry-run', 
      store, 
      gate, 
      telemetry 
    })
    assert.ok(res, 'Result should be defined')
    assert.ok(res.wouldSpawn, 'Dry run should return wouldSpawn')
    assert.strictEqual(res.wouldSpawn.bin, 'agy')
    
    const snap = store.snapshot()
    assert.strictEqual(snap.leases.length, 0)
  })

  test('executes and cleans up', async () => {
    const spawnMock = {
      stderr: { on: () => {} },
      on: (evt, cb) => { if (evt === 'close') cb(0, null) },
      pid: 123
    }

    const res = await runDispatch({ 
      plan: { ...validPlan, compositeKey: 'exec-run-sess', idempotencyKey: 'exec-run-id' }, 
      mode: 'execute', 
      store, 
      gate, 
      telemetry, 
      spawnFn: () => spawnMock 
    })

    assert.strictEqual(res.outcome, 'succeeded')
    
    const snap = store.snapshot()
    assert.strictEqual(snap.leases.length, 0)
    assert.strictEqual(snap.inFlight.filter(f => f.status === 'running').length, 0)
  })
})

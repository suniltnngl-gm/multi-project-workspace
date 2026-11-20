import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createLeaseStore } from '../../src/toolchain/dispatch/lease-store.js'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

describe('sp004-lease-store', () => {
  let stateDir, store

  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `lease-test-${Date.now()}-${Math.random()}`)
    store = createLeaseStore({ stateDir })
  })

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  test('acquires and holds a lease', () => {
    const res = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    assert.strictEqual(res.ok, true)
    
    const res2 = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-2' })
    assert.strictEqual(res2.ok, false)
    assert.strictEqual(res2.reason, 'lease_held')
    assert.strictEqual(res2.holder, 'holder-1')
  })

  test('allows same-holder re-entry', () => {
    store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    const res = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.reentry, true)
  })

  test('renews a valid lease', () => {
    const res = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    const renewRes = store.renew(res.handle)
    assert.strictEqual(renewRes.ok, true)
    assert.ok(renewRes.expiresAt)
  })

  test('fails renewal if token is wrong', () => {
    const res = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    const badHandle = { ...res.handle, token: 'wrong-token' }
    const renewRes = store.renew(badHandle)
    assert.strictEqual(renewRes.ok, false)
    assert.strictEqual(renewRes.reason, 'lease_lost')
  })

  test('releases a lease', () => {
    const res = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-1' })
    const relRes = store.release(res.handle)
    assert.strictEqual(relRes.ok, true)
    
    const res2 = store.acquireLease({ compositeKey: 'session-1', holder: 'holder-2' })
    assert.strictEqual(res2.ok, true)
  })

  test('reaps expired leases', () => {
    const now = () => 1000
    const storeWithClock = createLeaseStore({ stateDir, now })
    
    // Acquire with short TTL
    storeWithClock.acquireLease({ compositeKey: 'expiring', holder: 'h1', ttlMs: 100 })
    
    // Advance clock
    const storeFuture = createLeaseStore({ stateDir, now: () => 2000 })
    const res2 = storeFuture.acquireLease({ compositeKey: 'expiring', holder: 'h2' })
    assert.strictEqual(res2.ok, true)
  })

  test('handles single-flight run records (EEXIST)', () => {
    const res = store.acquireRun({ idempotencyKey: 'run-1' })
    assert.strictEqual(res.ok, true)
    
    const res2 = store.acquireRun({ idempotencyKey: 'run-1' })
    assert.strictEqual(res2.ok, false)
    assert.strictEqual(res2.outcome, 'await_in_flight')
  })
})

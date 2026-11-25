import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOrchestratorLock,
  releaseOrchestratorLock,
  orchestratorLockPath,
  DEFAULT_ORCHESTRATOR_LOCK_TTL_MS
} from '../../../scripts/swarm-orchestrator-lock.mjs'

const killAlive = () => {}
const killDead = () => {
  const err = new Error('ESRCH')
  err.code = 'ESRCH'
  throw err
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'orchestrator-lock-'))
}

test('acquire takes the lock once and refuses a second live holder (fail closed)', () => {
  const dir = tempDir()
  try {
    const first = acquireOrchestratorLock({ stateDir: dir, runId: 'run-a', pid: 4242, killFn: killAlive })
    assert.equal(first.ok, true)
    assert.equal(first.lock.generation, 1)
    assert.equal(existsSync(orchestratorLockPath(dir)), true)

    const second = acquireOrchestratorLock({ stateDir: dir, runId: 'run-b', pid: 4243, killFn: killAlive })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'orchestrator_lock_held')
    assert.equal(second.holder, 'swarm-relay')
    assert.equal(second.runId, 'run-a')
    assert.equal(second.pid, 4242)
    assert.ok(Number.isFinite(second.ageSec))
    assert.ok(second.expiresAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an expired lock whose pid is dead is reclaimed and the generation bumps', () => {
  const dir = tempDir()
  try {
    const stale = acquireOrchestratorLock({
      stateDir: dir, runId: 'run-old', pid: 777, nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    assert.equal(stale.ok, true)
    const reclaimed = acquireOrchestratorLock({
      stateDir: dir, runId: 'run-new', pid: 778, nowMs: 5_000, ttlMs: 100, killFn: killDead
    })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.reclaimedFrom.runId, 'run-old')
    assert.equal(reclaimed.lock.generation, 2)
    assert.equal(reclaimed.lock.runId, 'run-new')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an expired lock whose pid is still alive is NOT preempted', () => {
  const dir = tempDir()
  try {
    acquireOrchestratorLock({ stateDir: dir, runId: 'run-live', pid: 888, nowMs: 1_000, ttlMs: 100, killFn: killAlive })
    const refused = acquireOrchestratorLock({ stateDir: dir, runId: 'run-other', pid: 889, nowMs: 9_000, ttlMs: 100, killFn: killAlive })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'orchestrator_lock_held')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release verifies owner (runId + generation + pid) and is idempotent', () => {
  const dir = tempDir()
  try {
    const taken = acquireOrchestratorLock({ stateDir: dir, runId: 'run-x', pid: 999, ttlMs: DEFAULT_ORCHESTRATOR_LOCK_TTL_MS, killFn: killAlive })
    assert.equal(taken.ok, true)

    const wrongOwner = releaseOrchestratorLock({ stateDir: dir, runId: 'run-y', generation: taken.lock.generation, pid: 999 })
    assert.equal(wrongOwner.ok, false)
    assert.equal(wrongOwner.reason, 'lock_owner_mismatch')
    assert.equal(existsSync(orchestratorLockPath(dir)), true)

    const released = releaseOrchestratorLock({ stateDir: dir, runId: 'run-x', generation: taken.lock.generation, pid: 999 })
    assert.equal(released.ok, true)
    assert.equal(released.released, true)
    assert.equal(existsSync(orchestratorLockPath(dir)), false)

    const again = releaseOrchestratorLock({ stateDir: dir, runId: 'run-x', generation: 1, pid: 999 })
    assert.equal(again.ok, true)
    assert.equal(again.released, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

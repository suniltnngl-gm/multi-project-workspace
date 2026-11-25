import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RESTING_STATES,
  ACTIVE_STATES,
  isResting,
  isActive,
  isReconcilable,
  assertCurrentLease,
  assertCasWrite,
  currentStateVersion,
  withNextStateVersion
} from '../../src/toolchain/dispatch/cas-state.js'
import { writeJob, readJob } from '../../src/toolchain/dispatch/job-registry.js'
import { acquireOrchestratorLock, reclaimExpiredOrchestratorLock } from '../../../../scripts/swarm-orchestrator-lock.mjs'

const killAlive = () => {}
const killDead = () => {
  const err = new Error('ESRCH')
  err.code = 'ESRCH'
  throw err
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'split-brain-'))
}

function job(over = {}) {
  return {
    jobId: 'JOB-1', taskId: 'TASK-1', title: 'guarded', priority: 'P1',
    state: 'queued', jobPlan: [{ type: 'plan', status: 'pending' }],
    originTier: 'task', authorizationRef: 'authz-1', history: [], ...over
  }
}

test('split_brain_prevented: two competing writers cannot both win one record', () => {
  const dir = tempDir()
  try {
    const leaseDir = join(dir, 'leases')
    // Writer A holds the relay-ring lease.
    const a = acquireOrchestratorLock({ stateDir: leaseDir, runId: 'run-a', resource: 'relay-ring', pid: process.pid, killFn: killAlive })
    assert.equal(a.ok, true)
    const leaseA = { dir: leaseDir, resource: 'relay-ring', runId: 'run-a', pid: process.pid, generation: a.lock.generation }

    // Writer B claims a lease too — it must be refused while A is live.
    const b = acquireOrchestratorLock({ stateDir: leaseDir, runId: 'run-b', resource: 'relay-ring', pid: process.pid + 1, killFn: killAlive })
    assert.equal(b.ok, false)
    assert.equal(b.reason, 'orchestrator_lock_held')

    // A creates the record (stateVersion 0 -> 1).
    const first = writeJob(dir, job(), { expectedStateVersion: 0, lease: leaseA })
    assert.equal(first.stateVersion, 1)

    // B presents its own version of the world: refused before any write.
    assert.throws(
      () => writeJob(dir, job({ title: 'clobbered' }), { expectedStateVersion: 0, lease: { ...leaseA, runId: 'run-b' } }),
      /orchestrator_lock_held:JOB-1/
    )

    // A writer that read v1 but lost the race to another v1 reader also loses.
    assert.throws(
      () => writeJob(dir, job({ title: 'stale winner' }), { expectedStateVersion: 0, lease: leaseA }),
      /stale_state_version:1:0/
    )
    assert.equal(readJob(dir, 'JOB-1').title, 'guarded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write without a held lease is refused outright (fail closed)', () => {
  const dir = tempDir()
  try {
    assert.throws(() => writeJob(dir, job(), { expectedStateVersion: 0 }), /lease_required:JOB-1/)
    assert.equal(existsSync(join(dir, 'JOB-1.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an expired lease and a superseded generation are both refused at the write boundary', () => {
  const dir = tempDir()
  try {
    // Live lease: the write succeeds.
    const liveDir = join(dir, 'live')
    const a = acquireOrchestratorLock({ stateDir: liveDir, runId: 'run-a', resource: 'relay-ring', pid: process.pid, killFn: killAlive })
    assert.equal(a.ok, true)
    const lease = { dir: liveDir, resource: 'relay-ring', runId: 'run-a', pid: process.pid, generation: a.lock.generation }
    const first = writeJob(dir, job(), { expectedStateVersion: 0, lease })
    assert.equal(first.stateVersion, 1)

    // Expired lease, same owner: still refused (an expired lease grants nothing).
    const expiredDir = join(dir, 'expired')
    acquireOrchestratorLock({
      stateDir: expiredDir, runId: 'run-expired', resource: 'relay-ring', pid: process.pid,
      nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    assert.throws(
      () => writeJob(dir, job(), { expectedStateVersion: first.stateVersion, lease: { ...lease, dir: expiredDir, runId: 'run-expired' } }),
      /lease_expired:JOB-1/
    )

    // Superseded generation: refused by the lease gate with its own reason.
    const gate = assertCurrentLease({
      leaseDir: liveDir, resource: 'relay-ring', runId: 'run-a',
      pid: process.pid, generation: a.lock.generation + 5
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'stale_lease_generation')

    // No lease at all on disk.
    const none = assertCurrentLease({ leaseDir: join(dir, 'absent'), resource: 'relay-ring' })
    assert.equal(none.ok, false)
    assert.equal(none.reason, 'no_lease')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reclaim writes the lease_reclaimed_split_brain_guard audit line', () => {
  const dir = tempDir()
  try {
    acquireOrchestratorLock({
      stateDir: dir, runId: 'dead-run', resource: 'quota-ledger', pid: 777,
      nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    const res = reclaimExpiredOrchestratorLock({ stateDir: dir, resource: 'quota-ledger', nowMs: 9_000, killFn: killDead })
    assert.equal(res.ok, true)
    const auditPath = join(dir, 'lifecycle-transitions.jsonl')
    assert.equal(existsSync(auditPath), true)
    const event = JSON.parse(readFileSync(auditPath, 'utf8').trim())
    assert.equal(event.event, 'lease_reclaimed_split_brain_guard')
    assert.equal(event.runId, 'dead-run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resting/active classification keeps discovery away from in-flight items', () => {
  for (const s of RESTING_STATES) assert.equal(isReconcilable(s), true, `${s} should be reconcilable`)
  for (const s of ACTIVE_STATES) {
    assert.equal(isActive(s), true)
    assert.equal(isReconcilable(s), false, `${s} must never be archived or demoted by discover`)
  }
  assert.equal(isResting('queued'), true)
  assert.equal(isResting('building'), false)
})

test('CAS version arithmetic: absent is 0, bumps are monotonic, If-Match rejects blind writes', () => {
  assert.equal(currentStateVersion(undefined), 0)
  assert.equal(currentStateVersion({}), 0)
  assert.equal(currentStateVersion({ stateVersion: 3 }), 3)
  assert.equal(withNextStateVersion({ stateVersion: 3 }).stateVersion, 4)
  assert.throws(() => assertCasWrite({}, null), /stale_state_version:missing_if_match:0/)
  assert.throws(() => assertCasWrite({ stateVersion: 2 }, 1), /stale_state_version:2:1/)
  assert.equal(assertCasWrite({ stateVersion: 2 }, 2), true)
})

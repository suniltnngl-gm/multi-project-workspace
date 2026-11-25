import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readJobs,
  readJob,
  writeJob
} from '../../src/toolchain/dispatch/job-registry.js'
import {
  readWorkItems,
  readWorkItem,
  writeWorkItem,
  claimSlot,
  releaseSlot
} from '../../src/toolchain/dispatch/work-item-registry.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'reg-lattice-'))
}

const killAlive = () => {}
const killDead = () => {
  const err = new Error('ESRCH')
  err.code = 'ESRCH'
  throw err
}

function job(over = {}) {
  return {
    jobId: 'JOB-1',
    taskId: 'TASK-1',
    title: 'Do the work',
    priority: 'P1',
    state: 'queued',
    jobPlan: [{ type: 'plan', status: 'pending' }],
    originTier: 'task',
    authorizationRef: 'authz-1',
    history: [],
    ...over
  }
}

function workItem(over = {}) {
  return {
    workItemId: 'WI-1',
    jobId: 'JOB-1',
    taskId: 'TASK-1',
    status: 'ASSIGNED',
    origin: 'job-registry',
    policyVersion: 'swarm-plan-v1',
    authorizationRef: 'authz-1',
    mutationClass: 'REVERSIBLE_MUTATE',
    scope: [],
    assignedSiblings: [],
    sessionId: null,
    quotaPool: null,
    slotRef: 'slot-1',
    runRef: null,
    scheduledAt: '2026-11-25T00:00:00.000Z',
    history: [],
    ...over
  }
}

test('job registry round-trips and bumps revision on every write', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(readJobs(dir), [])
    const first = writeJob(dir, job())
    assert.equal(first.registry.revision, 1)
    assert.equal(readJob(dir, 'JOB-1').jobId, 'JOB-1')
    const second = writeJob(dir, { ...first, state: 'deprioritized' }, { expectedRevision: 1 })
    assert.equal(second.registry.revision, 2)
    assert.equal(readJob(dir, 'JOB-1').state, 'deprioritized')
    assert.equal(readJob(dir, 'missing'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('negative: a stale expectedRevision is rejected instead of clobbering a newer write', () => {
  const dir = tempDir()
  try {
    const first = writeJob(dir, job())
    writeJob(dir, { ...first, priority: 'P0' }, { expectedRevision: 1 })
    assert.throws(
      () => writeJob(dir, { ...first, priority: 'P2' }, { expectedRevision: 1 }),
      /revision_conflict:JOB-1/
    )
    assert.equal(readJob(dir, 'JOB-1').priority, 'P0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('work-item registry round-trips and preserves scheduling fields', () => {
  const dir = tempDir()
  try {
    const written = writeWorkItem(dir, workItem())
    assert.equal(written.registry.revision, 1)
    const loaded = readWorkItem(dir, 'WI-1')
    assert.equal(loaded.slotRef, 'slot-1')
    assert.equal(loaded.status, 'ASSIGNED')
    assert.equal(readWorkItem(dir, 'nope'), null)
    assert.equal(readWorkItems(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a slot is claimed once; a live holder is never preempted', () => {
  const dir = tempDir()
  try {
    const first = claimSlot({ dir, slotRef: 'slot-1', workItemId: 'WI-1', pid: 111, killFn: killAlive })
    assert.equal(first.ok, true)
    assert.equal(existsSync(join(dir, 'slots', 'slot-1.json')), true)

    const second = claimSlot({ dir, slotRef: 'slot-1', workItemId: 'WI-2', pid: 222, killFn: killAlive })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'slot_held')
    assert.equal(second.holder, 'WI-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an expired slot whose holder is gone is reclaimed; a live holder keeps it', () => {
  const dir = tempDir()
  try {
    claimSlot({ dir, slotRef: 's', workItemId: 'WI-old', pid: 333, nowMs: 1_000, ttlMs: 100, killFn: killAlive })
    const refused = claimSlot({ dir, slotRef: 's', workItemId: 'WI-live', pid: 444, nowMs: 9_000, ttlMs: 100, killFn: killAlive })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'slot_held')

    const reclaimed = claimSlot({ dir, slotRef: 's', workItemId: 'WI-new', pid: 555, nowMs: 9_000, ttlMs: 100, killFn: killDead })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.reclaimedFrom.workItemId, 'WI-old')
    assert.equal(reclaimed.slot.generation, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('releasing a slot is owner-checked and idempotent', () => {
  const dir = tempDir()
  try {
    claimSlot({ dir, slotRef: 's', workItemId: 'WI-1', pid: 111, killFn: killAlive })
    const wrongOwner = releaseSlot({ dir, slotRef: 's', workItemId: 'WI-2', pid: 111 })
    assert.equal(wrongOwner.ok, false)
    assert.equal(wrongOwner.reason, 'slot_owner_mismatch')
    assert.equal(existsSync(join(dir, 'slots', 's.json')), true)

    const released = releaseSlot({ dir, slotRef: 's', workItemId: 'WI-1', pid: 111 })
    assert.equal(released.ok, true)
    assert.equal(existsSync(join(dir, 'slots', 's.json')), false)

    const again = releaseSlot({ dir, slotRef: 's', workItemId: 'WI-1', pid: 111 })
    assert.equal(again.ok, true)
    assert.equal(again.released, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a work-item written through the registry is valid JSON with a registry block', () => {
  const dir = tempDir()
  try {
    writeWorkItem(dir, workItem())
    const raw = JSON.parse(readFileSync(join(dir, 'WI-1.json'), 'utf8'))
    assert.equal(raw.registry.revision, 1)
    assert.ok(raw.registry.updatedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

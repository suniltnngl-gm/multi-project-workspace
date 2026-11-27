// MC-206-LOCK-SCOPE: the shared `orchestrator` lease (state root: orchestrator.lock.json)
// must fence every mutating entrypoint, not just swarm-relay --execute:
// run, overnight, queue-run, case-solve. Dry-runs and read-only probes stay lease-free.
// Inheritance: overnight holds the lease for its whole run and passes
// SWARM_ORCHESTRATOR_LEASE_PARENT to the queue-run child so it never self-deadlocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireOrchestratorLock, releaseOrchestratorLock } from '../../../scripts/swarm-orchestrator-lock.mjs'
import { createTask } from '../src/toolchain/dispatch/job-queue.js'

const QUEUE_SCRIPT = resolve(new URL('../../../scripts/swarm-queue-run.mjs', import.meta.url).pathname)
const OVERNIGHT_SCRIPT = resolve(new URL('../../../scripts/swarm-overnight.mjs', import.meta.url).pathname)
const RUN_SCRIPT = resolve(new URL('../../../scripts/swarm-run.mjs', import.meta.url).pathname)
const CASE_SOLVE_SCRIPT = resolve(new URL('../../../scripts/swarm-case-solve.mjs', import.meta.url).pathname)

function sharedLockDir(root) {
  // SWARM_STATE_DIR=<root> makes statePaths().root resolve to <root> itself.
  return root
}

function holdSharedOrchestratorLease(root, runId) {
  return acquireOrchestratorLock({ stateDir: sharedLockDir(root), runId, resource: 'orchestrator', holder: 'other-entrypoint' })
}

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc206-'))
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'queue'), { recursive: true })
  return root
}

test('MC-206: swarm-queue-run fails closed exit 3 when the shared orchestrator lease is held', () => {
  const root = setupRoot()
  const lease = holdSharedOrchestratorLease(root, 'run-other')
  try {
    createTask(join(root, 'queue'), { taskId: 'T-MC206-1', state: 'queued', jobs: [{ type: 'plan' }] })
    const child = spawnSync(process.execPath, [QUEUE_SCRIPT, '--state-dir', join(root, 'state'), '--queue-dir', join(root, 'queue'), '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(child.status, 3, `expected exit 3, got ${child.status}: ${child.stdout} ${child.stderr}`)
    const out = JSON.parse(String(child.stdout))
    assert.equal(out.tick, 'deferred_orchestrator_lease')
    assert.equal(out.resource, 'orchestrator')
    assert.equal(out.reason, 'orchestrator_lock_held')
    assert.equal(out.holder, 'other-entrypoint')
    // The live lease is untouched.
    assert.equal(JSON.parse(JSON.stringify(lease.lock)).generation, lease.lock.generation)
  } finally {
    releaseOrchestratorLock({ stateDir: sharedLockDir(root), runId: 'run-other', generation: lease.lock.generation, resource: 'orchestrator' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('MC-206: swarm-queue-run skips the orchestrator lease when inheriting from overnight', () => {
  const root = setupRoot()
  const shared = join(root, '.local', 'state', 'curl-ai-bridge')
  const parentLease = acquireOrchestratorLock({ stateDir: shared, runId: 'overnight-1', resource: 'orchestrator', holder: 'swarm-overnight' })
  // Also hold the quota-ledger in the queue-run state dir: reaching THIS refusal proves
  // the child got past the shared orchestrator stage without self-deadlocking.
  const ql = acquireOrchestratorLock({ stateDir: join(root, 'state'), runId: 'other', resource: 'quota-ledger', holder: 'other' })
  try {
    createTask(join(root, 'queue'), { taskId: 'T-MC206-2', state: 'queued', jobs: [{ type: 'plan' }] })
    const child = spawnSync(process.execPath, [QUEUE_SCRIPT, '--state-dir', join(root, 'state'), '--queue-dir', join(root, 'queue'), '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root, SWARM_ORCHESTRATOR_LEASE_PARENT: 'overnight-1' }
    })
    assert.equal(child.status, 3)
    const out = JSON.parse(String(child.stdout))
    assert.equal(out.tick, 'deferred_orchestrator_lease')
    assert.equal(out.resource, 'quota-ledger')
  } finally {
    releaseOrchestratorLock({ stateDir: shared, runId: 'overnight-1', generation: parentLease.lock.generation, resource: 'orchestrator' })
    releaseOrchestratorLock({ stateDir: join(root, 'state'), runId: 'other', generation: ql.lock.generation, resource: 'quota-ledger' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('MC-206: swarm-overnight --execute fails closed exit 3 when the shared orchestrator lease is held', () => {
  const root = setupRoot()
  const lease = holdSharedOrchestratorLease(root, 'run-other')
  try {
    const child = spawnSync(process.execPath, [OVERNIGHT_SCRIPT, '--execute', '--max-ticks', '1', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(child.status, 3, `expected exit 3, got ${child.status}: ${child.stdout} ${child.stderr}`)
    assert.match(String(child.stderr), /orchestrator_lock_held/)
    assert.match(String(child.stderr), /run-other/)
  } finally {
    releaseOrchestratorLock({ stateDir: sharedLockDir(root), runId: 'run-other', generation: lease.lock.generation, resource: 'orchestrator' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('MC-206: swarm-overnight dry-run stays lease-free and exits 0 with the lease held', () => {
  const root = setupRoot()
  const lease = holdSharedOrchestratorLease(root, 'run-other')
  try {
    const child = spawnSync(process.execPath, [OVERNIGHT_SCRIPT, '--max-ticks', '1', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(child.status, 0, `dry-run must not take the lease: ${child.stderr}`)
  } finally {
    releaseOrchestratorLock({ stateDir: sharedLockDir(root), runId: 'run-other', generation: lease.lock.generation, resource: 'orchestrator' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('MC-206: swarm-run --execute fails closed exit 3 when the shared orchestrator lease is held', () => {
  const root = setupRoot()
  const lease = holdSharedOrchestratorLease(root, 'run-other')
  try {
    const registry = join(root, 'registry.json')
    writeFileSync(registry, `${JSON.stringify({ sessions: [] }, null, 2)}\n`)
    const child = spawnSync(process.execPath, [RUN_SCRIPT, '--registry', registry, '--repository', 'multi-project-workspace', '--work-item', 'WI-MC206', '--execute', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(child.status, 3, `expected exit 3, got ${child.status}: ${child.stdout} ${child.stderr}`)
    assert.match(String(child.stderr), /orchestrator_lock_held/)
  } finally {
    releaseOrchestratorLock({ stateDir: sharedLockDir(root), runId: 'run-other', generation: lease.lock.generation, resource: 'orchestrator' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('MC-206: swarm case-solve --apply fails closed exit 3; dry-run stays lease-free', () => {
  const root = setupRoot()
  const lease = holdSharedOrchestratorLease(root, 'run-other')
  try {
    const applied = spawnSync(process.execPath, [CASE_SOLVE_SCRIPT, '--apply', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(applied.status, 3, `expected exit 3, got ${applied.status}: ${applied.stdout} ${applied.stderr}`)
    assert.match(String(applied.stderr), /orchestrator_lock_held/)

    const dry = spawnSync(process.execPath, [CASE_SOLVE_SCRIPT, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: root }
    })
    assert.equal(dry.status, 0, `dry-run must not take the lease: ${dry.stderr}`)
  } finally {
    releaseOrchestratorLock({ stateDir: sharedLockDir(root), runId: 'run-other', generation: lease.lock.generation, resource: 'orchestrator' })
    rmSync(root, { recursive: true, force: true })
  }
})

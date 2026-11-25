import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTask } from '../src/toolchain/dispatch/job-queue.js'
import {
  acquireOrchestratorLock,
  releaseOrchestratorLock,
  renewOrchestratorLock,
  reclaimExpiredOrchestratorLock,
  orchestratorLockPath
} from '../../../scripts/swarm-orchestrator-lock.mjs'

const killAlive = () => {}
const killDead = () => {
  const err = new Error('ESRCH')
  err.code = 'ESRCH'
  throw err
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'resource-lease-'))
}

test('negative: an unknown or missing resource name is refused rather than defaulted silently', () => {
  assert.throws(() => acquireOrchestratorLock({ stateDir: tempDir(), runId: 'r', resource: '' }), /resource_required/)
})

test('resources are scoped per name: two resources in one dir do not block each other', () => {
  const dir = tempDir()
  try {
    const ring = acquireOrchestratorLock({ stateDir: dir, runId: 'relay-1', resource: 'relay-ring', pid: 11, killFn: killAlive })
    const ledger = acquireOrchestratorLock({ stateDir: dir, runId: 'overnight-1', resource: 'quota-ledger', pid: 12, killFn: killAlive })
    assert.equal(ring.ok, true)
    assert.equal(ledger.ok, true)
    assert.equal(existsSync(orchestratorLockPath(dir, { resource: 'relay-ring' })), true)
    assert.equal(existsSync(orchestratorLockPath(dir, { resource: 'quota-ledger' })), true)
    // Default resource keeps the historical filename so existing callers are unaffected.
    assert.equal(orchestratorLockPath(dir), join(dir, 'orchestrator.lock.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same resource is exclusive across entrypoints (relay vs overnight)', () => {
  const dir = tempDir()
  try {
    const relay = acquireOrchestratorLock({ stateDir: dir, runId: 'relay-run', resource: 'quota-ledger', pid: 21, killFn: killAlive })
    const overnight = acquireOrchestratorLock({ stateDir: dir, runId: 'overnight-run', resource: 'quota-ledger', pid: 22, killFn: killAlive })
    assert.equal(relay.ok, true)
    assert.equal(overnight.ok, false)
    assert.equal(overnight.reason, 'orchestrator_lock_held')
    assert.equal(overnight.holder, 'swarm-relay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeat renewal extends expiry for the owner and is refused for anyone else', () => {
  const dir = tempDir()
  try {
    const taken = acquireOrchestratorLock({
      stateDir: dir, runId: 'run-a', resource: 'quota-ledger', pid: 31, nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    assert.equal(taken.ok, true)

    const renewed = renewOrchestratorLock({
      stateDir: dir, runId: 'run-a', generation: taken.lock.generation, pid: 31,
      resource: 'quota-ledger', nowMs: 500, ttlMs: 100, killFn: killAlive
    })
    assert.equal(renewed.ok, true)
    assert.equal(renewed.lock.expiresAtMs, 600)
    assert.ok(renewed.lock.renewedAt)

    const staleGeneration = renewOrchestratorLock({
      stateDir: dir, runId: 'run-a', generation: 99, pid: 31,
      resource: 'quota-ledger', nowMs: 700, ttlMs: 100, killFn: killAlive
    })
    assert.equal(staleGeneration.ok, false)
    assert.equal(staleGeneration.reason, 'lock_owner_mismatch')

    const otherOwner = renewOrchestratorLock({
      stateDir: dir, runId: 'run-b', generation: taken.lock.generation, pid: 31,
      resource: 'quota-ledger', nowMs: 700, ttlMs: 100, killFn: killAlive
    })
    assert.equal(otherOwner.ok, false)
    assert.equal(otherOwner.reason, 'lock_owner_mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit reclaim refuses a live holder even when the lease has expired', () => {
  const dir = tempDir()
  try {
    acquireOrchestratorLock({
      stateDir: dir, runId: 'live', resource: 'quota-ledger', pid: 41, nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    const refused = reclaimExpiredOrchestratorLock({ stateDir: dir, resource: 'quota-ledger', nowMs: 9_000, killFn: killAlive })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'holder_pid_alive')
    assert.equal(existsSync(orchestratorLockPath(dir, { resource: 'quota-ledger' })), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit reclaim frees an expired lease whose holder is gone, bumping the generation', () => {
  const dir = tempDir()
  try {
    acquireOrchestratorLock({
      stateDir: dir, runId: 'stale', resource: 'quota-ledger', pid: 51, nowMs: 1_000, ttlMs: 100, killFn: killAlive
    })
    const reclaimed = reclaimExpiredOrchestratorLock({ stateDir: dir, resource: 'quota-ledger', nowMs: 9_000, killFn: killDead })
    assert.equal(reclaimed.ok, true)
    assert.equal(existsSync(orchestratorLockPath(dir, { resource: 'quota-ledger' })), false)

    // The freed name can be taken again by a different holder.
    const retaken = acquireOrchestratorLock({
      stateDir: dir, runId: 'next', resource: 'quota-ledger', pid: 52, nowMs: 9_500, ttlMs: 100, killFn: killAlive
    })
    assert.equal(retaken.ok, true)
    assert.equal(retaken.lock.runId, 'next')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reclaim on an absent lease is a clean no-op, not an error', () => {
  const dir = tempDir()
  try {
    const res = reclaimExpiredOrchestratorLock({ stateDir: dir, resource: 'quota-ledger', nowMs: 1_000, killFn: killAlive })
    assert.equal(res.ok, true)
    assert.equal(res.reclaimed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relay --execute fails closed when the shared quota ledger is already leased (#209)', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-quota-lease-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    const overnight = join(home, '.local/state/curl-ai-bridge/overnight')
    mkdirSync(overnight, { recursive: true })
    // A live holder of the shared quota ledger (as an overnight supervisor would hold it).
    const lockPath = join(overnight, 'quota-ledger.lock.json')
    writeFileSync(lockPath, `${JSON.stringify({
      schema: 'orchestrator-lock/v1',
      holder: 'swarm-overnight',
      runId: 'overnight-run',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresAtMs: Date.now() + 600_000,
      generation: 1
    }, null, 2)}\n`)

    const res = spawnSync(
      process.execPath,
      [scriptPath, '--mode', 'discover', '--siblings', 'hermes', '--windows', '1', '--execute',
        '--report-dir', reports, '--ring-state-dir', ring, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home } }
    )
    assert.equal(res.status, 1)
    assert.match(String(res.stderr), /orchestrator_lock_held/)
    assert.match(String(res.stderr), /quota-ledger\.lock\.json/)
    // The live lease is untouched.
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).runId, 'overnight-run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('relay --execute takes and releases both resource leases when uncontended (#209)', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-two-leases-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const fakeBin = join(root, 'fake-sibling.mjs')
    writeFileSync(fakeBin, 'process.exit(0)\n')
    const overnight = join(home, '.local/state/curl-ai-bridge/overnight')

    const res = spawnSync(
      process.execPath,
      [scriptPath, '--mode', 'discover', '--siblings', 'hermes', '--windows', '1', '--execute',
        '--report-dir', reports, '--ring-state-dir', ring, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, SWARM_RELAY_HERMES_BIN: `${process.execPath} ${fakeBin}` } }
    )
    assert.equal(res.status, 0, String(res.stderr))
    const out = JSON.parse(String(res.stdout))
    assert.equal(out.ok, true)
    // Both leases are released after the run, not stranded for their TTL.
    assert.equal(existsSync(join(ring, 'orchestrator.lock.json')), false)
    assert.equal(existsSync(join(overnight, 'quota-ledger.lock.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('overnight --execute defers the tick instead of writing under a foreign quota-ledger lease (#209)', () => {
  const root = mkdtempSync(join(tmpdir(), 'overnight-lease-'))
  const cli = resolve(new URL('../../../scripts/swarm-overnight.mjs', import.meta.url).pathname)
  try {
    const stateDir = join(root, 'state')
    const queueDir = join(root, 'queue')
    mkdirSync(stateDir, { recursive: true })
    createTask(queueDir, { taskId: 't-lease-1', priority: 'P1', costTier: 'local', jobs: [{ type: 'plan' }] })
    const lockPath = join(stateDir, 'quota-ledger.lock.json')
    writeFileSync(lockPath, `${JSON.stringify({
      schema: 'orchestrator-lock/v1',
      holder: 'swarm-relay',
      resource: 'quota-ledger',
      runId: 'relay-run',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresAtMs: Date.now() + 600_000,
      generation: 4
    }, null, 2)}\n`)

    const res = spawnSync(
      process.execPath,
      [cli, '--state-dir', stateDir, '--queue-dir', queueDir, '--max-ticks', '1',
        '--no-lesson-sync', '--no-auto-compact', '--no-self-improve', '--execute', '--json'],
      { encoding: 'utf8' }
    )
    const out = JSON.parse(String(res.stdout))
    assert.equal(out.ok, true)
    assert.equal(out.stopReason, 'orchestrator_lease_held')
    assert.equal(out.ticks[0].status, 'deferred_orchestrator_lease')
    // The foreign lease is untouched and no pool call was recorded under it.
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).runId, 'relay-run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release remains idempotent for a resource lease', () => {
  const dir = tempDir()
  try {
    const taken = acquireOrchestratorLock({ stateDir: dir, runId: 'r', resource: 'quota-ledger', pid: 61, killFn: killAlive })
    assert.equal(taken.ok, true)
    const first = releaseOrchestratorLock({ stateDir: dir, runId: 'r', generation: taken.lock.generation, pid: 61, resource: 'quota-ledger' })
    assert.equal(first.ok, true)
    assert.equal(first.released, true)
    const second = releaseOrchestratorLock({ stateDir: dir, runId: 'r', generation: 1, pid: 61, resource: 'quota-ledger' })
    assert.equal(second.ok, true)
    assert.equal(second.released, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

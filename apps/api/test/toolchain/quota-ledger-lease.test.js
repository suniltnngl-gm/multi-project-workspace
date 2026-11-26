import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { recordPoolCall, ledgerLockPath } from '../../src/toolchain/dispatch/overnight-supervisor.js'
import { buildRelayQuotaSummary } from '../../../../scripts/swarm-doctor-quota.mjs'
import { acquireOrchestratorLock, releaseOrchestratorLock } from '../../../../scripts/swarm-orchestrator-lock.mjs'
import { createTask } from '../../src/toolchain/dispatch/job-queue.js'

const SCRIPT = resolve(new URL('../../../../scripts/swarm-queue-run.mjs', import.meta.url).pathname)

test('#216 recordPoolCall accepts the current lease generation and rejects a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-gen-'))
  let res = null
  try {
    res = acquireOrchestratorLock({ stateDir: dir, runId: 'relay-run', resource: 'quota-ledger', holder: 'swarm-relay' })
    assert.equal(res.ok, true)
    assert.ok(res.lock.generation >= 1)

    // Matching generation -> accepted and annotated.
    const okEntry = recordPoolCall(dir, { quotaPool: 'gemini-api-key', taskId: 'T-1', status: 'ok', lease: { runId: 'relay-run', generation: res.lock.generation } })
    assert.equal(okEntry.leaseGeneration, res.lock.generation)

    // Stale generation -> refused, and the refusal is auditable.
    assert.throws(
      () => recordPoolCall(dir, { quotaPool: 'gemini-api-key', taskId: 'T-2', lease: { runId: 'relay-run', generation: Number(res.lock.generation) + 5 } }),
      /stale_lease_generation/
    )
    // Different run -> lock held by someone else.
    assert.throws(
      () => recordPoolCall(dir, { quotaPool: 'gemini-api-key', lease: { runId: 'other-run', generation: res.lock.generation } }),
      /orchestrator_lock_held/
    )
    // No lease at all while the lock is live -> refused.
    assert.throws(() => recordPoolCall(dir, { quotaPool: 'gemini-api-key' }), /orchestrator_lock_held/)

    const audit = readFileSync(join(dir, 'lifecycle-transitions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(audit.length, 3)
    assert.ok(audit.every((e) => e.event === 'pool_call_rejected'))
  } finally {
    if (res?.ok) {
      releaseOrchestratorLock({ stateDir: dir, runId: 'relay-run', generation: res.lock.generation, resource: 'quota-ledger' })
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#216 recordPoolCall keeps legacy/unleased operator CLI writes working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-unleased-'))
  try {
    assert.equal(ledgerLockPath(dir).endsWith('quota-ledger.lock.json'), true)
    const entry = recordPoolCall(dir, { quotaPool: 'nous-hermes-free', source: 'swarm-ask', unleasedOperator: true })
    assert.equal(entry.unleasedOperator, true)
    assert.equal(entry.leaseRunId, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#216 swarm-queue-run fails closed when the quota-ledger lease is held elsewhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-lease-'))
  const stateDir = join(root, 'state')
  const queueDir = join(root, 'queue')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(queueDir, { recursive: true })
  const res = acquireOrchestratorLock({ stateDir, runId: 'relay-live', resource: 'quota-ledger', holder: 'swarm-relay' })
  try {
    createTask(queueDir, { taskId: 'T-LEASE-1', state: 'queued', jobs: [{ type: 'plan' }] })
    const child = spawnSync(process.execPath, [SCRIPT, '--state-dir', stateDir, '--queue-dir', queueDir, '--json'], { encoding: 'utf8' })
    assert.equal(child.status, 3, `expected deferred exit 3, got ${child.status}: ${child.stdout} ${child.stderr}`)
    const out = JSON.parse(String(child.stdout))
    assert.equal(out.tick, 'deferred_orchestrator_lease')
    assert.equal(out.reason, 'orchestrator_lock_held')
    assert.equal(out.holder, 'swarm-relay')
    assert.equal(out.runId, 'relay-live')
  } finally {
    releaseOrchestratorLock({ stateDir, runId: 'relay-live', generation: res.lock.generation, resource: 'quota-ledger' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('#233: doctor quota reads its ledger from SWARM_STATE_DIR at call time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-state-override-'))
  const prev = process.env.SWARM_STATE_DIR
  const nowMs = Date.now()
  try {
    mkdirSync(join(dir, 'overnight'), { recursive: true })
    writeFileSync(
      join(dir, 'overnight', 'pool-calls-5h.jsonl'),
      `${JSON.stringify({ atMs: nowMs, quotaPool: 'test-pool', status: 'ok' })}\n`
    )
    process.env.SWARM_STATE_DIR = dir
    const summary = buildRelayQuotaSummary({
      budgets: { 'test-pool': { pool: 'test-pool', admitted: true, cap: 5 } },
      nowMs
    })
    assert.equal(summary.pools[0].callsInWindow, 1)
  } finally {
    if (prev === undefined) delete process.env.SWARM_STATE_DIR
    else process.env.SWARM_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

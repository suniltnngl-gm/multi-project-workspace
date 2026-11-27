import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireOrchestratorLock } from '../../../../scripts/swarm-orchestrator-lock.mjs'
import { discoverCandidates, syncDiscoveredToQueue } from '../../../../scripts/swarm-discover.mjs'
import { createPlanRecord, verifyPlanBinding } from '../../src/toolchain/dispatch/plan-binding.js'
import { reconcileDiscovered } from '../../src/toolchain/dispatch/discover-reconcile.js'
import { writeTask } from '../../src/toolchain/dispatch/job-queue.js'
import { readJsonl } from '../../src/toolchain/dispatch/health-rollup.js'

const repoRoot = resolve(new URL('../../../..', import.meta.url).pathname)
const killAlive = () => {}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-telemetry-'))
  mkdirSync(join(root, 'relay'), { recursive: true })
  return root
}

function lifecycleRows(root) {
  return readJsonl(join(root, 'lifecycle-transitions.jsonl')).rows
}

test('#259: orchestrator lock refusal emits orchestrator_lock_held', () => {
  const root = fixtureRoot()
  try {
    const first = acquireOrchestratorLock({
      stateDir: join(root, 'relay'), runId: 'holder', pid: 4242, killFn: killAlive, auditDir: root
    })
    assert.equal(first.ok, true)
    const refused = acquireOrchestratorLock({
      stateDir: join(root, 'relay'), runId: 'other', pid: 4243, killFn: killAlive, auditDir: root
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'orchestrator_lock_held')
    const rows = lifecycleRows(root)
    assert.equal(rows.some((r) => r.event === 'orchestrator_lock_held'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#259: stale plan binding refusals emit stale_plan_revision / stale_base_head', () => {
  const root = fixtureRoot()
  try {
    const plan = createPlanRecord({ workItemId: 'WI-1', planRevision: 1, baseHeadSha: 'base-sha' })
    const staleRevision = verifyPlanBinding({
      plan, workItem: { currentPlanRevision: 2 }, headSha: 'base-sha', auditDir: root
    })
    assert.equal(staleRevision.reason, 'stale_plan_revision')
    const staleHead = verifyPlanBinding({
      plan, workItem: { currentPlanRevision: 1 }, headSha: 'other-sha', auditDir: root
    })
    assert.equal(staleHead.reason, 'stale_base_head')
    const events = lifecycleRows(root).map((r) => r.event)
    assert.equal(events.includes('stale_plan_revision'), true)
    assert.equal(events.includes('stale_base_head'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#259: discover fingerprint dedupe emits duplicate_fingerprint', () => {
  const root = fixtureRoot()
  try {
    const queueDir = join(root, 'queue')
    mkdirSync(queueDir, { recursive: true })
    writeTask(queueDir, {
      taskId: 'task-fp', state: 'queued', priority: 'P1', costTier: 'local', fingerprint: 'fp-259', jobs: []
    })
    const candidates = discoverCandidates({
      repoDir: root,
      seedTasks: [{ taskId: 'task-fp', priority: 'P1', costTier: 'local' }]
    }).map((c) => ({ ...c, fingerprint: 'fp-259' }))
    const result = syncDiscoveredToQueue(queueDir, candidates, { apply: true, auditDir: root })
    assert.equal(result.createdCount, 0)
    assert.equal(result.skippedCount, 1)
    assert.equal(lifecycleRows(root).some((r) => r.event === 'duplicate_fingerprint'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#259: reconcileDiscovered duplicate attach emits duplicate_fingerprint', () => {
  const root = fixtureRoot()
  try {
    const res = reconcileDiscovered({
      candidates: [{ id: 'c2', fingerprint: 'fp-reconcile', title: 'later' }],
      existing: [{ id: 'c1', fingerprint: 'fp-reconcile', state: 'queued' }],
      auditDir: root
    })
    assert.equal(res.attached.length, 1)
    assert.equal(lifecycleRows(root).some((r) => r.event === 'duplicate_fingerprint'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#259: swarm health --json reports the emitted split-brain counters', () => {
  const root = fixtureRoot()
  try {
    acquireOrchestratorLock({ stateDir: join(root, 'relay'), runId: 'holder', pid: 4242, killFn: killAlive, auditDir: root })
    acquireOrchestratorLock({ stateDir: join(root, 'relay'), runId: 'other', pid: 4243, killFn: killAlive, auditDir: root })
    const plan = createPlanRecord({ workItemId: 'WI-1', planRevision: 1, baseHeadSha: 'base-sha' })
    verifyPlanBinding({ plan, workItem: { currentPlanRevision: 2 }, headSha: 'base-sha', auditDir: root })
    reconcileDiscovered({
      candidates: [{ id: 'c2', fingerprint: 'fp-reconcile', title: 'later' }],
      existing: [{ id: 'c1', fingerprint: 'fp-reconcile', state: 'queued' }],
      auditDir: root
    })

    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/swarm-health.mjs'), '--json'], {
      cwd: repoRoot,
      env: { ...process.env, SWARM_STATE_DIR: root },
      encoding: 'utf8'
    })
    assert.equal(run.status, 0, String(run.stderr))
    const report = JSON.parse(run.stdout)
    assert.equal(report.sources.lifecycleTransitions.present, true)
    assert.ok(report.splitBrain.leaseContentionsBlocked > 0)
    assert.ok(report.splitBrain.stalePlansBlocked > 0)
    assert.ok(report.splitBrain.discoverDuplicatesDeduped > 0)
    assert.deepEqual(report.splitBrain.notInstrumented, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeHealthRollup, readJsonl } from '../../src/toolchain/dispatch/health-rollup.js'
import { statePaths } from '../../../../scripts/swarm-state-paths.mjs'

function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'health-rollup-'))
  const root = join(dir, 'state')
  mkdirSync(join(root, 'repo-checkpoints'), { recursive: true })
  mkdirSync(join(root, 'overnight'), { recursive: true })
  mkdirSync(join(root, 'relay'), { recursive: true })
  return root
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

test('missing sources are tolerated and reported as absent, never fatal', () => {
  const root = fixtureRoot()
  try {
    const report = computeHealthRollup({ paths: statePaths({ SWARM_STATE_DIR: root }), nowMs: 1_000 })
    assert.equal(report.schema, 'swarm-health-rollup/v1')
    assert.equal(report.readOnly, true)
    assert.equal(report.sources.checkpointLedger.present, false)
    assert.equal(report.delivery.commitsPushed, 0)
    assert.equal(report.delivery.gateProvenanceRate, null)
    assert.equal(report.ring, null)
    for (const key of report.splitBrain.notInstrumented) assert.equal(report.splitBrain[key], null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a truncated trailing JSONL line is skipped and counted, valid rows still count', () => {
  const file = join(fixtureRoot(), 'ledger.jsonl')
  writeFileSync(file, `${JSON.stringify({ pushed: true, filesCount: 2 })}\n{"truncated": true\n`)
  const res = readJsonl(file)
  assert.equal(res.rows.length, 1)
  assert.equal(res.malformedLinesSkipped, 1)
  assert.equal(res.present, true)
})

test('split-brain counters come only from real events; uninstrumented ones stay null', () => {
  const root = fixtureRoot()
  try {
    writeJsonl(join(root, 'lifecycle-transitions.jsonl'), [
      { event: 'lease_reclaimed_split_brain_guard', runId: 'old' },
      { event: 'demoted_to_case', workItemId: 'WI-1', trail: ['work-item>job', 'job>task', 'task>case'] },
      { event: 'plan_replan', planRevision: 2 },
      { event: 'build_rebuild', rebuildCount: 1 },
      { event: 'pool_call_rejected', reason: 'stale_lease_generation', holder: 'relay-run' }
    ])
    const report = computeHealthRollup({ paths: statePaths({ SWARM_STATE_DIR: root }), nowMs: 2_000 })
    assert.equal(report.splitBrain.deadLeasesReclaimed, 1)
    assert.equal(report.splitBrain.circuitBreakerDemotions, 1)
    assert.equal(report.splitBrain.replanLoops, 1)
    assert.equal(report.splitBrain.rebuildLoops, 1)
    assert.equal(report.splitBrain.casConflictsPrevented, 1)
    // No instrumentation exists for these yet — reported as null, never an invented zero.
    assert.equal(report.splitBrain.stalePlansBlocked, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('quarantine snapshots under repo-checkpoints are counted; a real tree is untouched', () => {
  const root = fixtureRoot()
  try {
    const q = join(root, 'repo-checkpoints', 'quarantine', 'stamp-1')
    mkdirSync(q, { recursive: true })
    writeFileSync(join(q, 'tracked.txt'), 'orphan\n')
    writeFileSync(join(q, 'stray.txt'), 'orphan\n')
    const report = computeHealthRollup({ paths: statePaths({ SWARM_STATE_DIR: root }), nowMs: 3_000 })
    assert.equal(report.splitBrain.dirtyTreesQuarantined, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkpoint ledger aggregates delivery metrics and gate-provenance rate', () => {
  const root = fixtureRoot()
  try {
    writeJsonl(join(root, 'repo-checkpoints', 'checkpoint-ledger.jsonl'), [
      { commitSha: 'a', pushed: true, filesCount: 2, quotaTurnsSaved: 2, verdictArtifactPath: '/x.json' },
      { commitSha: 'b', pushed: true, backupsCount: 5, quotaTurnsSaved: 3, hallucinationsCaught: 1 },
      { commitSha: 'c', pushed: false, filesCount: 1 }
    ])
    const report = computeHealthRollup({ paths: statePaths({ SWARM_STATE_DIR: root }), nowMs: 4_000 })
    assert.equal(report.delivery.commitsPushed, 3)
    assert.equal(report.delivery.filesProtected, 8)
    assert.equal(report.delivery.quotaTurnsSaved, 5)
    assert.equal(report.delivery.hallucinationsCaught, 1)
    assert.equal(report.delivery.withGateProvenance, 1)
    assert.equal(report.delivery.gateProvenanceRate, 33.3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('per-pool utilization uses the rolling 5h window and separates ok/failover/other', () => {
  const root = fixtureRoot()
  try {
    const now = 10_000_000
    writeJsonl(join(root, 'overnight', 'pool-calls-5h.jsonl'), [
      { quotaPool: 'gemini-api-key', status: 'ok', model: 'gemini-3.8-flash', atMs: now - 1_000 },
      { quotaPool: 'gemini-api-key', status: 'ok_after_model_retry', primaryModel: 'gemma-4-31b-it', atMs: now - 2_000 },
      { quotaPool: 'gemini-api-key', status: 'exit_1', atMs: now - 3_000 },
      { quotaPool: 'nous-hermes-free', status: 'stall_killed', atMs: now - 4_000 },
      { quotaPool: 'nous-hermes-free', status: 'ok', atMs: now - 99 * 60 * 60 * 1000 }
    ])
    writeFileSync(join(root, 'relay', 'ring-state.json'), `${JSON.stringify({
      runId: 'run-1', generation: 7, round: 2, window: 3, activeSlot: 'sibling2', mode: 'pipeline'
    }, null, 2)}\n`)
    const report = computeHealthRollup({ paths: statePaths({ SWARM_STATE_DIR: root }), nowMs: now })
    const gemini = report.pools.byPool['gemini-api-key']
    assert.equal(gemini.calls, 3)
    assert.equal(gemini.ok, 2) // plain ok + ok_after_model_retry
    assert.equal(gemini.failover, 0)
    assert.equal(gemini.other, 1)
    // The hermes call older than 5h is excluded from the window.
    assert.equal(report.pools.byPool['nous-hermes-free'].calls, 1)
    assert.deepEqual(report.pools.geminiModelDistribution, { 'gemini-3.8-flash': 1, 'gemma-4-31b-it': 1 })
    assert.equal(report.ring.generation, 7)
    assert.equal(report.ring.runId, 'run-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  STAGE_VERDICTS,
  DEFAULT_MAX_REPLANS,
  DEFAULT_MAX_REBUILDS,
  ADJACENT_DEMOTION_HOPS,
  recordReplanAttempt,
  recordRebuildAttempt,
  adjacentTierDemotion,
  preBuildGuard
} from '../../src/toolchain/dispatch/delivery-pipeline.js'
import { prioritizeTaskAsJob, scheduleJobAsWorkItem } from '../../src/toolchain/dispatch/registry-lattice.js'

function scheduledWorkItem(over = {}) {
  const job = prioritizeTaskAsJob(
    { id: 'TASK-1', title: 'pipe', state: 'queued', kind: 'task' },
    { priority: 'P1', authorizationRef: 'authz-1', jobId: 'JOB-1' }
  )
  return scheduleJobAsWorkItem(job, { slotRef: 'slot-1', authorizationRef: 'authz-1', sessionId: 'sess-1', ...over })
}

test('replan attempts are bounded and overflow requests an adjacent-tier demotion', () => {
  assert.equal(STAGE_VERDICTS.PLAN_REPLAN, 'REPLAN')
  assert.equal(DEFAULT_MAX_REPLANS, 2)
  assert.equal(recordReplanAttempt({ replanCount: 0 }).action, 'replan')
  assert.equal(recordReplanAttempt({ replanCount: 1 }).action, 'replan')
  const overflow = recordReplanAttempt({ replanCount: 2 })
  assert.equal(overflow.action, 'demote')
  assert.equal(overflow.reason, 'max_replans_exceeded')
})

test('rebuild attempts share the same bound contract', () => {
  assert.equal(STAGE_VERDICTS.BUILD_REBUILD, 'REBUILD')
  assert.equal(DEFAULT_MAX_REBUILDS, 2)
  assert.equal(recordRebuildAttempt({ rebuildCount: 1 }).action, 'rebuild')
  const overflow = recordRebuildAttempt({ rebuildCount: 2 })
  assert.equal(overflow.action, 'demote')
  assert.equal(overflow.reason, 'max_rebuilds_exceeded')
})

test('adjacent-tier demotion walks Work-Item -> Job -> Task -> Case with no shortcut', () => {
  const hops = ADJACENT_DEMOTION_HOPS.map((h) => `${h.from}>${h.to}`)
  assert.deepEqual(hops, ['work-item>job', 'job>task', 'task>case'])

  const out = adjacentTierDemotion({
    workItem: scheduledWorkItem(),
    options: ['opt-1', 'opt-2'],
    ctx: { reason: 'max_replans_exceeded' }
  })
  assert.equal(out.ok, true)
  assert.equal(out.job.state, 'queued')
  assert.equal(out.task.kind, 'task')
  assert.equal(out.case.kind, 'case')
  assert.equal(out.case.options.length, 2)
  assert.deepEqual(out.trail.map((t) => t.ok), [true, true, true])
})

test('negative: demotion without two viable options stops instead of forcing a case', () => {
  assert.throws(
    () => adjacentTierDemotion({ workItem: scheduledWorkItem(), options: ['only-one'] }),
    /demote_requires_multiple_options/
  )
})

test('preBuildGuard refuses a stale plan before any edit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-guard-'))
  try {
    const wi = { workItemId: 'WI-JOB-1', currentPlanRevision: 2 }
    const planPath = join(dir, 'plan.json')
    writeFileSync(planPath, `${JSON.stringify({
      schema: 'swarm-build-plan/v1', workItemId: 'WI-JOB-1', planRevision: 1, baseHeadSha: 'abc'
    }, null, 2)}\n`)
    const res = preBuildGuard({
      repoDir: dir, workItemId: 'WI-JOB-1', planPath, workItem: wi, headSha: 'abc',
      readFile: (p, enc) => readFileSync(p, enc)
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'stale_plan_revision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('live call site: relay --execute fails closed on a stale planRevision before any edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-wi-guard-'))
  const scriptPath = resolve(new URL('../../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const wiDir = join(home, '.local/state/curl-ai-bridge/registries/work-items')
    mkdirSync(wiDir, { recursive: true })
    writeFileSync(join(wiDir, 'WI-JOB-1.json'), `${JSON.stringify({
      workItemId: 'WI-JOB-1', jobId: 'JOB-1', taskId: 'TASK-1', status: 'ASSIGNED',
      currentPlanRevision: 2, slotRef: 'slot-1', origin: 'job-registry',
      policyVersion: 'swarm-plan-v1', authorizationRef: 'authz-1', stateVersion: 1
    }, null, 2)}\n`)
    const planPath = join(root, 'plan.json')
    writeFileSync(planPath, `${JSON.stringify({
      schema: 'swarm-build-plan/v1', workItemId: 'WI-JOB-1', planRevision: 1, baseHeadSha: 'deadbeef'
    }, null, 2)}\n`)

    const res = spawnSync(
      process.execPath,
      [scriptPath, '--mode', 'pipeline', '--windows', '1', '--execute',
        '--report-dir', join(root, 'reports'), '--ring-state-dir', join(root, 'ring'),
        '--work-item', 'WI-JOB-1', '--plan-file', planPath, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home } }
    )
    assert.equal(res.status, 1)
    assert.match(String(res.stderr), /pre_build_guard:stale_plan_revision/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live call site: relay refuses a half-supplied work-item binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-wi-half-'))
  const scriptPath = resolve(new URL('../../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const res = spawnSync(
      process.execPath,
      [scriptPath, '--mode', 'discover', '--windows', '1', '--execute',
        '--report-dir', join(root, 'reports'), '--ring-state-dir', join(root, 'ring'),
        '--work-item', 'WI-X', '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home } }
    )
    assert.equal(res.status, 1)
    assert.match(String(res.stderr), /--work-item and --plan-file must be supplied together/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preBuildGuard passes a bound plan on a clean tree and reports the quarantine verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-guard-ok-'))
  try {
    const wi = { workItemId: 'WI-JOB-1', currentPlanRevision: 1 }
    const planPath = join(dir, 'plan.json')
    writeFileSync(planPath, `${JSON.stringify({
      schema: 'swarm-build-plan/v1', workItemId: 'WI-JOB-1', planRevision: 1, baseHeadSha: 'abc'
    }, null, 2)}\n`)
    const calls = []
    const res = preBuildGuard({
      repoDir: dir, workItemId: 'WI-JOB-1', planPath, workItem: wi, headSha: 'abc',
      readFile: (p, enc) => readFileSync(p, enc),
      quarantine: (args) => { calls.push(args); return { ok: true, reason: 'clean', quarantined: [] } }
    })
    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].workItemId, 'WI-JOB-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

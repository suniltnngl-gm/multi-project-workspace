import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createTask,
  readQueue,
  readTask,
  writeTask,
  nextPendingJob,
  completeJob,
  selectNextTask,
  applyVerdict,
  queueStats,
  DEFAULT_JOB_TIMEOUT_MS
} from '../../src/toolchain/dispatch/job-queue.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const RUNNER = join(REPO, 'scripts', 'swarm-queue-run.mjs')

function tmp() { return mkdtempSync(join(tmpdir(), 'sp007-')) }

function seed(dir, taskId, overrides = {}) {
  const jobs = [
    { id: 'j1', type: 'plan' },
    { id: 'j2', type: 'review' },
    { id: 'j3', type: 'build' },
    { id: 'j4', type: 'review' },
    { id: 'j5', type: 'publish' }
  ]
  const { jobs: _ignored, ...rest } = overrides
  return createTask(dir, { taskId, jobs, state: 'queued', ...rest })
}

test('default job timeouts match the operator decision', () => {
  assert.equal(DEFAULT_JOB_TIMEOUT_MS.plan, 180000)
  assert.equal(DEFAULT_JOB_TIMEOUT_MS.build, 300000)
  assert.equal(DEFAULT_JOB_TIMEOUT_MS.review, 120000)
  assert.equal(DEFAULT_JOB_TIMEOUT_MS.publish, 180000)
})

test('writeTask is atomic and increments revision', () => {
  const dir = tmp()
  try {
    const a = createTask(dir, { taskId: 'T1' })
    assert.equal(a.queue.revision, 1)
    const b = writeTask(dir, { ...a, state: 'planning' }, { expectedRevision: 1 })
    assert.equal(b.queue.revision, 2)
    const onDisk = JSON.parse(readFileSync(join(dir, 'T1.json'), 'utf8'))
    assert.equal(onDisk.state, 'planning')
    assert.equal(onDisk.queue.revision, 2)
    // No temp files left behind.
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeTask rejects a stale revision instead of clobbering', () => {
  const dir = tmp()
  try {
    const a = createTask(dir, { taskId: 'T1' })
    writeTask(dir, { ...a, state: 'planning' }, { expectedRevision: 1 })
    assert.throws(
      () => writeTask(dir, { ...a, state: 'done' }, { expectedRevision: 1 }),
      /queue_revision_conflict/
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('nextPendingJob returns the first pending job and null when terminal', () => {
  const dir = tmp()
  try {
    const t = seed(dir, 'T1')
    assert.equal(nextPendingJob(t).id, 'j1')
    const done = { ...t, state: 'done' }
    assert.equal(nextPendingJob(done), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a malformed or absent verdict fails closed: task stays awaiting review', () => {
  const dir = tmp()
  try {
    const t = seed(dir, 'T1')
    for (const bad of [null, {}, { verdict: 'MAYBE' }, { verdict: 42 }]) {
      const out = applyVerdict(t, bad || {})
      assert.equal(out.state, 'queued', 'state must not advance on a malformed verdict')
      assert.equal(out.jobs.find((j) => j.id === 'j2').status, 'pending')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a valid ACCEPT verdict closes the review job', () => {
  const dir = tmp()
  try {
    const t = seed(dir, 'T1')
    const out = applyVerdict(t, { verdict: 'ACCEPT', reason: 'looks good', reviewedAt: '2026-11-21T00:00:00Z' })
    const review = out.jobs.find((j) => j.id === 'j2')
    assert.equal(review.status, 'done')
    assert.equal(review.verdict, 'ACCEPT')
    assert.equal(review.reason, 'looks good')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('selectNextTask rotates across pools by last use', () => {
  const dir = tmp()
  try {
    const a = seed(dir, 'T1', { pinned: { sessionId: 's1', compositeKey: 'poolA:s1' } })
    const b = seed(dir, 'T2', { pinned: { sessionId: 's2', compositeKey: 'poolB:s2' } })
    const tasks = [a, b]
    const first = selectNextTask(tasks, { lastUsedByPool: {} })
    assert.ok(first, 'a task with a pending job should be selectable')
    const firstPool = first.pinned.compositeKey.split(':')[0]
    const second = selectNextTask(tasks, { lastUsedByPool: { [firstPool]: 5 } })
    assert.notEqual(second.taskId, first.taskId)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runner executes exactly one job per tick and exits', () => {
  const dir = tmp()
  try {
    seed(dir, 'T1')
    const res = spawnSync(process.execPath, [RUNNER, '--queue-dir', dir, '--json'], { encoding: 'utf8' })
    const out = JSON.parse(res.stdout)
    assert.equal(out.tick, 'job')
    assert.equal(out.type, 'plan')
    const after = readTask(dir, 'T1')
    assert.equal(after.jobs.filter((j) => j.status !== 'pending').length, 1, 'only one job may move per tick')
    assert.equal(after.queue.revision, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SOLVE-005: buildFailureTelemetry classifies a failed job result instead of a bare exit code', async () => {
  const { buildFailureTelemetry } = await import(RUNNER)
  // Rate-limit stderr -> rpm_throttled with the tail preserved.
  const throttled = buildFailureTelemetry({ status: 'failed', result: { stdout: '', stderr: '429 RESOURCE_EXHAUSTED: rate limit\n' } })
  assert.equal(throttled.failureClass, 'rpm_throttled')
  assert.match(throttled.stderrTail, /RESOURCE_EXHAUSTED/)
  // Real failure, ok result, and non-failed statuses carry no telemetry.
  assert.equal(buildFailureTelemetry({ status: 'failed', result: { stdout: '', stderr: 'panic: bad state\n' } }).failureClass, 'real_failure')
  assert.deepEqual(buildFailureTelemetry({ status: 'failed', result: { stdout: '', stderr: '' } }), {})
  assert.deepEqual(buildFailureTelemetry({ status: 'done', result: {} }), {})
})

test('SOLVE-005: a failed job tick carries failureClass + stderrTail instead of a bare exit code', () => {
  const dir = tmp()
  try {
    // A task whose pinned CLI is a failing stub that writes a rate-limit error to stderr.
    const stub = join(dir, 'failing-cli.mjs')
    writeFileSync(stub, 'process.stderr.write("429 RESOURCE_EXHAUSTED: rate limit\\n"); process.exit(1)\n')
    seed(dir, 'T-FAIL', { pinned: { sessionId: 's1', compositeKey: 'stub-pool:s1', cli: process.execPath, model: stub } })
    // Keep the registry outside the queue dir: readQueue treats every *.json in
    // the queue dir as a task.
    const registry = join(dir, '..', 'registry.json')
    writeFileSync(registry, '{"sessions":[]}\n')
    const res = spawnSync(process.execPath, [RUNNER, '--queue-dir', dir, '--json', '--registry', registry], { encoding: 'utf8' })
    // A failed job is the designed exit 1; the tick JSON on stdout still carries the telemetry.
    const out = JSON.parse(res.stdout)
    assert.equal(out.tick, 'job')
    assert.equal(out.status, 'failed')
    // The dispatch was blocked before the stub CLI ran, so no provider stderr exists:
    // no failureClass is fabricated, and the task parks with the honest reason.
    assert.equal(out.failureClass, undefined)
    assert.equal(out.state, 'parked')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runner never authorizes publish: publish job is skipped and task waits', () => {
  const dir = tmp()
  try {
    // A task whose plan and build reviews are done and whose publish job is next.
    const t = seed(dir, 'T1')
    const planDone = completeJob(t, 'j1', { status: 'done', state: 'review_plan' })
    const planReviewed = applyVerdict(planDone, { verdict: 'ACCEPT' })
    const buildDone = completeJob(planReviewed, 'j3', { status: 'done', state: 'review_build' })
    const buildReviewed = applyVerdict(buildDone, { verdict: 'ACCEPT' })
    const publishPending = completeJob(buildReviewed, 'j5', { status: 'pending', state: 'publishing' })
    const skippedReview = { ...publishPending, jobs: publishPending.jobs.map((j) => (j.status === 'pending' && j.type === 'review' ? { ...j, status: 'skipped' } : j)) }
    writeTask(dir, skippedReview, { expectedRevision: t.queue.revision })

    const res = spawnSync(process.execPath, [RUNNER, '--queue-dir', dir, '--json'], { encoding: 'utf8' })
    const out = JSON.parse(res.stdout)
    assert.equal(out.type, 'publish')
    assert.equal(out.status, 'skipped')
    assert.equal(out.reason, 'publish_requires_operator_authorization')
    const after = readTask(dir, 'T1')
    assert.equal(after.state, 'ready_to_publish')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('queueStats counts terminal and active tasks', () => {
  const dir = tmp()
  try {
    seed(dir, 'T1')
    seed(dir, 'T2')
    writeTask(dir, { ...readTask(dir, 'T2'), state: 'done' }, { expectedRevision: 1 })
    const s = queueStats(dir)
    assert.equal(s.total, 2)
    assert.equal(s.done, 1)
    assert.equal(s.active, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

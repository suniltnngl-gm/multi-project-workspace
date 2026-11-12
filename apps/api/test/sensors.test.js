// Objective: Test deterministic sensor detection, finding lifecycle, scan audits, promotion, and the local API surface.
// Requirements: Detectors stay pure and zero-token; dismissed findings stay muted; scans auto-resolve and reopen only the right states; promotion creates one task and records its event.
// Decisions: A synthetic snapshot drives detector assertions, while one shared database and app exercise persistence and routes the way the rest of the API suite does; manual findings keep lifecycle tests independent of the current workspace contents.
// Relevant Files: apps/api/test/sensors.test.js, apps/api/src/workspaceSensors.js, apps/api/src/db/sensors.js, apps/api/src/routes/sensors.js
// Important Context: User file. Sensors are separate from model-generated task proposals.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { runSensorScan, SENSOR_CATALOG } from '../src/workspaceSensors.js'

let directory
let database
let server
let baseUrl

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-01-10T12:00:00.000Z')

function syntheticSnapshot() {
  const thresholds = {
    staleTaskHours: 72,
    staleRunHours: 24,
    sampleLimit: 10,
    staleTaskMs: 72 * HOUR,
    staleRunMs: 24 * HOUR
  }
  const old = new Date(NOW - 100 * HOUR).toISOString()
  return {
    now: NOW,
    thresholds,
    tasks: [
      {
        id: 1, title: 'Blocked without a reason', status: 'blocked', priority: 'high',
        work_blocked: '', next_move: '', updated_at: old
      },
      {
        id: 2, title: 'Stale progress', status: 'in_progress', priority: 'medium',
        work_blocked: '', next_move: '', updated_at: old
      },
      { id: 3, title: 'Same title', status: 'todo', updated_at: old },
      { id: 4, title: 'same   title', status: 'blocked', updated_at: old }
    ],
    agentRuns: [{
      id: 'run_test',
      state: 'running',
      updatedAt: NOW - 30 * HOUR,
      startedAt: NOW - 30 * HOUR,
      createdAt: NOW - 30 * HOUR,
      budget: { maxTokens: 10, maxCalls: 5 }
    }],
    agentRunUsage: {
      run_test: { calls: 1, promptTokens: 6, completionTokens: 6, totalTokens: 12, durationMs: 1000 }
    },
    models: [{
      id: 'model-a',
      label: 'Model A',
      provider: 'provider-a',
      configured: false,
      budget: { observed: { requests: 3 }, limiters: [] }
    }],
    providers: [{
      provider: 'provider-a',
      groupKey: 'provider-a',
      ok: false,
      retryAfter: 30,
      modelCount: 1,
      models: [{ id: 'model-a', ok: false, headroom: 0, retryAfter: 30 }]
    }],
    tools: [{ name: 'git', command: 'git', available: false, checkedAt: old }],
    environments: [{ id: 1, name: 'os', value: 'linux' }],
    repositories: [
      { id: 1, name: 'repo', rootPath: '/missing/repo', rootExists: false },
      { id: 2, name: 'present', rootPath: '/present', rootExists: true }
    ],
    gitWorktrees: [{
      id: 1, repositoryId: 1, worktreePath: '/missing/worktree', branch: 'main', pathExists: false
    }],
    userFiles: [
      { id: 1, repositoryId: 1, path: 'src/a.js', objective: '', missingAt: null },
      { id: 2, repositoryId: 1, path: 'src/b.js', objective: '', missingAt: old }
    ],
    folders: [{ id: 1, repositoryId: 1, path: 'src', objective: '' }],
    agentScripts: [{
      id: 'scr_test', name: 'scan-files', intent: 'scan', version: 1, costClass: 'low'
    }],
    mcpServers: [{
      id: 1, name: 'mcp-test', status: 'error', statusError: 'boom', lastSeenAt: old
    }]
  }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-sensors-'))
  database = createDatabase(join(directory, 'sensors.sqlite'))
  server = createApp(database, { models: [] }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

test('detectors report every scripted gap from one snapshot', () => {
  const { findings, errors } = runSensorScan({ snapshot: syntheticSnapshot() })
  assert.deepEqual(errors, [])
  const sensors = new Set(findings.map((finding) => finding.sensorId))
  for (const id of [
    'task.blocked_without_reason',
    'task.missing_next_move',
    'task.stale_in_progress',
    'task.duplicate_active_title',
    'agent_run.stale',
    'agent_run.budget_exhausted',
    'provider.quota_blocked',
    'model.usage_without_profile',
    'tool.unavailable',
    'mcp.server_error',
    'tracking.file_missing',
    'tracking.files_without_objective',
    'tracking.folders_without_objective',
    'tracking.repository_root_missing',
    'tracking.worktree_missing',
    'tracking.script_unverified'
  ]) {
    assert.ok(sensors.has(id), `expected ${id}`)
  }
  const duplicate = findings.find((finding) => finding.sensorId === 'task.duplicate_active_title')
  assert.deepEqual(duplicate.details.taskIds, [3, 4])
  const missingFiles = findings.find((finding) => finding.sensorId === 'tracking.file_missing')
  assert.equal(missingFiles.details.count, 1)
  assert.equal(missingFiles.details.sample[0].path, 'src/b.js')
  const budget = findings.find((finding) => finding.sensorId === 'agent_run.budget_exhausted')
  assert.equal(budget.details.remaining.tokens, -2)
  assert.equal(findings[0].severity, 'high', 'high severity sorts first')
})

test('scans keep lifecycle state and reopen only resolved findings', () => {
  const finding = {
    key: 'test:lifecycle',
    sensorId: 'test.lifecycle',
    severity: 'medium',
    title: 'Lifecycle finding',
    summary: 'first summary',
    entity: { type: 'test', id: '1' },
    details: { step: 1 }
  }
  const run = database.createSensorRun({ sensors: 1 })
  const created = database.applySensorScan([finding], { scanId: run.id })
  assert.deepEqual(created, { created: 1, updated: 0, unchanged: 0, resolved: 0, reopened: 0 })
  let stored = database.getSensorFindingByKey('test:lifecycle')
  assert.equal(stored.state, 'open')
  assert.equal(stored.occurrences, 1)

  const unchanged = database.applySensorScan([finding], { scanId: run.id })
  assert.deepEqual(unchanged, { created: 0, updated: 0, unchanged: 1, resolved: 0, reopened: 0 })

  const changed = database.applySensorScan([{ ...finding, summary: 'second summary' }], { scanId: run.id })
  assert.deepEqual(changed, { created: 0, updated: 1, unchanged: 0, resolved: 0, reopened: 0 })
  stored = database.getSensorFindingByKey('test:lifecycle')
  assert.equal(stored.summary, 'second summary')
  assert.equal(stored.occurrences, 3)

  assert.equal(database.acknowledgeSensorFinding(stored.id).finding.state, 'acknowledged')
  const resolved = database.applySensorScan([], { scanId: run.id })
  assert.deepEqual(resolved, { created: 0, updated: 0, unchanged: 0, resolved: 1, reopened: 0 })
  assert.equal(database.getSensorFinding(stored.id).state, 'resolved')

  const reopened = database.applySensorScan([finding], { scanId: run.id })
  assert.deepEqual(reopened, { created: 0, updated: 0, unchanged: 0, resolved: 0, reopened: 1 })
  assert.equal(database.getSensorFinding(stored.id).state, 'open')

  assert.equal(database.dismissSensorFinding(stored.id, { note: 'intentional' }).finding.state, 'dismissed')
  const muted = database.applySensorScan([], { scanId: run.id })
  assert.equal(muted.resolved, 0)
  assert.equal(database.getSensorFinding(stored.id).state, 'dismissed')
  const stillMuted = database.applySensorScan([finding], { scanId: run.id })
  assert.equal(stillMuted.reopened, 0)
  assert.equal(database.getSensorFinding(stored.id).state, 'dismissed')

  const conflict = database.acknowledgeSensorFinding(stored.id)
  assert.equal(conflict.error.status, 409)
  assert.equal(database.getSensorFindingByKey('missing:key'), null)
  const detail = database.getSensorFindingDetail(stored.id)
  assert.ok(detail.events.some((event) => event.action === 'reopened'))
  assert.ok(detail.events.some((event) => event.action === 'dismissed'))
})

test('promotion creates a task only from an open finding', () => {
  const finding = {
    key: 'test:promote',
    sensorId: 'test.promote',
    severity: 'high',
    title: 'Promote me',
    summary: 'Promotion summary',
    entity: { type: 'test', id: '2' },
    details: {}
  }
  database.applySensorScan([finding])
  const stored = database.getSensorFindingByKey('test:promote')
  const promoted = database.promoteSensorFinding(stored.id, { project: 'quality' })
  assert.equal(promoted.task.title, 'Promote me')
  assert.equal(promoted.task.project, 'quality')
  assert.equal(promoted.task.priority, 'high')
  assert.equal(promoted.task.task_type, 'chore')
  assert.equal(promoted.finding.state, 'acknowledged')
  assert.equal(promoted.finding.note, `Promoted to task #${promoted.task.id}.`)
  const detail = database.getSensorFindingDetail(stored.id)
  assert.ok(detail.events.some((event) => event.action === 'promoted'))

  const again = database.promoteSensorFinding(stored.id, {})
  assert.equal(again.error.status, 409)
  assert.equal(database.promoteSensorFinding(999999, {}).error.status, 404)
})

test('sensor routes scan, filter, transition, promote, and audit', async () => {
  const blocked = database.createTask({
    title: 'Route blocked without reason',
    status: 'blocked',
    priority: 'high'
  })

  const catalogResponse = await fetch(`${baseUrl}/api/sensors/catalog`)
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json()
  assert.equal(catalog.sensors.length, SENSOR_CATALOG.length)
  assert.ok(catalog.states.includes('dismissed'))
  assert.ok(catalog.thresholds.staleTaskHours >= 1)

  const scanResponse = await post('/api/sensors/scan')
  assert.equal(scanResponse.status, 200)
  const scan = await scanResponse.json()
  assert.equal(scan.run.status, 'completed')
  assert.ok(scan.findings.length > 0)
  assert.ok(scan.counts.created > 0)
  assert.ok(scan.summary.active > 0)

  const blockedFinding = scan.findings.find(
    (finding) => finding.sensorId === 'task.blocked_without_reason'
      && finding.details.taskId === blocked.id
  )
  assert.ok(blockedFinding, 'blocked task produces a finding')

  const listResponse = await fetch(`${baseUrl}/api/sensors/findings?state=open&severity=high&limit=10`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.ok(listed.length > 0)
  assert.ok(listed.every((finding) => finding.state === 'open' && finding.severity === 'high'))

  const stored = database.getSensorFindingByKey(blockedFinding.key)
  const detailResponse = await fetch(`${baseUrl}/api/sensors/findings/${stored.id}?event_limit=5`)
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.ok(detail.events.some((event) => event.action === 'created'))

  const ackResponse = await post(`/api/sensors/findings/${stored.id}/ack`, { note: 'known' })
  assert.equal(ackResponse.status, 200)
  assert.equal((await ackResponse.json()).state, 'acknowledged')
  const ackAgain = await post(`/api/sensors/findings/${stored.id}/ack`, {})
  assert.equal(ackAgain.status, 409)

  const dismissResponse = await post(`/api/sensors/findings/${stored.id}/dismiss`, { note: 'muted' })
  assert.equal(dismissResponse.status, 200)
  assert.equal((await dismissResponse.json()).state, 'dismissed')

  const reopenResponse = await post(`/api/sensors/findings/${stored.id}/reopen`)
  assert.equal(reopenResponse.status, 200)
  assert.equal((await reopenResponse.json()).state, 'open')

  const promoteResponse = await post(`/api/sensors/findings/${stored.id}/promote`, {
    priority: 'urgent',
    project: 'quality',
    task_type: 'bug'
  })
  assert.equal(promoteResponse.status, 201)
  const promoted = await promoteResponse.json()
  assert.equal(promoted.task.priority, 'urgent')
  assert.equal(promoted.task.task_type, 'bug')
  assert.equal(promoted.finding.state, 'acknowledged')

  const promoteAgain = await post(`/api/sensors/findings/${stored.id}/promote`)
  assert.equal(promoteAgain.status, 409)
  const missing = await post('/api/sensors/findings/999999/promote')
  assert.equal(missing.status, 404)
  const badState = await fetch(`${baseUrl}/api/sensors/findings?state=nope`)
  assert.equal(badState.status, 400)
  const badLimit = await fetch(`${baseUrl}/api/sensors/findings?limit=9999`)
  assert.equal(badLimit.status, 400)
  const badNote = await post(`/api/sensors/findings/${stored.id}/resolve`, { note: 5 })
  assert.equal(badNote.status, 400)

  const runsResponse = await fetch(`${baseUrl}/api/sensors/runs?limit=5`)
  assert.equal(runsResponse.status, 200)
  const runs = await runsResponse.json()
  assert.ok(runs.length >= 1)
  assert.ok(runs[0].id >= scan.run.id)
  const runResponse = await fetch(`${baseUrl}/api/sensors/runs/${scan.run.id}`)
  assert.equal(runResponse.status, 200)
  assert.equal((await runResponse.json()).detected, scan.run.detected)

  const summaryResponse = await fetch(`${baseUrl}/api/sensors/summary`)
  assert.equal(summaryResponse.status, 200)
  const summary = await summaryResponse.json()
  assert.ok(summary.total >= 1)
  assert.equal(summary.states.open + summary.states.acknowledged, summary.active)
})

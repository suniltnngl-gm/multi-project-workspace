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
import Database from 'better-sqlite3'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { createSensorsStore } from '../src/db/sensors.js'
import {
  autoPromoteSeverities,
  createSensorCycleScheduler,
  resolveCycleConfig,
  runSensorCycle
} from '../src/sensorCycles.js'
import {
  buildWorkspaceSnapshot,
  resolveSensorConfig,
  runSensorScan,
  SENSOR_CATALOG,
  SENSOR_IDEAS,
  SENSORS
} from '../src/workspaceSensors.js'

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
    metadataStaleHours: 720,
    sampleLimit: 10,
    staleTaskMs: 72 * HOUR,
    staleRunMs: 24 * HOUR,
    metadataStaleMs: 720 * HOUR
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
    'tracking.script_unverified',
    'task.project_blocker_cluster'
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
  assert.equal(database.reopenSensorFinding(stored.id).error.status, 409)
  const resolved = database.applySensorScan([], { scanId: run.id })
  assert.deepEqual(resolved, { created: 0, updated: 0, unchanged: 0, resolved: 1, reopened: 0 })
  assert.equal(database.getSensorFinding(stored.id).state, 'resolved')

  const reopened = database.applySensorScan([finding], { scanId: run.id })
  assert.deepEqual(reopened, { created: 0, updated: 0, unchanged: 0, resolved: 0, reopened: 1 })
  assert.equal(database.getSensorFinding(stored.id).state, 'open')

  assert.equal(database.dismissSensorFinding(stored.id, { note: 'intentional' }).finding.state, 'dismissed')
  assert.equal(database.dismissSensorFinding(stored.id).error.status, 409)
  assert.equal(database.resolveSensorFinding(stored.id).error.status, 409)
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

  assert.equal(database.reopenSensorFinding(stored.id).finding.state, 'open')
  assert.equal(
    database.resolveSensorFinding(stored.id, { note: 'manual resolve' }).finding.state,
    'resolved'
  )
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

test('run audit helpers record trigger, promotion, and failure', () => {
  const run = database.createSensorRun({
    sensors: 2,
    triggerKind: 'cli',
    startedAt: NOW
  })
  assert.equal(run.triggerKind, 'cli')
  const finished = database.finishSensorRun(run.id, {
    sensors: 2,
    detected: 1,
    created: 1,
    promoted: 1
  })
  assert.equal(finished.status, 'completed')
  assert.equal(finished.detected, 1)
  assert.equal(finished.promoted, 1)

  const failing = database.createSensorRun({
    sensors: 1,
    triggerKind: 'scheduled',
    startedAt: NOW
  })
  const failed = database.failSensorRun(failing.id, 'scan exploded')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'scan exploded')
  assert.equal(database.getSensorRun(failing.id).status, 'failed')
})

test('the snapshot builder captures model budgets, run usage, and paths', () => {
  const snapshotDatabase = createDatabase(join(directory, 'snapshot.sqlite'), {
    rootDir: directory
  })
  try {
    const missing = snapshotDatabase.ensureRepository('/missing/repo').repository
    const thrower = snapshotDatabase.ensureRepository('/throw/repo').repository
    snapshotDatabase.createFolder({ path: 'present', repositoryId: 1 })
    snapshotDatabase.createFolder({ path: 'gone', repositoryId: missing.id })
    snapshotDatabase.createAgentRun({
      id: 'run_live',
      state: 'running',
      budget: { maxTokens: 10 },
      createdAt: NOW - HOUR,
      updatedAt: NOW - HOUR
    })
    snapshotDatabase.addAgentRunUsage({
      runId: 'run_live',
      calls: 1,
      totalTokens: 4,
      createdAt: NOW - HOUR
    })
    snapshotDatabase.scanGitWorktrees([{
      repositoryRoot: directory,
      worktreePath: '/worktrees/present',
      branch: 'main'
    }])

    const snapshot = buildWorkspaceSnapshot({
      database: snapshotDatabase,
      models: [
        {
          id: 'model-x',
          label: 'Model X',
          provider: 'provider-a',
          billingCategory: 'free'
        },
        {
          id: 'model-b',
          label: 'Model B',
          provider: 'provider-a',
          billingCategory: 'free'
        }
      ],
      modelBudget: {
        snapshot: (modelId) => {
          if (modelId === 'model-b') throw new Error('budget unavailable')
          return { headroom: 7 }
        }
      },
      now: NOW,
      env: {},
      pathExists: (path) => {
        if (String(path).includes('throw')) throw new Error('filesystem exploded')
        return !String(path).includes('missing')
      }
    })

    const models = new Map(snapshot.models.map((model) => [model.id, model]))
    assert.deepEqual(models.get('model-x').budget, { headroom: 7 })
    assert.equal(models.get('model-b').budget, undefined)
    assert.equal(snapshot.agentRunUsage.run_live.totalTokens, 4)

    const repositories = new Map(
      snapshot.repositories.map((repository) => [repository.id, repository])
    )
    assert.equal(repositories.get(1).rootExists, true)
    assert.equal(repositories.get(missing.id).rootExists, false)
    assert.equal(repositories.get(thrower.id).rootExists, false)

    const folders = new Map(snapshot.folders.map((folder) => [folder.path, folder]))
    assert.equal(folders.get('present').pathExists, true)
    assert.equal(folders.get('gone').pathExists, false)
    assert.equal(snapshot.gitWorktrees[0].pathExists, true)
  } finally {
    snapshotDatabase.close()
  }
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
  const badRunLimit = await fetch(`${baseUrl}/api/sensors/runs?limit=999`)
  assert.equal(badRunLimit.status, 400)
  const badSeverity = await fetch(`${baseUrl}/api/sensors/findings?severity=nope`)
  assert.equal(badSeverity.status, 400)
  const badSensor = await fetch(`${baseUrl}/api/sensors/findings?sensor_id=%20`)
  assert.equal(badSensor.status, 400)
  const filteredSensor = await fetch(
    `${baseUrl}/api/sensors/findings?sensor_id=task.blocked_without_reason`
  )
  assert.equal(filteredSensor.status, 200)
  assert.ok(
    (await filteredSensor.json()).every(
      (finding) => finding.sensorId === 'task.blocked_without_reason'
    )
  )
  const badEventLimit = await fetch(
    `${baseUrl}/api/sensors/findings/${stored.id}?event_limit=999`
  )
  assert.equal(badEventLimit.status, 400)
  const badField = await post(`/api/sensors/findings/${stored.id}/promote`, { title: 5 })
  assert.equal(badField.status, 400)
  const badPriority = await post(
    `/api/sensors/findings/${stored.id}/promote`,
    { priority: 'nope' }
  )
  assert.equal(badPriority.status, 400)
  const badTaskType = await post(
    `/api/sensors/findings/${stored.id}/promote`,
    { task_type: 'nope' }
  )
  assert.equal(badTaskType.status, 400)
  const badTitle = await post(
    `/api/sensors/findings/${stored.id}/promote`,
    { title: '   ' }
  )
  assert.equal(badTitle.status, 400)

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

test('detectors suggest a new sensor only when the snapshot proves the gap', () => {
  const snapshot = structuralClone(syntheticSnapshot())
  const { findings, errors } = runSensorScan({ snapshot })
  assert.deepEqual(errors, [])

  const projectCluster = findings.find(
    (finding) => finding.sensorId === 'task.project_blocker_cluster'
      && finding.entity.id === 'workspace'
  )
  assert.ok(projectCluster, 'two blocked workspace tasks trigger task.project_blocker_cluster')
  assert.equal(projectCluster.details.project, 'workspace')
  assert.equal(projectCluster.details.count, 2)

  const covered = new Set(SENSORS.map((sensor) => sensor.id))
  for (const idea of SENSOR_IDEAS) {
    assert.ok(!covered.has(idea.id), `${idea.id} is already implemented but still suggested`)
  }

  snapshot.folders[0].pathExists = false
  const withFolderGap = runSensorScan({ snapshot }).findings.find(
    (finding) => finding.sensorId === 'meta.sensor_suggestion'
      && finding.entity.id === 'tracking.folder_missing'
  )
  assert.ok(withFolderGap, 'a missing tracked folder proves the folder gap')
  assert.equal(withFolderGap.details.evidence.folders[0].path, 'src')

  const differentProjects = structuralClone(syntheticSnapshot())
  differentProjects.tasks[0].project = 'alpha'
  differentProjects.tasks[3].project = 'beta'
  const none = runSensorScan({ snapshot: differentProjects }).findings.filter(
    (finding) => finding.sensorId === 'meta.sensor_suggestion'
  )
  assert.equal(none.length, 0, 'split projects do not prove a project-level cluster')

  const allIdeas = structuralClone(syntheticSnapshot())
  allIdeas.tasks.push({
    id: 5,
    title: 'Aging high-priority task',
    status: 'todo',
    priority: 'high',
    updated_at: new Date(NOW - 100 * HOUR).toISOString()
  })
  allIdeas.folders[0].pathExists = false
  allIdeas.environments[0].checkedAt = new Date(NOW - 800 * HOUR).toISOString()
  allIdeas.mcpServers[0].lastSeenAt = new Date(NOW - 800 * HOUR).toISOString()
  allIdeas.agentScripts[0].verifiedAt = new Date(NOW - 800 * HOUR).toISOString()
  allIdeas.findings = [{
    id: 9,
    sensorId: 'provider.quota_blocked',
    occurrences: 3,
    entity: { type: 'provider', id: 'provider-a' }
  }]
  allIdeas.agentRuns.push({
    id: 'run_nousage',
    state: 'running',
    updatedAt: NOW,
    startedAt: NOW,
    createdAt: NOW,
    budget: { maxTokens: 0, maxCalls: 0 }
  })
  const allFindings = runSensorScan({ snapshot: allIdeas }).findings
  const allSuggestions = allFindings.filter(
    (finding) => finding.sensorId === 'meta.sensor_suggestion'
  )
  assert.deepEqual(
    allSuggestions.map((finding) => finding.entity.id).sort(),
    SENSOR_IDEAS.map((idea) => idea.id).sort(),
    'every candidate idea is suggested once its evidence exists'
  )
  const priorityIdea = allSuggestions.find(
    (finding) => finding.entity.id === 'task.priority_aging'
  )
  assert.equal(priorityIdea.details.evidence.tasks[0].taskId, 5)
  const recurringIdea = allSuggestions.find(
    (finding) => finding.entity.id === 'quota.provider_recurring_block'
  )
  assert.equal(recurringIdea.details.evidence.providers[0].groupKey, 'provider-a')
  const noUsage = allFindings.find(
    (finding) => finding.sensorId === 'agent_run.budget_exhausted'
      && finding.entity.id === 'run_nousage'
  )
  assert.equal(noUsage.details.usage.totalTokens, 0)
  assert.equal(noUsage.details.remaining.tokens, 0)

  const catalog = new Set(SENSOR_CATALOG.map((sensor) => sensor.id))
  assert.ok(catalog.has('meta.sensor_suggestion'))
})

test('an atomic cycle records run, findings, and promotions together', () => {
  const databasePath = join(directory, 'cycle-atomic.sqlite')
  const cycleDatabase = createDatabase(databasePath)
  try {
    const high = {
      key: 'test:cycle-high',
      sensorId: 'test.cycle',
      severity: 'high',
      title: 'Cycle high',
      summary: 'High finding',
      entity: { type: 'test', id: 'high' },
      details: {}
    }
    const medium = {
      key: 'test:cycle-medium',
      sensorId: 'test.cycle',
      severity: 'medium',
      title: 'Cycle medium',
      summary: 'Medium finding',
      entity: { type: 'test', id: 'medium' },
      details: {}
    }
    const at = Date.parse('2026-02-01T00:00:00.000Z')
    const result = cycleDatabase.applySensorCycle({
      findings: [high, medium],
      sensors: 2,
      triggerKind: 'cli',
      promoteSeverities: ['high'],
      promoteProject: 'quality',
      promoteTaskType: 'bug',
      at
    })

    assert.equal(result.run.status, 'completed')
    assert.equal(result.run.triggerKind, 'cli')
    assert.equal(result.run.sensors, 2)
    assert.equal(result.run.detected, 2)
    assert.equal(result.run.promoted, 1)
    assert.deepEqual(result.counts, {
      created: 2, updated: 0, unchanged: 0, resolved: 0, reopened: 0
    })
    assert.equal(result.promotions.length, 1)
    assert.equal(result.promotions[0].task.project, 'quality')
    assert.equal(result.promotions[0].task.task_type, 'bug')
    assert.equal(result.promotions[0].task.priority, 'high')
    assert.equal(cycleDatabase.getSensorFindingByKey(high.key).state, 'acknowledged')
    assert.equal(cycleDatabase.getSensorFindingByKey(medium.key).state, 'open')
    const runs = cycleDatabase.listSensorRuns({ limit: 5 })
    assert.equal(runs[0].id, result.run.id)
    assert.equal(runs[0].triggerKind, 'cli')
    assert.equal(runs[0].promoted, 1)
  } finally {
    cycleDatabase.close()
  }
})

test('a failed promotion rolls back the whole cycle', () => {
  const databasePath = join(directory, 'cycle-rollback.sqlite')
  const connection = new Database(databasePath)
  connection.pragma('foreign_keys = ON')
  runMigrations(connection)
  const store = createSensorsStore(connection, {
    tasks: {
      createTask() {
        throw new Error('task write failed')
      }
    }
  })
  try {
    const finding = {
      key: 'test:rollback',
      sensorId: 'test.rollback',
      severity: 'high',
      title: 'Rollback me',
      summary: 'Rollback summary',
      entity: { type: 'test', id: 'rollback' },
      details: {}
    }
    store.applySensorScan([finding])
    assert.equal(store.listSensorRuns({ limit: 10 }).length, 0)

    assert.throws(
      () => store.applySensorCycle({
        findings: [finding],
        sensors: 1,
        promoteSeverities: ['high']
      }),
      /task write failed/
    )

    assert.equal(store.listSensorRuns({ limit: 10 }).length, 0)
    assert.equal(store.getSensorFindingByKey(finding.key).state, 'open')
    const detail = store.getSensorFindingDetail(
      store.getSensorFindingByKey(finding.key).id
    )
    assert.ok(detail, 'finding detail still exists after rollback')
    assert.ok(
      !detail.events.some((event) => event.action === 'promoted'),
      'the rolled-back promotion left no event'
    )
    connection.prepare(
      'UPDATE sensor_findings SET details = ? WHERE key = ?'
    ).run('{not valid json', finding.key)
    assert.deepEqual(store.getSensorFindingByKey(finding.key).details, {})
  } finally {
    connection.close()
  }
})

test('cycle records detector errors without losing good findings', () => {
  const databasePath = join(directory, 'cycle-errors.sqlite')
  const cycleDatabase = createDatabase(databasePath)
  try {
    assert.throws(
      () => runSensorCycle({ database: cycleDatabase, triggerKind: 'nope' }),
      /triggerKind/
    )
    const result = runSensorCycle({
      database: cycleDatabase,
      // A bad scheduler interval must not break a manual cycle; only the
      // periodic scheduler validates it.
      env: { SENSOR_CYCLE_INTERVAL_MS: '500' },
      now: Date.parse('2026-03-01T00:00:00.000Z'),
      sensors: [
        {
          id: 'test.throws',
          detect() {
            throw new Error('detector boom')
          }
        },
        {
          id: 'test.works',
          detect() {
            return [{
              key: 'test:worked',
              severity: 'low',
              title: 'Worked',
              summary: 'A good finding',
              entity: { type: 'test', id: 'worked' },
              details: {}
            }]
          }
        }
      ]
    })

    assert.equal(result.failed, false)
    assert.equal(result.run.status, 'failed')
    assert.ok(result.run.error.includes('test.throws: detector boom'))
    assert.equal(result.errors.length, 1)
    assert.equal(result.findings.length, 1)
    assert.equal(cycleDatabase.getSensorFindingByKey('test:worked').state, 'open')
  } finally {
    cycleDatabase.close()
  }
})

test('cycle config validates intervals, policies, and severity mapping', () => {
  const defaults = resolveCycleConfig({ env: {} })
  assert.equal(defaults.intervalMs, 0)
  assert.equal(defaults.autoPromote, 'off')
  assert.equal(defaults.runOnStart, false)
  assert.equal(defaults.taskType, 'chore')
  assert.throws(
    () => resolveSensorConfig({ env: { SENSOR_STALE_TASK_HOURS: 'not-a-number' } }),
    /number between/
  )
  assert.throws(
    () => resolveCycleConfig({ env: { SENSOR_CYCLE_INTERVAL_MS: '500' } }),
    /at least 1000/
  )
  assert.throws(
    () => resolveCycleConfig({ env: { SENSOR_CYCLE_AUTO_PROMOTE: 'sometimes' } }),
    /one of/
  )
  assert.throws(
    () => resolveCycleConfig({ env: { SENSOR_CYCLE_TASK_TYPE: 'nope' } }),
    /one of/
  )
  assert.throws(
    () => resolveCycleConfig({ env: { SENSOR_CYCLE_INTERVAL_MS: 'not-a-number' } }),
    /number between/
  )
  assert.equal(
    resolveCycleConfig({ env: { SENSOR_CYCLE_RUN_ON_START: 'yes' } }).runOnStart,
    true
  )
  assert.equal(
    resolveCycleConfig({ env: { SENSOR_CYCLE_RUN_ON_START: 'off' } }).runOnStart,
    false
  )
  assert.throws(
    () => resolveCycleConfig({ env: { SENSOR_CYCLE_RUN_ON_START: 'maybe' } }),
    /boolean/
  )
  const configured = resolveCycleConfig({
    env: {
      SENSOR_CYCLE_INTERVAL_MS: '5000',
      SENSOR_CYCLE_AUTO_PROMOTE: 'medium',
      SENSOR_CYCLE_PROJECT: '  ops  ',
      SENSOR_CYCLE_TASK_TYPE: 'bug'
    }
  })
  assert.equal(configured.intervalMs, 5000)
  assert.equal(configured.autoPromote, 'medium')
  assert.equal(configured.project, 'ops')
  assert.equal(configured.taskType, 'bug')
  assert.deepEqual(autoPromoteSeverities('off'), [])
  assert.deepEqual(autoPromoteSeverities('high'), ['high'])
  assert.deepEqual(autoPromoteSeverities('medium'), ['high', 'medium'])
  assert.deepEqual(autoPromoteSeverities('all'), ['low', 'medium', 'high'])
  assert.throws(() => autoPromoteSeverities('nope'), /one of/)
})

test('the periodic scheduler skips overlapping ticks and stops cleanly', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const scheduler = createSensorCycleScheduler({
    intervalMs: 0,
    logger: { error() {} },
    runCycle: async ({ triggerKind }) => {
      calls += 1
      await gate
      return { triggerKind, failed: false }
    }
  })

  const first = scheduler.runNow()
  const skipped = await scheduler.runNow()
  assert.equal(skipped.skipped, true)
  release()
  const result = await first
  assert.equal(result.triggerKind, 'manual')
  assert.equal(calls, 1)
  const status = scheduler.getStatus()
  assert.equal(status.runs, 1)
  assert.equal(status.skipped, 1)
  assert.equal(status.started, false)

  let ticks = 0
  const periodic = createSensorCycleScheduler({
    intervalMs: 20,
    logger: { error() {} },
    runCycle: async () => {
      ticks += 1
      return { failed: false }
    }
  })
  periodic.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 80))
  } finally {
    periodic.stop()
  }
  assert.ok(ticks >= 1, 'the scheduler ran at least one tick')
  assert.equal(periodic.getStatus().started, false)

  let failures = 0
  const failing = createSensorCycleScheduler({
    intervalMs: 0,
    logger: { error() { failures += 1 } },
    runCycle: async () => ({ failed: true, error: 'cycle boom' })
  })
  await failing.runNow()
  assert.equal(failures, 1)
  assert.equal(failing.getStatus().failures, 1)
  assert.equal(failing.getStatus().lastError, 'cycle boom')

  assert.throws(() => createSensorCycleScheduler({}), /runCycle/)
  assert.throws(
    () => createSensorCycleScheduler({ runCycle() {}, intervalMs: -1 }),
    /non-negative/
  )

  let rejectedErrors = 0
  const rejecting = createSensorCycleScheduler({
    intervalMs: 0,
    logger: { error() { rejectedErrors += 1 } },
    runCycle: async () => {
      throw new Error('runner boom')
    }
  })
  const rejected = await rejecting.runNow()
  assert.equal(rejected.failed, true)
  assert.equal(rejected.error, 'runner boom')
  assert.equal(rejectedErrors, 1)
  assert.equal(rejecting.getStatus().failures, 1)
  assert.equal(rejecting.getStatus().lastError, 'runner boom')

  let startedTicks = 0
  const runOnStartScheduler = createSensorCycleScheduler({
    intervalMs: 0,
    runOnStart: true,
    logger: { error() {} },
    runCycle: async () => {
      startedTicks += 1
      return { failed: false }
    }
  })
  runOnStartScheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  runOnStartScheduler.stop()
  assert.equal(startedTicks, 1)
  assert.equal(runOnStartScheduler.getStatus().started, false)
})

test('cycle and suggestion routes expose ideas, promotions, and validation', async () => {
  const cycleDirectory = await mkdtemp(join(tmpdir(), 'workspace-cycle-routes-'))
  const cycleDatabase = createDatabase(join(cycleDirectory, 'routes.sqlite'))
  const app = createApp(cycleDatabase, { models: [] })
  const cycleServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    cycleServer.once('listening', resolve)
    cycleServer.once('error', reject)
  })
  const cycleUrl = `http://127.0.0.1:${cycleServer.address().port}`
  const cyclePost = (path, body) => fetch(`${cycleUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  try {
    cycleDatabase.createTask({
      title: 'Cycle route blocked without reason',
      status: 'blocked',
      priority: 'high'
    })

    const catalog = await (await fetch(`${cycleUrl}/api/sensors/catalog`)).json()
    assert.equal(catalog.ideas.length, SENSOR_IDEAS.length)
    assert.ok(catalog.autoPromotePolicies.includes('off'))
    assert.ok(catalog.thresholds.metadataStaleHours >= 1)

    const scan = await (await cyclePost('/api/sensors/scan')).json()
    assert.equal(scan.run.triggerKind, 'api')
    assert.equal(scan.run.promoted, 0)

    for (const body of [
      { auto_promote: 'sometimes' },
      { task_type: 'nope' },
      { project: '   ' },
      { auto_promote: 1 }
    ]) {
      const invalid = await cyclePost('/api/sensors/cycles', body)
      assert.equal(invalid.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    }

    const cycleResponse = await cyclePost('/api/sensors/cycles', {
      auto_promote: 'high',
      project: 'quality',
      task_type: 'bug'
    })
    assert.equal(cycleResponse.status, 200)
    const cycle = await cycleResponse.json()
    assert.equal(cycle.run.triggerKind, 'api')
    assert.equal(cycle.run.promoted, cycle.promotions.length)
    assert.ok(cycle.promotions.length >= 1)
    assert.equal(cycle.promotions[0].task.project, 'quality')
    assert.equal(cycle.promotions[0].task.task_type, 'bug')
    assert.ok(cycle.summary.total >= 1)

    cycleDatabase.applySensorScan([{
      key: 'idea:route-test',
      sensorId: 'meta.sensor_suggestion',
      severity: 'medium',
      title: 'Route idea',
      summary: 'A suggested sensor',
      entity: { type: 'sensor_idea', id: 'route-test' },
      details: { suggestedSensor: { id: 'route-test' } }
    }])

    const suggestionsResponse = await fetch(`${cycleUrl}/api/sensors/suggestions`)
    assert.equal(suggestionsResponse.status, 200)
    const suggestions = await suggestionsResponse.json()
    assert.ok(suggestions.suggestions.some((finding) => finding.key === 'idea:route-test'))
    assert.equal(suggestions.ideas.length, SENSOR_IDEAS.length)

    const dismissed = await (
      await fetch(`${cycleUrl}/api/sensors/suggestions?state=dismissed`)
    ).json()
    assert.equal(dismissed.suggestions.length, 0)
    const badState = await fetch(`${cycleUrl}/api/sensors/suggestions?state=nope`)
    assert.equal(badState.status, 400)
    const badLimit = await fetch(`${cycleUrl}/api/sensors/suggestions?limit=9999`)
    assert.equal(badLimit.status, 400)

    const realApplyCycle = cycleDatabase.applySensorCycle
    cycleDatabase.applySensorCycle = () => {
      throw new Error('store exploded')
    }
    try {
      const failedScan = await cyclePost('/api/sensors/scan')
      assert.equal(failedScan.status, 500)
      assert.match((await failedScan.json()).error, /store exploded/)

      const failedCycle = await cyclePost('/api/sensors/cycles', { auto_promote: 'off' })
      assert.equal(failedCycle.status, 500)
      const failure = await failedCycle.json()
      assert.match(failure.error, /store exploded/)
      assert.equal(failure.run.status, 'failed')
      assert.equal(failure.run.triggerKind, 'api')
    } finally {
      cycleDatabase.applySensorCycle = realApplyCycle
    }
  } finally {
    await new Promise((resolve) => cycleServer.close(resolve))
    cycleDatabase.close()
    await rm(cycleDirectory, { recursive: true, force: true })
  }
})

function structuralClone(value) {
  return JSON.parse(JSON.stringify(value))
}

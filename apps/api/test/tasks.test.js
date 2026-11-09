import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { createApp } from '../src/app.js'
import { createAdaptiveCpuLimit } from '../src/adaptiveCpuLimit.js'
import { createDatabase } from '../src/database.js'
import { buildTaskPrompt } from '../src/localAiPrompt.js'
import { createResourceMonitor } from '../src/resourceMonitor.js'

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-api-'))
  database = createDatabase(join(directory, 'test.sqlite'))
  server = createApp(database).listen(0, '127.0.0.1')
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

test('tasks can be created, listed, updated, and deleted', async () => {
  const createResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Ship the API',
      description: 'Wire SQLite storage',
      project: 'api',
      task_type: 'feature',
      priority: 'high',
      acceptance_criteria: 'CRUD requests persist across restart'
    })
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.equal(created.title, 'Ship the API')
  assert.equal(created.description, 'Wire SQLite storage')
  assert.equal(created.completed, false)
  assert.equal(created.project, 'api')
  assert.equal(created.status, 'todo')
  assert.equal(created.priority, 'high')
  assert.equal(created.task_type, 'feature')
  assert.equal(created.acceptance_criteria, 'CRUD requests persist across restart')

  const listResponse = await fetch(`${baseUrl}/api/tasks`)
  assert.equal(listResponse.status, 200)
  assert.deepEqual(await listResponse.json(), [created])

  const projectResponse = await fetch(`${baseUrl}/api/projects`)
  assert.deepEqual(await projectResponse.json(), ['workspace', 'api'])

  const filteredResponse = await fetch(`${baseUrl}/api/tasks?project=api&priority=high&search=restart`)
  assert.deepEqual(await filteredResponse.json(), [created])

  const statusResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in_progress' })
  })
  assert.equal((await statusResponse.json()).completed, false)

  const updateResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: true })
  })
  assert.equal(updateResponse.status, 200)
  const completed = await updateResponse.json()
  assert.equal(completed.completed, true)
  assert.equal(completed.status, 'done')

  const invalidResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '  ', status: 'invented' })
  })
  assert.equal(invalidResponse.status, 400)
  assert.match((await invalidResponse.json()).error, /non-empty/)

  const invalidFilterResponse = await fetch(`${baseUrl}/api/tasks?status=unknown`)
  assert.equal(invalidFilterResponse.status, 400)

  const deleteResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 204)

  const updatedAfterDelete = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: false })
  })
  assert.equal(updatedAfterDelete.status, 404)
})

test('tasks persist when the SQLite connection is reopened', () => {
  const databasePath = join(directory, 'persistence.sqlite')
  const firstConnection = createDatabase(databasePath)
  const created = firstConnection.createTask({ title: 'Persistent task', description: '' })
  firstConnection.close()

  const reopenedConnection = createDatabase(databasePath)
  assert.equal(reopenedConnection.getTask(created.id).title, 'Persistent task')
  reopenedConnection.close()
})

test('existing task databases are migrated without losing completion state', () => {
  const databasePath = join(directory, 'legacy.sqlite')
  const connection = new Database(databasePath)
  connection.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  connection.prepare(
    'INSERT INTO tasks (title, completed, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run('Old completed task', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  connection.prepare(
    'INSERT INTO tasks (title, completed, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run('Old open task', 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
  connection.close()

  const migratedDatabase = createDatabase(databasePath)
  const tasks = migratedDatabase.listTasks()
  assert.equal(tasks.length, 2)
  assert.equal(migratedDatabase.getTask(1).status, 'done')
  assert.equal(migratedDatabase.getTask(1).completed, true)
  assert.equal(migratedDatabase.getTask(2).status, 'todo')
  assert.equal(migratedDatabase.getTask(2).project, 'workspace')
  migratedDatabase.close()
})

test('resource monitor averages physical disk busy time over five seconds', async () => {
  let diskReadCount = 0
  let now = 0
  let waits = 0
  const monitor = createResourceMonitor({
    readText: async (path) => {
      if (path === '/proc/meminfo') return 'MemTotal: 8000000 kB\nMemAvailable: 2048000 kB\n'
      diskReadCount += 1
      const ioTimeMs = diskReadCount * 1000 - 600
      return `8 0 sda 1 0 1 0 1 0 1 0 0 ${ioTimeMs} 0\n`
    },
    readDirectory: async () => ['sda', 'loop0', 'dm-0'],
    getLoadAverage: () => 0.1,
    getTime: () => now,
    wait: async (milliseconds) => {
      waits += 1
      now += milliseconds
    }
  })

  assert.deepEqual(await monitor(), {
    loadAverage: 0.1,
    availableMemoryMb: 2000,
    diskBusyPercent: 20
  })
  assert.equal(waits, 1)

  assert.deepEqual(await monitor(), {
    loadAverage: 0.1,
    availableMemoryMb: 2000,
    diskBusyPercent: 20
  })
  assert.equal(waits, 1)

  now += 5000
  assert.deepEqual(await monitor(), {
    loadAverage: 0.1,
    availableMemoryMb: 2000,
    diskBusyPercent: 40
  })
})

test('adaptive CPU limit decreases under sustained load and recovers within bounds', () => {
  let now = 0
  const observe = createAdaptiveCpuLimit({
    minLoad: 0.5,
    maxLoad: 1,
    getTime: () => now
  })

  assert.equal(observe(1.2), 1)
  now = 5000
  assert.equal(observe(1.2), 1)
  now = 10000
  assert.equal(observe(1.2), 0.9)
  now = 20000
  assert.equal(observe(1.2), 0.8)
  now = 30000
  assert.equal(observe(1.2), 0.7)
  now = 40000
  assert.equal(observe(1.2), 0.6)
  now = 50000
  assert.equal(observe(1.2), 0.5)
  now = 60000
  assert.equal(observe(1.2), 0.5)

  now = 65000
  assert.equal(observe(0.1), 0.5)
  now = 95000
  assert.equal(observe(0.1), 0.55)
  now = 125000
  assert.equal(observe(0.1), 0.6)
  assert.equal(observe(Number.NaN), 0.6)
})

test('task prompt router uses compact and detailed routes within the context budget', () => {
  const brief = buildTaskPrompt({
    title: 'Add a health endpoint',
    project: 'api',
    task_type: 'feature',
    description: 'Expose service health.',
    acceptance_criteria: 'Return status ok.'
  })
  assert.equal(brief.route, 'brief')
  assert.equal(brief.maxTokens, 180)
  assert.match(brief.messages[1].content, /Task: Add a health endpoint/)
  assert.match(brief.messages[1].content, /Description:/)
  assert.match(brief.messages[1].content, /Acceptance criteria:/)

  const detailed = buildTaskPrompt({
    title: 'Add API validation',
    project: 'api',
    task_type: 'feature',
    description: 'Implement clear validation errors. '.repeat(40),
    acceptance_criteria: 'Reject invalid payloads. '.repeat(40)
  })
  assert.equal(detailed.route, 'detailed')
  assert.equal(detailed.maxTokens, 300)
  assert.equal(detailed.wasTruncated, true)
  assert.ok(detailed.messages[1].content.length <= 2200)
  assert.ok(detailed.messages[1].content.endsWith('…'))

  const longSingleField = buildTaskPrompt({
    title: 'Summarize details',
    project: 'api',
    task_type: 'docs',
    description: 'Useful detail. '.repeat(200),
    acceptance_criteria: ''
  })
  assert.ok(longSingleField.messages[1].content.length <= 2200)
})

test('local task assistant waits for low load and returns an unsaved draft', async () => {
  const prompts = []
  const app = createApp(database, {
    localAiApiKey: 'colab-test-key',
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 10
    }),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) {
        assert.equal(options.headers.Authorization, 'Bearer colab-test-key')
        return new Response('ok')
      }
      assert.equal(options.headers.Authorization, 'Bearer colab-test-key')
      prompts.push(JSON.parse(options.body))
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              description: 'Add a validated task drafting endpoint.',
              acceptance_criteria: '1. Valid input returns a draft.\n2. The task is not saved.'
            })
          }
        }]
      })
    }
  })
  const assistantServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => assistantServer.once('listening', resolve))
  const assistantUrl = `http://127.0.0.1:${assistantServer.address().port}`

  try {
    const statusResponse = await fetch(`${assistantUrl}/api/local-ai/status`)
    const status = await statusResponse.json()
    assert.equal(status.state, 'ready')
    assert.deepEqual(status.limits, {
      cpuLoadLimit: 1,
      minCpuLoad: 0.5,
      maxCpuLoad: 1,
      minAvailableMemoryMb: 1024,
      maxDiskBusyPercent: 30
    })

    const response = await fetch(`${assistantUrl}/api/local-ai/refine-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Add task drafting', project: 'api', task_type: 'feature' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      description: 'Add a validated task drafting endpoint.',
      acceptance_criteria: '1. Valid input returns a draft.\n2. The task is not saved.'
    })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].messages[1].role, 'user')
    assert.equal(prompts[0].max_tokens, 180)
    assert.deepEqual(database.listTasks(), [])

    const cooldownResponse = await fetch(`${assistantUrl}/api/local-ai/status`)
    const cooldown = await cooldownResponse.json()
    assert.equal(cooldown.state, 'busy')
    assert.match(cooldown.busyReasons[0], /Cooling down/)
  } finally {
    await new Promise((resolve) => assistantServer.close(resolve))
  }
})

test('local task assistant formats structured acceptance-criteria arrays', async () => {
  const app = createApp(database, {
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 10
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      return Response.json({
        choices: [{
          message: {
            content: '```json\n' + JSON.stringify({
              description: 'Validate task creation.',
              acceptance_criteria: [{
                title: 'Invalid title',
                description: 'Submit an empty title.',
                expected_result: 'The request returns 400.'
              }]
            }) + '\n```'
          }
        }]
      })
    }
  })
  const assistantServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => assistantServer.once('listening', resolve))
  const assistantUrl = `http://127.0.0.1:${assistantServer.address().port}`

  try {
    const response = await fetch(`${assistantUrl}/api/local-ai/refine-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Validate task creation' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      description: 'Validate task creation.',
      acceptance_criteria: '1. title: Invalid title; description: Submit an empty title.; expected result: The request returns 400.'
    })
    assert.deepEqual(database.listTasks(), [])
  } finally {
    await new Promise((resolve) => assistantServer.close(resolve))
  }
})

test('local task assistant pauses without contacting the model when any resource is busy', async () => {
  let modelCalled = false
  const busyMetrics = [
    { loadAverage: 2.8, availableMemoryMb: 4096, diskBusyPercent: 10 },
    { loadAverage: 0.1, availableMemoryMb: 512, diskBusyPercent: 10 },
    { loadAverage: 0.1, availableMemoryMb: 4096, diskBusyPercent: 75 }
  ]

  for (const metrics of busyMetrics) {
    const app = createApp(database, {
      getResourceMetrics: async () => metrics,
      fetchImpl: async () => {
        modelCalled = true
        return new Response('unexpected')
      }
    })
    const assistantServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => assistantServer.once('listening', resolve))
    const assistantUrl = `http://127.0.0.1:${assistantServer.address().port}`

    try {
      const response = await fetch(`${assistantUrl}/api/local-ai/refine-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Wait for idle resources' })
      })
      assert.equal(response.status, 503)
      const result = await response.json()
      assert.equal(result.state, 'busy')
      assert.deepEqual(result.metrics, metrics)
      assert.equal(result.busyReasons.length, 1)
      assert.equal(modelCalled, false)
    } finally {
      await new Promise((resolve) => assistantServer.close(resolve))
    }
  }
})

test('local task assistant runs one generation per model concurrently', async () => {
  let releaseGeneration
  let startFirst
  let startSecond
  let generationCount = 0
  const firstStarted = new Promise((resolve) => { startFirst = resolve })
  const secondStarted = new Promise((resolve) => { startSecond = resolve })
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve })
  const app = createApp(database, {
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 10
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      generationCount += 1
      if (generationCount === 1) startFirst()
      if (generationCount === 2) startSecond()
      await generationGate
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              description: 'Add a per-model concurrency guard.',
              acceptance_criteria: 'Each local model runs one request at a time.'
            })
          }
        }]
      })
    }
  })
  const assistantServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => assistantServer.once('listening', resolve))
  const assistantUrl = `http://127.0.0.1:${assistantServer.address().port}`
  const draftRequest = (model) => fetch(`${assistantUrl}/api/local-ai/refine-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Run local inference', model })
  })

  try {
    const firstDraft = draftRequest('local-0.5b')
    await firstStarted

    const sameModelDraft = await draftRequest('local-0.5b')
    assert.equal(sameModelDraft.status, 503)
    const busy = await sameModelDraft.json()
    assert.equal(busy.state, 'busy')
    assert.equal(busy.retryAfter, 5)
    assert.equal(generationCount, 1)

    const otherModelDraft = draftRequest('local-1.5b')
    await secondStarted
    assert.equal(generationCount, 2)

    const status = await (await fetch(`${assistantUrl}/api/local-ai/status`)).json()
    assert.equal(status.models.find((model) => model.id === 'local-0.5b').state, 'busy')
    assert.equal(status.models.find((model) => model.id === 'local-1.5b').state, 'busy')

    releaseGeneration()
    assert.equal((await firstDraft).status, 200)
    assert.equal((await otherModelDraft).status, 200)
  } finally {
    releaseGeneration()
    await new Promise((resolve) => assistantServer.close(resolve))
  }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import {
  createModelRegistry,
  planLocalModelLaunches
} from '../src/modelRegistry.js'

const MODELS = [
  {
    id: 'local-small',
    label: 'Small local model',
    provider: 'local',
    execution: 'live',
    priority: 10,
    minAvailableMemoryMb: 1024,
    url: 'http://small.test'
  },
  {
    id: 'local-large',
    label: 'Large local model',
    provider: 'local',
    execution: 'live',
    priority: 20,
    minAvailableMemoryMb: 1792,
    url: 'http://large.test'
  },
  {
    id: 'colab',
    label: 'Colab model',
    provider: 'colab',
    execution: 'manual',
    priority: 0,
    notes: 'Run the Colab notebook.'
  },
  {
    id: 'kaggle',
    label: 'Kaggle model',
    provider: 'kaggle',
    execution: 'batch',
    priority: 0,
    notes: 'Submit a Kaggle batch run.'
  }
]

const DRAFT = {
  description: 'Draft from the selected model.',
  acceptance_criteria: 'The draft is returned without being saved.'
}

let directory
let database

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-models-'))
  database = createDatabase(join(directory, 'models.sqlite'))
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function idleMetrics(availableMemoryMb = 4096) {
  return { loadAverage: 0.1, availableMemoryMb, diskBusyPercent: 10 }
}

function draftResponse() {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(DRAFT) } }]
  })
}

async function withApp(options, run) {
  const app = createApp(database, { models: MODELS, ...options })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function refine(url, body = {}) {
  return fetch(`${url}/api/local-ai/refine-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Draft a task', ...body })
  })
}

test('registry contains two live local models and two external web models', () => {
  const models = createModelRegistry({ env: {} })
  assert.deepEqual(models.map((model) => [model.id, model.execution]), [
    ['local-0.5b', 'live'],
    ['local-1.5b', 'live'],
    ['colab-3b', 'manual'],
    ['kaggle-3b', 'batch']
  ])
  assert.equal(models[0].minAvailableMemoryMb, 1024)
  assert.equal(models[1].minAvailableMemoryMb, 1792)
  assert.equal(models[0].url, 'http://127.0.0.1:8080')
  assert.equal(models[1].url, 'http://127.0.0.1:8081')

  const custom = createModelRegistry({ env: { LOCAL_AI_URL: 'http://127.0.0.1:9090/' } })
  assert.equal(custom[0].url, 'http://127.0.0.1:9090')
  assert.equal(custom[0].port, 9090)
})

test('launch planning starts both models only when memory permits', () => {
  const plans = planLocalModelLaunches({
    env: {},
    requested: 'all',
    homeDir: '/models',
    availableMemoryMb: 2000,
    fileExists: () => true
  })
  assert.equal(plans.length, 2)
  assert.equal(plans[0].fits, true)
  assert.equal(plans[1].fits, false)
  assert.equal(plans[0].port, 8080)
  assert.equal(plans[1].port, 8081)
})

test('status reports both local and both external models', async () => {
  await withApp({
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      return draftResponse()
    }
  }, async (url) => {
    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    assert.equal(status.state, 'ready')
    assert.deepEqual(status.models.map((model) => [model.id, model.state]), [
      ['local-small', 'ready'],
      ['local-large', 'ready'],
      ['colab', 'manual'],
      ['kaggle', 'batch']
    ])
    assert.equal(status.models.find((model) => model.id === 'colab').available, false)
  })
})

test('models endpoint returns the registry without live state', async () => {
  await withApp({}, async (url) => {
    const models = await (await fetch(`${url}/api/models`)).json()
    assert.deepEqual(models.map((model) => model.id), [
      'local-small', 'local-large', 'colab', 'kaggle'
    ])
    assert.equal(models.every((model) => !('state' in model)), true)
  })
})

test('scheduler prefers the highest-priority ready local model', async () => {
  const completions = []
  await withApp({
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const response = await refine(url)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), DRAFT)
    assert.deepEqual(completions, ['http://large.test/v1/chat/completions'])
  })
})

test('scheduler falls back when the preferred model is unhealthy', async () => {
  const completions = []
  await withApp({
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url === 'http://large.test/health') return new Response('', { status: 503 })
      if (url.endsWith('/health')) return new Response('ok')
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    assert.equal(status.state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'local-large').state, 'unavailable')

    const response = await refine(url)
    assert.equal(response.status, 200)
    assert.deepEqual(completions, ['http://small.test/v1/chat/completions'])
  })
})

test('scheduler respects per-model memory thresholds', async () => {
  const completions = []
  await withApp({
    getResourceMetrics: async () => idleMetrics(1500),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    assert.equal(status.state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'local-small').state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'local-large').state, 'busy')
    assert.match(
      status.models.find((model) => model.id === 'local-large').busyReasons[0],
      /below 1792 MB/
    )

    const response = await refine(url)
    assert.equal(response.status, 200)
    assert.deepEqual(completions, ['http://small.test/v1/chat/completions'])
  })
})

test('external models cannot be selected for live inference', async () => {
  let modelCalled = false
  await withApp({
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async () => {
      modelCalled = true
      return new Response('ok')
    }
  }, async (url) => {
    const response = await refine(url, { model: 'colab' })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /manual and cannot be called live/)
    assert.equal(modelCalled, false)
  })
})

test('unknown models are rejected before inference', async () => {
  let modelCalled = false
  await withApp({
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async () => {
      modelCalled = true
      return new Response('ok')
    }
  }, async (url) => {
    const response = await refine(url, { model: 'missing' })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Unknown model/)
    assert.equal(modelCalled, false)
  })
})

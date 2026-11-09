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

const LIVE_EXTERNAL_MODELS = MODELS.map((model) => (
  model.execution === 'live'
    ? model
    : {
        ...model,
        execution: 'live',
        remote: true,
        minAvailableMemoryMb: 0,
        url: `http://${model.id}.test`
      }
))

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

test('registry contains two callable local models and two CLI-backed remote models', () => {
  const models = createModelRegistry({ env: {} })
  assert.deepEqual(models.map((model) => [model.id, model.execution, model.backend, model.autoSelect]), [
    ['local-0.5b', 'live', 'http', true],
    ['local-1.5b', 'live', 'http', true],
    ['colab-3b', 'live', 'colab-cli', false],
    ['kaggle-3b', 'batch', 'kaggle-cli', false]
  ])
  assert.equal(models[0].minAvailableMemoryMb, 1024)
  assert.equal(models[1].minAvailableMemoryMb, 1792)
  assert.equal(models[0].url, 'http://127.0.0.1:8080')
  assert.equal(models[1].url, 'http://127.0.0.1:8081')
  assert.equal(models[2].callable, true)
  assert.equal(models[3].callable, true)
  assert.equal(models[2].cli.session, 'workspace-qwen')
  assert.deepEqual(models[2].cli.probeArgs, ['sessions'])
  assert.equal(models[3].cli.command, 'kaggle')
  assert.deepEqual(models[3].cli.probeArgs, ['config', 'view'])

  const custom = createModelRegistry({ env: { LOCAL_AI_URL: 'http://127.0.0.1:9090/' } })
  assert.equal(custom[0].url, 'http://127.0.0.1:9090')
  assert.equal(custom[0].port, 9090)
})

test('external models become live when a URL is configured', () => {
  const models = createModelRegistry({
    env: {
      COLAB_AI_URL: 'https://colab.example/',
      COLAB_AI_API_KEY: 'colab-key',
      KAGGLE_AI_URL: 'https://kaggle.example'
    }
  })
  const colab = models.find((model) => model.id === 'colab-3b')
  const kaggle = models.find((model) => model.id === 'kaggle-3b')

  assert.equal(colab.execution, 'live')
  assert.equal(colab.backend, 'http')
  assert.equal(colab.autoSelect, true)
  assert.equal(colab.url, 'https://colab.example')
  assert.equal(colab.apiKey, 'colab-key')
  assert.equal(colab.minAvailableMemoryMb, 0)
  assert.equal(kaggle.execution, 'live')
  assert.equal(kaggle.backend, 'http')
  assert.equal(kaggle.autoSelect, true)
  assert.equal(kaggle.url, 'https://kaggle.example')
  assert.equal(kaggle.apiKey, undefined)
  assert.equal(kaggle.minAvailableMemoryMb, 0)

  assert.throws(
    () => createModelRegistry({ env: { COLAB_AI_URL: 'ftp://colab.example' } }),
    /must be a valid http\(s\) URL/
  )
})

test('CLI remote models opt out of automatic selection unless enabled', () => {
  const defaults = createModelRegistry({ env: {} })
  assert.equal(defaults.find((model) => model.id === 'colab-3b').autoSelect, false)
  assert.equal(defaults.find((model) => model.id === 'kaggle-3b').autoSelect, false)

  const enabled = createModelRegistry({ env: { COLAB_AI_AUTO_SELECT: 'true' } })
  assert.equal(enabled.find((model) => model.id === 'colab-3b').autoSelect, true)
  assert.equal(enabled.find((model) => model.id === 'kaggle-3b').autoSelect, false)

  const disabled = createModelRegistry({
    env: { COLAB_AI_URL: 'https://colab.example', COLAB_AI_AUTO_SELECT: 'false' }
  })
  assert.equal(disabled.find((model) => model.id === 'colab-3b').autoSelect, false)
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
      if (url.startsWith('http://large.test/')) return new Response('', { status: 503 })
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

test('scheduler calls live external models when local models are unavailable', async () => {
  const completions = []
  await withApp({
    models: LIVE_EXTERNAL_MODELS,
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url.startsWith('http://local-')) return new Response('', { status: 503 })
      if (url.endsWith('/health')) return new Response('ok')
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const response = await refine(url, { model: 'kaggle' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), DRAFT)
    assert.deepEqual(completions, ['http://kaggle.test/v1/chat/completions'])
  })
})

test('live external models can use an OpenAI-compatible health probe', async () => {
  const completions = []
  await withApp({
    models: LIVE_EXTERNAL_MODELS,
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('', { status: 404 })
      if (url.endsWith('/v1/models')) return Response.json({ data: [] })
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const response = await refine(url, { model: 'colab' })
    assert.equal(response.status, 200)
    assert.deepEqual(completions, ['http://colab.test/v1/chat/completions'])
  })
})

test('live external model calls use their configured bearer token', async () => {
  const models = LIVE_EXTERNAL_MODELS.map((model) => (
    model.id === 'colab' ? { ...model, apiKey: 'external-secret' } : model
  ))
  let authorization
  await withApp({
    models,
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) return new Response('ok')
      if (url === 'http://colab.test/v1/chat/completions') {
        authorization = options.headers.Authorization
      }
      return draftResponse()
    }
  }, async (url) => {
    const response = await refine(url, { model: 'colab' })
    assert.equal(response.status, 200)
    assert.equal(authorization, 'Bearer external-secret')
  })
})

test('remote models stay ready when local resources are constrained', async () => {
  const completions = []
  await withApp({
    models: LIVE_EXTERNAL_MODELS,
    getResourceMetrics: async () => ({
      loadAverage: 8,
      availableMemoryMb: 100,
      diskBusyPercent: 90
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response('ok')
      completions.push(url)
      return draftResponse()
    }
  }, async (url) => {
    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    assert.equal(status.state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'local-small').state, 'busy')
    assert.equal(status.models.find((model) => model.id === 'local-large').state, 'busy')
    assert.equal(status.models.find((model) => model.id === 'colab').state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'kaggle').state, 'ready')

    const response = await refine(url)
    assert.equal(response.status, 200)
    assert.deepEqual(completions, ['http://colab.test/v1/chat/completions'])
  })
})

test('local API key is not forwarded to external models', async () => {
  let authorization = 'unset'
  await withApp({
    models: LIVE_EXTERNAL_MODELS,
    localAiApiKey: 'local-secret',
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) return new Response('ok')
      if (url === 'http://colab.test/v1/chat/completions') {
        authorization = options.headers.Authorization
      }
      return draftResponse()
    }
  }, async (url) => {
    const response = await refine(url, { model: 'colab' })
    assert.equal(response.status, 200)
    assert.equal(authorization, undefined)
  })
})

test('implicit selection skips models that are not auto-selected', async () => {
  let modelCalled = false
  const models = [
    MODELS[0],
    {
      ...MODELS[2],
      execution: 'live',
      backend: 'http',
      callable: true,
      autoSelect: false,
      remote: true,
      minAvailableMemoryMb: 0,
      url: 'http://colab.test'
    }
  ]
  await withApp({
    models,
    getResourceMetrics: async () => idleMetrics(),
    fetchImpl: async (url) => {
      if (url.startsWith('http://small.test/')) return new Response('', { status: 503 })
      if (url.endsWith('/health')) return new Response('ok')
      modelCalled = true
      return draftResponse()
    }
  }, async (url) => {
    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    assert.equal(status.state, 'ready')
    assert.equal(status.models.find((model) => model.id === 'colab').state, 'ready')

    const implicit = await refine(url)
    assert.equal(implicit.status, 503)
    assert.match((await implicit.json()).error, /automatic selection/)
    assert.equal(modelCalled, false)

    const explicit = await refine(url, { model: 'colab' })
    assert.equal(explicit.status, 200)
    assert.equal(modelCalled, true)
  })
})

test('models without a live endpoint cannot be selected', async () => {
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
    assert.match((await response.json()).error, /cannot be called/)
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

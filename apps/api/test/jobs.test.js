import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'

const DRAFT = {
  description: 'A batch draft.',
  acceptance_criteria: 'The batch returns a draft.'
}

const MODELS = [
  {
    id: 'kaggle-3b',
    label: 'Qwen2.5-Coder 3B (Kaggle)',
    provider: 'kaggle',
    execution: 'batch',
    backend: 'kaggle-cli',
    callable: true,
    autoSelect: false,
    remote: true,
    priority: 7,
    minAvailableMemoryMb: 0,
    timeoutMs: 3600000,
    cli: { command: 'kaggle', python: 'python3', pollIntervalSeconds: 30 }
  }
]

const idleMetrics = async () => ({
  loadAverage: 0.1,
  availableMemoryMb: 4096,
  diskBusyPercent: 10
})

let directory
let database

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-jobs-'))
  database = createDatabase(join(directory, 'jobs.sqlite'))
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function withApp(options, run) {
  const app = createApp(database, {
    models: MODELS,
    getResourceMetrics: idleMetrics,
    ...options
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function waitForJob(url, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await (await fetch(`${url}/api/local-ai/jobs/${id}`)).json()
    if (job.state === 'done' || job.state === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Job ${id} did not finish.`)
}

function postJob(url, body = {}) {
  return fetch(`${url}/api/local-ai/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Batch task', model: 'kaggle-3b', ...body })
  })
}

test('background jobs run a model and expose the parsed draft', async () => {
  await withApp({
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async () => JSON.stringify(DRAFT)
    }
  }, async (url) => {
    const response = await postJob(url)
    assert.equal(response.status, 202)
    const submitted = await response.json()
    assert.equal(submitted.model, 'kaggle-3b')
    assert.ok(['queued', 'running', 'done'].includes(submitted.state))

    const job = await waitForJob(url, submitted.id)
    assert.equal(job.state, 'done')
    assert.deepEqual(job.result, DRAFT)
    assert.equal(job.title, 'Batch task')

    const status = await (await fetch(`${url}/api/local-ai/status`)).json()
    const kaggleStatus = status.models.find((model) => model.id === 'kaggle-3b')
    assert.ok(['ready', 'busy'].includes(kaggleStatus.state))
    assert.equal(
      (kaggleStatus.busyReasons || []).some((reason) => reason.includes('already in progress')),
      false
    )

    const list = await (await fetch(`${url}/api/local-ai/jobs`)).json()
    assert.deepEqual(list.map((entry) => entry.id), [submitted.id])
  })
})

test('background jobs capture model failures', async () => {
  await withApp({
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async () => {
        throw Object.assign(new Error('Kaggle runner failed.'), { status: 502 })
      }
    }
  }, async (url) => {
    const submitted = await (await postJob(url)).json()
    const job = await waitForJob(url, submitted.id)
    assert.equal(job.state, 'error')
    assert.equal(job.error, 'Kaggle runner failed.')
    assert.equal(job.status, 502)
    assert.equal(job.result, undefined)
  })
})

test('background jobs validate input and require an explicit model', async () => {
  let called = false
  await withApp({
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async () => {
        called = true
        return JSON.stringify(DRAFT)
      }
    }
  }, async (url) => {
    const missingModel = await postJob(url, { model: undefined })
    assert.equal(missingModel.status, 400)
    assert.match((await missingModel.json()).error, /Model is required/)

    const missingTitle = await postJob(url, { title: '' })
    assert.equal(missingTitle.status, 400)
    assert.match((await missingTitle.json()).error, /Title must be/)

    const unknownModel = await postJob(url, { model: 'missing' })
    assert.equal(unknownModel.status, 400)
    assert.match((await unknownModel.json()).error, /Unknown model/)

    const unknownJob = await fetch(`${url}/api/local-ai/jobs/job-999`)
    assert.equal(unknownJob.status, 404)
    assert.match((await unknownJob.json()).error, /Unknown job/)

    assert.equal(called, false)
  })
})

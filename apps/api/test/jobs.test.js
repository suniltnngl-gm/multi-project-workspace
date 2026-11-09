import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { createModelBudget } from '../src/modelBudget.js'
import { createTaskJobStore } from '../src/taskJobStore.js'
import { ModelCallError } from '../src/modelClient.js'

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

beforeEach(() => {
  for (const job of database.listJobs()) database.deleteJob(job.id)
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

async function waitForJob(url, id, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await (await fetch(`${url}/api/local-ai/jobs/${id}`)).json()
    if (expected ? job.state === expected : ['done', 'error', 'cancelled'].includes(job.state)) {
      return job
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Job ${id} did not reach ${expected || 'a terminal state'}.`)
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

    const models = await (await fetch(`${url}/api/models`)).json()
    const kaggle = models.find((model) => model.id === 'kaggle-3b')
    assert.equal(kaggle.requests, 1)
    assert.equal(kaggle.failures, 0)
    assert.equal(typeof kaggle.lastUsedAt, 'number')
    assert.equal(typeof kaggle.lastDurationMs, 'number')

    assert.equal(job.elapsedMs >= 0, true)
    assert.equal(job.cancelable, false)
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

test('background jobs can be cancelled while running', async () => {
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })

  await withApp({
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async (_model, request) => {
        markStarted()
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new ModelCallError('The request was cancelled.', 499))
          })
        })
      }
    }
  }, async (url) => {
    const submitted = await (await postJob(url)).json()
    await started
    const running = await waitForJob(url, submitted.id, 'running')
    assert.equal(running.cancelable, true)

    const cancelled = await fetch(`${url}/api/local-ai/jobs/${submitted.id}`, {
      method: 'DELETE'
    })
    assert.equal(cancelled.status, 202)
    assert.equal((await cancelled.json()).cancelRequested, true)

    const job = await waitForJob(url, submitted.id)
    assert.equal(job.state, 'cancelled')
    assert.equal(job.error, 'The job was cancelled.')
    assert.equal(job.cancelable, false)

    const again = await fetch(`${url}/api/local-ai/jobs/${submitted.id}`, {
      method: 'DELETE'
    })
    assert.equal(again.status, 409)
  })
})

test('background jobs expose their current phase', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  await withApp({
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async (_model, request) => {
        request.onPhase('submitting')
        await gate
        request.onPhase('generating')
        return JSON.stringify(DRAFT)
      }
    }
  }, async (url) => {
    const submitted = await (await postJob(url)).json()
    const running = await waitForJob(url, submitted.id, 'running')
    assert.equal(running.phase, 'submitting')
    release()
    const job = await waitForJob(url, submitted.id)
    assert.equal(job.state, 'done')
    assert.equal(job.phase, 'finished')
  })
})

test('remote daily budgets reject requests and are exposed in the model registry', async () => {
  const rows = new Map()
  const repository = {
    getBudget: (model, day) => rows.get(`${model}:${day}`) ?? 0,
    incrementBudget: (model, day) => {
      const key = `${model}:${day}`
      const used = (rows.get(key) ?? 0) + 1
      rows.set(key, used)
      return used
    },
    pruneBudgetBefore: () => {}
  }
  const modelBudget = createModelBudget({
    env: { KAGGLE_AI_MAX_REQUESTS_PER_DAY: '1' },
    repository
  })

  await withApp({
    modelBudget,
    turnCooldownMs: 0,
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async () => JSON.stringify(DRAFT)
    }
  }, async (url) => {
    const first = await postJob(url)
    assert.equal(first.status, 202)
    await waitForJob(url, (await first.json()).id)

    const second = await postJob(url)
    assert.equal(second.status, 429)
    const payload = await second.json()
    assert.match(payload.error, /daily request limit/)
    assert.equal(payload.budget.remaining, 0)

    const models = await (await fetch(`${url}/api/models`)).json()
    const kaggle = models.find((model) => model.id === 'kaggle-3b')
    assert.equal(kaggle.budget.limit, 1)
    assert.equal(kaggle.budget.used, 1)
    assert.equal(kaggle.budget.remaining, 0)
  })
})

test('persisted jobs are reported as interrupted after a restart', async () => {
  const persistedDirectory = await mkdtemp(join(tmpdir(), 'workspace-jobs-persist-'))
  const persisted = createDatabase(join(persistedDirectory, 'jobs.sqlite'))
  try {
    const firstStore = createTaskJobStore({ repository: persisted })
    const submitted = firstStore.submit({
      model: 'kaggle-3b',
      title: 'Long batch',
      runner: () => new Promise(() => {})
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const restarted = createTaskJobStore({ repository: persisted })
    const job = restarted.get(submitted.id)
    assert.equal(job.state, 'error')
    assert.match(job.error, /API restarted/)
    assert.equal(typeof job.finishedAt, 'number')
  } finally {
    persisted.close()
    await rm(persistedDirectory, { recursive: true, force: true })
  }
})

test('daily budgets persist across budget instances', async () => {
  const budgetDirectory = await mkdtemp(join(tmpdir(), 'workspace-budget-'))
  const persisted = createDatabase(join(budgetDirectory, 'budget.sqlite'))
  try {
    const env = { KAGGLE_AI_MAX_REQUESTS_PER_DAY: '2' }
    const first = createModelBudget({ env, repository: persisted })
    first.record('kaggle-3b')
    first.record('kaggle-3b')
    assert.equal(first.check('kaggle-3b').ok, false)

    const restarted = createModelBudget({ env, repository: persisted })
    const budget = restarted.snapshot('kaggle-3b')
    assert.equal(budget.used, 2)
    assert.equal(budget.remaining, 0)
    assert.equal(restarted.check('kaggle-3b').ok, false)
  } finally {
    persisted.close()
    await rm(budgetDirectory, { recursive: true, force: true })
  }
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

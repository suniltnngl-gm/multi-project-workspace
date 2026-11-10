import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'

const LOCAL_MODEL = {
  id: 'local-0.5b',
  label: 'Qwen2.5-Coder 0.5B (local)',
  provider: 'local',
  execution: 'live',
  backend: 'http',
  callable: true,
  autoSelect: true,
  remote: false,
  priority: 10,
  minAvailableMemoryMb: 0,
  url: 'http://127.0.0.1:8080'
}

const idleMetrics = async () => ({
  loadAverage: 0.1,
  availableMemoryMb: 4096,
  diskBusyPercent: 10
})

let directory
let database

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-ai-complete-'))
  database = createDatabase(join(directory, 'complete.sqlite'))
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function withApp({ respond = async () => 'A direct reply.' } = {}, run) {
  const calls = []
  const app = createApp(database, {
    models: [LOCAL_MODEL],
    getResourceMetrics: idleMetrics,
    turnCooldownMs: 0,
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async (model, request) => {
        calls.push({
          model: model.id,
          messages: request.messages,
          maxTokens: request.maxTokens,
          task: request.task
        })
        return respond(model, request)
      }
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function post(url, path, body) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test('direct AI completion returns content and records provenance', async () => {
  await withApp({}, async (url, calls) => {
    const task = database.createTask({
      title: 'Chat task',
      description: '',
      project: 'workspace',
      status: 'todo',
      priority: 'medium',
      task_type: 'chore',
      acceptance_criteria: ''
    })
    const response = await post(url, '/api/ai/complete', {
      prompt: 'Say hi',
      task_id: task.id,
      system: 'Answer briefly.'
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.content, 'A direct reply.')
    assert.equal(body.model, 'local-0.5b')
    assert.equal(body.backend, 'http')
    assert.ok(body.jobId.startsWith('job-'))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].messages.map((message) => message.role), ['system', 'user'])
    assert.equal(calls[0].messages[1].content, 'Say hi')
    assert.equal(calls[0].maxTokens, 400)

    const jobs = await (await fetch(`${url}/api/local-ai/jobs`)).json()
    const job = jobs.find((entry) => entry.id === body.jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.taskId, task.id)
    assert.equal(job.result.content, 'A direct reply.')

    const detail = await (await fetch(`${url}/api/tasks/${task.id}`)).json()
    assert.equal(detail.aiRuns.length, 1)
    assert.equal(detail.aiRuns[0].id, body.jobId)
  })
})

test('direct AI completion accepts a message list, model, and token budget', async () => {
  await withApp({}, async (url, calls) => {
    const response = await post(url, '/api/ai/complete', {
      model: 'local-0.5b',
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' }
      ]
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(
      calls[0].messages.map((message) => message.role),
      ['system', 'user', 'assistant', 'user']
    )
    assert.equal(calls[0].maxTokens, 128)
  })
})

test('direct AI completion validates input and unknown references', async () => {
  await withApp({}, async (url, calls) => {
    const invalidBodies = [
      {},
      { unknown: 'value' },
      { messages: 'not-a-list' },
      { messages: [] },
      { messages: [{ role: 'bogus', content: 'hi' }] },
      { messages: [{ role: 'user', content: '' }] },
      { messages: [{ role: 'user', content: 'hi', extra: 'no' }] },
      { prompt: 'hi', max_tokens: 0 },
      { prompt: 'hi', max_tokens: 5000 },
      { prompt: 'hi', session_id: 0 },
      { prompt: 'hi', variables: { 'bad-name': 'value' } },
      { prompt: 'hi', variables: { key: 42 } }
    ]
    for (const body of invalidBodies) {
      const response = await post(url, '/api/ai/complete', body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const error = await response.json()
      assert.equal(typeof error.error, 'string')
    }

    for (const extra of [
      { session_id: 424242 },
      { prompt_template_id: 424242 },
      { task_id: 424242 }
    ]) {
      const response = await post(url, '/api/ai/complete', { prompt: 'hi', ...extra })
      assert.equal(response.status, 404, JSON.stringify(extra))
    }
    assert.equal(calls.length, 0)
  })
})

test('direct AI completion renders prompt templates with variables', async () => {
  await withApp({}, async (url, calls) => {
    const template = database.createPromptTemplate({
      name: 'review',
      description: 'Review a change',
      systemPrompt: 'You review {{kind}} changes.',
      userTemplate: 'Review {{file}} or {{left_alone}}.'
    })
    const response = await post(url, '/api/ai/complete', {
      prompt_template_id: template.id,
      variables: { kind: 'documentation', file: 'README.md' }
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].messages.map((message) => message.role), ['system', 'user'])
    assert.equal(calls[0].messages[0].content, 'You review documentation changes.')
    assert.equal(calls[0].messages[1].content, 'Review README.md or {{left_alone}}.')
  })
})

test('direct AI completion is session-aware and persists the exchange', async () => {
  await withApp({}, async (url, calls) => {
    const session = database.createAiSession({ title: 'Chat' })
    database.addAiMessage(session.id, { role: 'user', content: 'Earlier question' })
    database.addAiMessage(session.id, { role: 'assistant', content: 'Earlier answer' })
    database.compactAiSession(session.id, 'The user works on the workspace API.')

    const response = await post(url, '/api/ai/complete', {
      session_id: session.id,
      prompt: 'What am I working on?'
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.sessionId, session.id)

    const messages = calls[0].messages
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
    assert.match(messages[0].content, /Previous conversation summary:\nThe user works on the workspace API\./)
    assert.equal(messages[1].content, 'Earlier question')
    assert.equal(messages[3].content, 'What am I working on?')

    const updated = database.getAiSession(session.id)
    assert.deepEqual(
      updated.messages.map((message) => `${message.role}:${message.content}`),
      [
        'user:Earlier question',
        'assistant:Earlier answer',
        'user:What am I working on?',
        'assistant:A direct reply.'
      ]
    )
  })
})

test('task drafts include compacted session context', async () => {
  await withApp({
    respond: async () => JSON.stringify({
      description: 'A refined draft.',
      acceptance_criteria: 'It works.'
    })
  }, async (url, calls) => {
    const session = database.createAiSession({ title: 'Draft session' })
    database.compactAiSession(session.id, 'The draft must keep the API loopback-only.')

    const response = await post(url, '/api/local-ai/refine-task', {
      title: 'Draft with context',
      session_id: session.id
    })
    assert.equal(response.status, 200)
    const draft = await response.json()
    assert.equal(draft.description, 'A refined draft.')
    const prompt = calls[0].messages[1].content
    assert.match(prompt, /Session context:\nThe draft must keep the API loopback-only\./)

    const missing = await post(url, '/api/local-ai/refine-task', {
      title: 'Draft without a session',
      session_id: 424242
    })
    assert.equal(missing.status, 404)
    const invalid = await post(url, '/api/local-ai/refine-task', {
      title: 'Draft with a bad session',
      session_id: 'two'
    })
    assert.equal(invalid.status, 400)
  })
})

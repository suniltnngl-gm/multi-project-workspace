import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-agent-routes-'))
  database = createDatabase(join(directory, 'routes.sqlite'), {
    artifactDir: join(directory, 'artifacts')
  })
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

function post(path, body, token) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-agent-token': token } : {})
    },
    body: JSON.stringify(body)
  })
}

test('agent routes create runs, carry messages, apply task ops, and cancel', async () => {
  const task = database.createTask({ title: 'Route task' })

  const createResponse = await post('/api/agents/runs', {
    task_id: task.id,
    agents: [
      { role: 'parent', name: 'parent', model: 'test-model' },
      { role: 'worker', name: 'worker-a', model: 'test-model' }
    ]
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  const parent = created.agents.find((agent) => agent.name === 'parent')
  const worker = created.agents.find((agent) => agent.name === 'worker-a')
  assert.ok(parent.token.startsWith('agent_'))

  const messageResponse = await post('/api/agents/messages', {
    run_id: created.id,
    to: 'parent',
    kind: 'result',
    payload: { summary: 'route result' },
    artifact_refs: ['file:apps/api/src/app.js'],
    idempotency_key: 'route-result-1'
  }, worker.token)
  assert.equal(messageResponse.status, 201)
  const message = await messageResponse.json()

  const duplicateResponse = await post('/api/agents/messages', {
    run_id: created.id,
    to: 'parent',
    kind: 'result',
    payload: { summary: 'route result' },
    artifact_refs: ['file:apps/api/src/app.js'],
    idempotency_key: 'route-result-1'
  }, worker.token)
  assert.equal(duplicateResponse.status, 200)

  const claimResponse = await post('/api/agents/inbox/claim', {
    run_id: created.id,
    limit: 5
  }, parent.token)
  assert.equal(claimResponse.status, 200)
  const claimed = await claimResponse.json()
  assert.equal(claimed.messages[0].id, message.message.id)

  const completeResponse = await post(`/api/agents/messages/${message.message.id}/complete`, {
    result: { accepted: true }
  }, parent.token)
  assert.equal(completeResponse.status, 200)
  assert.equal((await completeResponse.json()).message.state, 'completed')

  const taskOpsResponse = await post(`/api/agents/runs/${created.id}/task-ops`, {
    ops: [{
      op_id: 'route-child',
      op: 'create_task',
      title: 'Route child',
      description: 'Created through the route.'
    }]
  }, parent.token)
  assert.equal(taskOpsResponse.status, 200)
  const taskOps = await taskOpsResponse.json()
  assert.equal(taskOps.results[0].status, 'created')
  const child = database.getTask(taskOps.results[0].taskId)
  assert.equal(child.parent_task_id, task.id)

  const detailResponse = await fetch(`${baseUrl}/api/agents/runs/${created.id}`)
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.equal(detail.messages.length, 1)
  assert.ok(detail.events.some((event) => event.type === 'run_created'))
  assert.equal(detail.taskOps.length, 1)

  const unauthorized = await post('/api/agents/messages', {
    run_id: created.id,
    to: 'parent',
    kind: 'result',
    payload: { summary: 'nope' },
    idempotency_key: 'route-result-2'
  }, 'agent_invalid_token')
  assert.equal(unauthorized.status, 401)

  const cancelResponse = await post(`/api/agents/runs/${created.id}/cancel`, { reason: 'Done testing.' })
  assert.equal(cancelResponse.status, 200)
  assert.equal((await cancelResponse.json()).state, 'cancelled')
})

test('script resolution and artifacts work before a model call', async () => {
  const scriptResponse = await post('/api/agents/scripts', {
    name: 'count-tasks',
    intent: 'count tasks in the workspace',
    command: 'sqlite3 workspace.sqlite "select count(*) from tasks"',
    input_schema: {},
    output_schema: { type: 'number' },
    timeout_ms: 5000,
    cost_class: 'free'
  })
  assert.equal(scriptResponse.status, 201)
  const script = await scriptResponse.json()
  assert.equal(script.version, 1)
  assert.ok(script.id.startsWith('scr_'))

  const repeatResponse = await post('/api/agents/scripts', {
    name: 'count-tasks',
    intent: 'count tasks in the workspace',
    command: 'sqlite3 workspace.sqlite "select count(*) from tasks"',
    input_schema: {},
    output_schema: { type: 'number' },
    timeout_ms: 5000,
    cost_class: 'free'
  })
  assert.equal(repeatResponse.status, 200)
  assert.equal((await repeatResponse.json()).version, 1)

  const resolveResponse = await post('/api/agents/scripts/resolve', {
    intent: 'count tasks in the workspace'
  })
  assert.equal(resolveResponse.status, 200)
  const resolved = await resolveResponse.json()
  assert.equal(resolved.decision, 'script')
  assert.equal(resolved.script.id, script.id)

  const verifyResponse = await post(`/api/agents/scripts/${script.id}/verify`, {})
  assert.equal(verifyResponse.status, 200)
  assert.ok(Number.isInteger((await verifyResponse.json()).verifiedAt))

  const invalidName = await post('/api/agents/scripts', {
    name: 'Bad Name',
    intent: 'x',
    command: 'ls'
  })
  assert.equal(invalidName.status, 400)

  const artifactResponse = await post('/api/agents/artifacts', {
    kind: 'summary',
    producer: 'worker-a',
    content: '{"count":4}'
  })
  assert.equal(artifactResponse.status, 201)
  const artifact = await artifactResponse.json()
  assert.match(artifact.contentHash, /^[a-f0-9]{64}$/)

  const artifactRead = await fetch(`${baseUrl}/api/agents/artifacts/${artifact.contentHash}?content=true`)
  assert.equal(artifactRead.status, 200)
  assert.equal((await artifactRead.json()).content, '{"count":4}')

  const missingArtifact = await fetch(`${baseUrl}/api/agents/artifacts/${'0'.repeat(64)}`)
  assert.equal(missingArtifact.status, 404)
})

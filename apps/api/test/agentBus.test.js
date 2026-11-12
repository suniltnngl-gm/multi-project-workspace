import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase } from '../src/database.js'
import { createAgentBus } from '../src/agentBus.js'
import { createModelBudget } from '../src/modelBudget.js'

let directory
let database
let bus
let clock

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-agents-'))
  database = createDatabase(join(directory, 'agents.sqlite'))
  clock = Date.parse('2026-01-01T00:00:00.000Z')
  bus = createAgentBus({ database, now: () => clock })
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function createTask(title) {
  return database.createTask({ title, description: title })
}

function createRun(taskId, extra = {}, instance = bus) {
  const result = instance.createRun({
    task_id: taskId,
    agents: [
      { role: 'parent', name: 'parent', model: 'test-model' },
      { role: 'reviewer', name: 'reviewer', model: 'test-model' },
      { role: 'worker', name: 'worker-a', model: 'test-model' },
      { role: 'worker', name: 'worker-b', model: 'test-model' }
    ],
    ...extra
  })
  assert.ok(!result.error, JSON.stringify(result.error))
  const byName = Object.fromEntries(result.agents.map((agent) => [agent.name, agent]))
  return { run: result, parent: byName.parent, reviewer: byName.reviewer, a: byName['worker-a'], b: byName['worker-b'] }
}

function send(agent, run, body, instance = bus) {
  return instance.sendMessage({
    token: agent.token,
    runId: run.id,
    idempotencyKey: body.idempotencyKey ?? `k-${Math.random()}`,
    ...body
  })
}

const TEST_MODEL = {
  id: 'test-model',
  label: 'Test Model',
  provider: 'provider-a',
  backend: 'http',
  callable: true,
  autoSelect: true,
  billingCategory: 'free'
}

test('a run exposes agent tokens once and never on reads', () => {
  const task = createTask('Token task')
  const { run, parent, a } = createRun(task.id)

  assert.equal(run.state, 'draft')
  assert.equal(run.budget.maxTokens, 20000)
  assert.ok(parent.token.startsWith('agent_'))
  assert.ok(a.token.startsWith('agent_'))
  assert.equal(run.agents.find((agent) => agent.name === 'parent').token, parent.token)

  const read = bus.getRun(run.id)
  assert.equal(read.agents.find((agent) => agent.name === 'parent').token, undefined)
  assert.equal(read.agents.find((agent) => agent.name === 'parent').tokenHash, undefined)
  assert.equal(database.getAgentByTokenHash('not-a-hash'), null)
})

test('a worker result can be claimed, acknowledged, and completed', () => {
  const task = createTask('Result task')
  const { run, parent, a } = createRun(task.id)

  const sent = send(a, run, {
    to: 'parent',
    kind: 'result',
    payload: { summary: 'finished', facts: ['one'] },
    artifactRefs: ['file:apps/api/src/app.js'],
    idempotencyKey: 'result-1',
    correlationId: 'work-1'
  })
  assert.ok(!sent.error, JSON.stringify(sent.error))
  assert.equal(sent.message.seq, 1)
  assert.equal(sent.message.state, 'queued')

  const claimed = bus.claimInbox({ token: parent.token, runId: run.id, limit: 5 })
  assert.ok(!claimed.error, JSON.stringify(claimed.error))
  assert.equal(claimed.messages.length, 1)
  assert.equal(claimed.messages[0].id, sent.message.id)
  assert.equal(claimed.messages[0].state, 'delivered')

  const acked = bus.ackMessage({ token: parent.token, messageId: sent.message.id })
  assert.equal(acked.message.state, 'acked')

  const completed = bus.completeMessage({
    token: parent.token,
    messageId: sent.message.id,
    result: { accepted: true }
  })
  assert.equal(completed.message.state, 'completed')
  assert.deepEqual(completed.message.result, { accepted: true })
})

test('worker-to-worker and worker-to-reviewer edges are rejected', () => {
  const task = createTask('Edge task')
  const { run, a, b } = createRun(task.id)

  const peer = send(a, run, {
    to: 'worker-b',
    kind: 'result',
    payload: { summary: 'sneaky' },
    idempotencyKey: 'peer-1'
  })
  assert.equal(peer.error.status, 403)

  const reviewer = send(a, run, {
    to: 'reviewer',
    kind: 'question',
    payload: { question: 'help' },
    idempotencyKey: 'reviewer-1'
  })
  assert.equal(reviewer.error.status, 403)

  const wrongKind = send(a, run, {
    to: 'parent',
    kind: 'assign',
    payload: {},
    idempotencyKey: 'wrong-kind-1'
  })
  assert.equal(wrongKind.error.status, 403)

  assert.equal(bus.getRun(run.id).messages.length, 0)
})

test('the parent can assign work and the reviewer can return a verdict', () => {
  const task = createTask('Assign task')
  const { run, parent, reviewer, a } = createRun(task.id)

  const assign = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'inspect', output: { summary: 'string' } },
    idempotencyKey: 'assign-1',
    correlationId: 'work-1'
  })
  assert.ok(!assign.error, JSON.stringify(assign.error))
  assert.equal(assign.message.toAgentId, a.id)

  const claimed = bus.claimInbox({ token: a.token, runId: run.id })
  assert.equal(claimed.messages.length, 1)

  const verdict = send(reviewer, run, {
    to: 'parent',
    kind: 'verdict',
    payload: { approved: true },
    idempotencyKey: 'verdict-1'
  })
  assert.ok(!verdict.error, JSON.stringify(verdict.error))
  assert.equal(verdict.message.toAgentId, parent.id)
})

test('idempotent sends return the original message and reject a changed payload', () => {
  const task = createTask('Idempotency task')
  const { run, parent, a } = createRun(task.id)

  const first = send(a, run, {
    to: 'parent',
    kind: 'progress',
    payload: { phase: 'running' },
    idempotencyKey: 'same-key'
  })
  const second = send(a, run, {
    to: 'parent',
    kind: 'progress',
    payload: { phase: 'running' },
    idempotencyKey: 'same-key'
  })
  assert.equal(second.duplicate, true)
  assert.equal(second.message.id, first.message.id)

  const changed = send(a, run, {
    to: 'parent',
    kind: 'progress',
    payload: { phase: 'done' },
    idempotencyKey: 'same-key'
  })
  assert.equal(changed.error.status, 409)
  assert.equal(bus.getRun(run.id).messages.length, 1)

  // The parent is a separate sender, so the same key is a different message
  // only when the run key is still unique. The run-scoped unique constraint
  // means this must also collide, which is the intended broker contract.
  const other = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'x' },
    idempotencyKey: 'same-key'
  })
  assert.equal(other.error.status, 409)
})

test('an expired lease requeues the message instead of losing it', () => {
  const task = createTask('Lease task')
  const { run, parent, a } = createRun(task.id)

  const sent = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'long task' },
    idempotencyKey: 'lease-1'
  })
  const first = bus.claimInbox({ token: a.token, runId: run.id, leaseMs: 1000 })
  assert.equal(first.messages[0].id, sent.message.id)

  clock += 1001
  const second = bus.claimInbox({ token: a.token, runId: run.id, leaseMs: 1000 })
  assert.equal(second.requeued, 1)
  assert.equal(second.messages.length, 1)
  assert.equal(second.messages[0].id, sent.message.id)
})

test('a message past its deadline is expired and not delivered', () => {
  const task = createTask('Deadline task')
  const { run, parent, a } = createRun(task.id)

  send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'quick' },
    idempotencyKey: 'deadline-1',
    deadlineAt: clock + 500
  })
  clock += 501
  const claimed = bus.claimInbox({ token: a.token, runId: run.id })
  assert.equal(claimed.expired, 1)
  assert.equal(claimed.messages.length, 0)
  assert.equal(bus.getRun(run.id).messages[0].state, 'expired')
})

test('cancelling a run expires pending work and blocks new messages', () => {
  const task = createTask('Cancel task')
  const { run, parent, a } = createRun(task.id)

  send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'work' },
    idempotencyKey: 'cancel-1'
  })
  const cancelled = bus.cancelRun(run.id, 'Budget exhausted.')
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.error, 'Budget exhausted.')

  const detail = bus.getRun(run.id)
  assert.equal(detail.messages[0].state, 'expired')
  assert.equal(detail.agents.find((agent) => agent.name === 'worker-a').state, 'cancelled')

  const sent = send(a, run, {
    to: 'parent',
    kind: 'result',
    payload: { summary: 'late' },
    idempotencyKey: 'cancel-2'
  })
  assert.equal(sent.error.status, 409)
})

test('run transitions are explicit and checkpoints are authenticated', () => {
  const task = createTask('Transition task')
  const { run, parent } = createRun(task.id)

  assert.equal(bus.transitionRun(run.id, 'running').error.status, 409)
  assert.equal(bus.transitionRun(run.id, 'nonsense').error.status, 400)
  const started = bus.startRun(run.id)
  assert.equal(started.state, 'planning')
  assert.equal(bus.transitionRun(run.id, 'dispatching').state, 'dispatching')
  assert.equal(bus.transitionRun(run.id, 'running').state, 'running')

  const checkpoint = bus.checkpointRun({
    token: parent.token,
    runId: run.id,
    checkpoint: { round: 1, budgetUsed: { maxTokens: 100 } }
  })
  assert.equal(checkpoint.checkpoint.round, 1)

  const unauthenticated = bus.checkpointRun({
    token: 'agent_invalid',
    runId: run.id,
    checkpoint: { round: 2 }
  })
  assert.equal(unauthenticated.error.status, 401)
})

test('assignments are serialized per provider unless the slot is free', () => {
  const task = createTask('Provider concurrency task')
  const instance = createAgentBus({
    database,
    now: () => clock,
    models: [TEST_MODEL]
  })
  const { run, parent, a, b } = createRun(task.id, {}, instance)

  const first = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'first unit' },
    idempotencyKey: 'provider-concurrency-1'
  }, instance)
  assert.ok(!first.error, JSON.stringify(first.error))

  const blocked = send(parent, run, {
    to: 'worker-b',
    kind: 'assign',
    payload: { goal: 'second unit' },
    idempotencyKey: 'provider-concurrency-2'
  }, instance)
  assert.equal(blocked.error.status, 429)
  assert.equal(blocked.error.body.provider, 'provider-a')
  assert.equal(blocked.error.body.activeAssignments, 1)
  assert.equal(blocked.error.body.parallelLimit, 1)
  assert.equal(bus.getRun(run.id).messages.length, 1)

  // Finishing the in-flight assignment frees the provider slot (and costs no
  // model call in this test because the broker never invokes a model).
  bus.claimInbox({ token: a.token, runId: run.id })
  const completed = bus.completeMessage({
    token: a.token,
    messageId: first.message.id,
    result: { summary: 'done' }
  })
  assert.equal(completed.message.state, 'completed')

  const next = send(parent, run, {
    to: 'worker-b',
    kind: 'assign',
    payload: { goal: 'second unit' },
    idempotencyKey: 'provider-concurrency-2'
  }, instance)
  assert.ok(!next.error, JSON.stringify(next.error))
  assert.equal(next.message.toAgentId, b.id)
})

test('an assignment is refused when the provider quota has no headroom', () => {
  const task = createTask('Provider quota task')
  const modelBudget = createModelBudget({
    profiles: {
      'test-model': [{ unit: 'requests', limit: 1, window: 'day', reset: 'fixed' }]
    },
    now: () => clock
  })
  modelBudget.record('test-model')
  const instance = createAgentBus({
    database,
    now: () => clock,
    models: [TEST_MODEL],
    modelBudget
  })
  const { run, parent } = createRun(task.id, {}, instance)

  const denied = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'quota-bound unit' },
    idempotencyKey: 'provider-quota-1'
  }, instance)
  assert.equal(denied.error.status, 429)
  assert.match(denied.error.body.error, /no provider quota headroom/)
  assert.equal(denied.error.body.provider, 'provider-a')
  assert.ok(Number.isFinite(denied.error.body.retryAfter))
  assert.equal(denied.error.body.budget.remaining, 0)
  assert.equal(bus.getRun(run.id).messages.length, 0)
})

test('run usage totals gate further assignments without hiding the spend', () => {
  const task = createTask('Run usage task')
  const instance = createAgentBus({ database, now: () => clock })
  const { run, parent, a } = createRun(task.id, {
    budget: { maxTokens: 10, maxCalls: 10, maxMs: 600000 }
  }, instance)

  const first = instance.recordUsage({
    token: a.token,
    runId: run.id,
    usage: { calls: 1, prompt_tokens: 3, completion_tokens: 2, duration_ms: 15 }
  })
  assert.ok(!first.error, JSON.stringify(first.error))
  assert.equal(first.usage.totalTokens, 5)
  assert.equal(first.exhausted, false)

  const second = instance.recordUsage({
    token: a.token,
    runId: run.id,
    usage: { calls: 1, prompt_tokens: 5, completion_tokens: 2, duration_ms: 20 }
  })
  assert.ok(!second.error, JSON.stringify(second.error))
  assert.equal(second.usage.calls, 2)
  assert.equal(second.usage.totalTokens, 12)
  assert.equal(second.exhausted, true)
  assert.equal(second.remaining.tokens, -2)

  const totals = database.getAgentRunUsage(run.id)
  assert.equal(totals.entries, 2)
  assert.equal(totals.totalTokens, 12)
  assert.equal(totals.byModel.length, 1)
  assert.equal(totals.byModel[0].calls, 2)

  const denied = send(parent, run, {
    to: 'worker-a',
    kind: 'assign',
    payload: { goal: 'over budget' },
    idempotencyKey: 'run-budget-1'
  }, instance)
  assert.equal(denied.error.status, 429)
  assert.equal(denied.error.body.exhausted, true)
  assert.equal(denied.error.body.usage.totalTokens, 12)

  const plan = instance.dispatchPlan(run.id)
  assert.equal(plan.exhausted, true)
  assert.equal(plan.usage.totalTokens, 12)
  assert.equal(plan.ok, false)

  const invalid = instance.recordUsage({
    token: a.token,
    runId: run.id,
    usage: { calls: -1 }
  })
  assert.equal(invalid.error.status, 400)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase } from '../src/database.js'
import { createAgentBus } from '../src/agentBus.js'

let directory
let database
let bus

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-agent-ops-'))
  database = createDatabase(join(directory, 'ops.sqlite'))
  bus = createAgentBus({ database })
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function createRunForTask(taskId) {
  const result = bus.createRun({
    task_id: taskId,
    agents: [
      { role: 'parent', name: 'parent', model: 'test-model' },
      { role: 'worker', name: 'worker-a', model: 'test-model' }
    ]
  })
  assert.ok(!result.error, JSON.stringify(result.error))
  const parent = result.agents.find((agent) => agent.name === 'parent')
  const worker = result.agents.find((agent) => agent.name === 'worker-a')
  return { run: result, parent, worker }
}

test('the parent can create and update scoped tasks with activity events', () => {
  const parentTask = database.createTask({ title: 'Parent task', description: 'Scope root' })
  const { run, parent, worker } = createRunForTask(parentTask.id)
  const agent = bus.authenticate(parent.token)

  const created = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'create-child',
      op: 'create_task',
      title: 'Child task',
      description: 'Created by the parent.',
      priority: 'high'
    }]
  })
  assert.equal(created.results[0].status, 'created')
  const child = database.getTask(created.results[0].taskId)
  assert.equal(child.parent_task_id, parentTask.id)
  assert.equal(child.agent_run_id, run.id)
  assert.ok(
    database.listTaskActivity(child.id).some((event) => event.action === 'agent_linked'),
    'the agent link should be in the task activity trail'
  )

  const inProgress = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'start-child',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: child.updated_at,
      fields: {
        status: 'in_progress',
        work_active: 'Implementing the child task.'
      }
    }]
  })
  assert.equal(inProgress.results[0].status, 'updated')
  const updated = database.getTask(child.id)
  assert.equal(updated.status, 'in_progress')
  assert.equal(updated.work_active, 'Implementing the child task.')
  assert.ok(database.listTaskActivity(child.id).some((event) => event.field === 'work_active'))

  // A stale expected timestamp becomes a conflict, never an overwrite.
  const conflict = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'conflict-child',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: '2000-01-01 00:00:00',
      fields: { work_active: 'Stale write.' }
    }]
  })
  assert.equal(conflict.results[0].status, 'conflict')
  assert.equal(database.getTask(child.id).work_active, 'Implementing the child task.')

  const forbidden = database.applyTaskOps({
    agent: bus.authenticate(worker.token),
    ops: [{ op_id: 'worker-write', op: 'update_task', task_id: child.id, expected_updated_at: updated.updated_at, fields: { work_active: 'nope' } }]
  })
  assert.equal(forbidden.error.status, 403)
})

test('done is verifier-gated and blocked work needs a reason', () => {
  const parentTask = database.createTask({ title: 'Completion task' })
  const { run, parent } = createRunForTask(parentTask.id)
  const agent = bus.authenticate(parent.token)

  const childResult = database.applyTaskOps({
    agent,
    ops: [{ op_id: 'create-done-child', op: 'create_task', title: 'Done child' }]
  })
  let child = database.getTask(childResult.results[0].taskId)

  const blockedWithoutReason = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'blocked-no-reason',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: child.updated_at,
      fields: { status: 'blocked' }
    }]
  })
  assert.equal(blockedWithoutReason.results[0].status, 'rejected')

  const blocked = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'blocked-with-reason',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: child.updated_at,
      fields: { status: 'blocked' },
      reason: 'Waiting for the verifier.'
    }]
  })
  assert.equal(blocked.results[0].status, 'updated')
  child = database.getTask(child.id)
  assert.equal(child.work_blocked, 'Waiting for the verifier.')

  const unverifiedDone = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'done-unverified',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: child.updated_at,
      fields: { status: 'done', acceptance_criteria: 'Verified by tests.' }
    }]
  })
  assert.equal(unverifiedDone.results[0].status, 'rejected')
  assert.equal(database.getTask(child.id).status, 'blocked')

  const verifiedDone = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'done-verified',
      op: 'update_task',
      task_id: child.id,
      expected_updated_at: child.updated_at,
      fields: { status: 'done', acceptance_criteria: 'Verified by tests.' },
      verified: true
    }]
  })
  assert.equal(verifiedDone.results[0].status, 'updated')
  assert.equal(database.getTask(child.id).status, 'done')
})

test('opportunistic work becomes a proposal and task ops replay idempotently', () => {
  const parentTask = database.createTask({ title: 'Proposal task' })
  const { run, parent } = createRunForTask(parentTask.id)
  const agent = bus.authenticate(parent.token)

  const op = {
    op_id: 'propose-1',
    op: 'propose_task',
    title: 'Extract a reusable scan script',
    description: 'The same scan ran three times.',
    rationale: 'Stop repeating the model call.',
    priority: 'medium'
  }
  const first = database.applyTaskOps({ agent, ops: [op] })
  assert.equal(first.results[0].status, 'proposed')
  const proposals = database.listTaskProposals()
  const proposal = proposals.find((entry) => entry.title === op.title)
  assert.ok(proposal)
  assert.equal(proposal.originAgentRunId, run.id)

  const replay = database.applyTaskOps({ agent, ops: [op] })
  assert.equal(replay.results[0].status, 'duplicate')
  assert.equal(database.listTaskProposals().filter((entry) => entry.title === op.title).length, 1)

  const duplicateTitle = database.applyTaskOps({
    agent,
    ops: [{ ...op, op_id: 'propose-2', description: 'Second attempt.' }]
  })
  assert.equal(duplicateTitle.results[0].status, 'skipped')
})

test('create_task cannot attach to a task outside the run', () => {
  const parentTask = database.createTask({ title: 'Scoped parent' })
  const outsider = database.createTask({ title: 'Outsider' })
  const { parent } = createRunForTask(parentTask.id)
  const agent = bus.authenticate(parent.token)

  const result = database.applyTaskOps({
    agent,
    ops: [{
      op_id: 'outside-parent',
      op: 'create_task',
      title: 'Should not exist',
      parent_task_id: outsider.id
    }]
  })
  assert.equal(result.results[0].status, 'rejected')
  assert.match(result.results[0].error, /outside this agent run/)
})

test('create_task is capped per run', () => {
  const parentTask = database.createTask({ title: 'Create cap parent' })
  const { parent } = createRunForTask(parentTask.id)
  const agent = bus.authenticate(parent.token)

  for (let index = 1; index <= 5; index += 1) {
    const result = database.applyTaskOps({
      agent,
      ops: [{ op_id: `cap-${index}`, op: 'create_task', title: `Cap child ${index}` }]
    })
    assert.equal(result.results[0].status, 'created')
  }

  const overflow = database.applyTaskOps({
    agent,
    ops: [{ op_id: 'cap-6', op: 'create_task', title: 'Cap child 6' }]
  })
  assert.equal(overflow.results[0].status, 'rejected')
  assert.match(overflow.results[0].error, /at most 5/)
  assert.equal(
    database.listTasks().filter((task) => task.parent_task_id === parentTask.id).length,
    5
  )
})

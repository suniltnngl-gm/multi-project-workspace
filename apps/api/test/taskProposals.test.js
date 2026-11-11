// Objective: Test the task proposal domain: dry-run persistence, dedupe, and the approve, reject, and rollback decisions.
// Requirements: Improvement suggestions persist as proposals that never become tasks without approval; re-runs skip undecided titles; approve creates and links the task atomically; rollback deletes the task while keeping the proposal's history.
// Decisions: One shared database and app instance across store- and route-level tests, mirroring mcpCatalog.test.js; the improve fallback test injects a fake modelClient on its own app instance so no real backend is contacted; store error objects are asserted by shape because routes map them verbatim.
// Relevant Files: apps/api/test/taskProposals.test.js, apps/api/src/db/taskProposals.js, apps/api/src/routes/proposals.js, apps/api/src/routes/aiDrafts.js
// Important Context: User file. The approval gate behind task #41.
// Work State: Completed: Added as task #41; Active: None; Blocked: None; Next Move: Maintain as needed.
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
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-proposals-'))
  database = createDatabase(join(directory, 'proposals.sqlite'))
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

test('createTaskProposals normalizes fields and skips undecided titles', () => {
  const first = database.createTaskProposals({
    proposals: [
      {
        title: '  Normalize the model output  ',
        description: 'Keep proposals small.',
        priority: 'urgent-but-not-really',
        task_type: 'refactor',
        project: '  ',
        rationale: 'Model output drifts.'
      },
      { title: 'Second proposal', description: '', priority: 'high' },
      { title: '', description: 'No title is silently dropped.' }
    ],
    jobId: 'job-proposals-1'
  })
  assert.equal(first.created.length, 2)
  assert.equal(first.skipped, 0)

  const [normalized, second] = first.created
  assert.equal(normalized.title, 'Normalize the model output')
  assert.equal(normalized.priority, 'medium', 'unknown priorities normalize to medium')
  assert.equal(normalized.taskType, 'chore', 'unknown task types normalize to chore')
  assert.equal(normalized.project, 'workspace', 'blank projects normalize to workspace')
  assert.equal(normalized.status, 'proposed')
  assert.equal(normalized.originJobId, 'job-proposals-1')
  assert.equal(normalized.createdTaskId, undefined)
  assert.equal(normalized.decidedAt, undefined)
  assert.ok(normalized.createdAt)
  assert.equal(second.priority, 'high')

  // A re-run with the same titles skips them while they are undecided.
  const rerun = database.createTaskProposals({
    proposals: [
      { title: 'normalize the model output', priority: 'low' },
      { title: 'Second proposal', priority: 'low' },
      { title: 'A fresh proposal', priority: 'low' }
    ],
    jobId: 'job-proposals-2'
  })
  assert.equal(rerun.created.length, 1)
  assert.equal(rerun.skipped, 2)
  assert.equal(rerun.created[0].title, 'A fresh proposal')

  // A decided title may be proposed again.
  database.rejectTaskProposal(second.id)
  const afterReject = database.createTaskProposals({
    proposals: [{ title: 'Second proposal', priority: 'low' }],
    jobId: 'job-proposals-3'
  })
  assert.equal(afterReject.created.length, 1)
  assert.equal(afterReject.skipped, 0)
  assert.equal(afterReject.created[0].originJobId, 'job-proposals-3')
})

test('approve creates the task from the stored fields and links the origin', () => {
  const { created } = database.createTaskProposals({
    proposals: [{
      title: 'Approve me',
      description: 'The task body.',
      priority: 'high',
      task_type: 'feature',
      project: 'workspace',
      rationale: 'Worth doing.'
    }],
    jobId: 'job-approve-1'
  })
  const proposal = created[0]

  const result = database.approveTaskProposal(proposal.id)
  assert.equal(result.error, undefined)
  assert.equal(result.proposal.id, proposal.id)
  assert.equal(result.proposal.status, 'approved')
  assert.equal(result.proposal.createdTaskId, result.task.id)
  assert.ok(result.proposal.decidedAt)

  assert.equal(result.task.title, 'Approve me')
  assert.equal(result.task.description, 'The task body.')
  assert.equal(result.task.priority, 'high')
  assert.equal(result.task.task_type, 'feature')
  assert.equal(result.task.status, 'todo')
  assert.equal(result.task.origin_job_id, 'job-approve-1')

  const detail = database.getTaskDetail(result.task.id)
  assert.ok(detail.activity.some(
    (event) => event.action === 'drafted' && event.field === 'origin_job_id' &&
      event.newValue === 'job-approve-1'
  ))

  // A second approve is a state conflict, and the task is not duplicated.
  const conflict = database.approveTaskProposal(proposal.id)
  assert.equal(conflict.error.status, 409)
  assert.equal(database.listTasks({ search: 'Approve me' }).length, 1)
})

test('approve without an origin creates the task unlinked', () => {
  const { created } = database.createTaskProposals({
    proposals: [{ title: 'No origin proposal', priority: 'low' }],
    jobId: ''
  })
  const result = database.approveTaskProposal(created[0].id)
  assert.equal(result.error, undefined)
  assert.equal(result.task.origin_job_id, '')
  const detail = database.getTaskDetail(result.task.id)
  assert.ok(!detail.activity.some((event) => event.field === 'origin_job_id'))
})

test('reject records the decision without creating a task', () => {
  const { created } = database.createTaskProposals({
    proposals: [{ title: 'Reject me', priority: 'low' }],
    jobId: 'job-reject-1'
  })
  const result = database.rejectTaskProposal(created[0].id)
  assert.equal(result.error, undefined)
  assert.equal(result.proposal.status, 'rejected')
  assert.equal(result.proposal.createdTaskId, undefined)
  assert.ok(result.proposal.decidedAt)
  assert.ok(!database.listTasks({ search: 'Reject me' }).length)

  const conflict = database.rejectTaskProposal(created[0].id)
  assert.equal(conflict.error.status, 409)
  const rollbackConflict = database.rollbackTaskProposal(created[0].id)
  assert.equal(rollbackConflict.error.status, 409)
})

test('rollback deletes the created task but keeps the history', () => {
  const { created } = database.createTaskProposals({
    proposals: [{ title: 'Roll me back', priority: 'medium' }],
    jobId: 'job-rollback-1'
  })
  const approved = database.approveTaskProposal(created[0].id)
  const taskId = approved.task.id

  const result = database.rollbackTaskProposal(created[0].id)
  assert.equal(result.error, undefined)
  assert.equal(result.proposal.status, 'rolled_back')
  assert.equal(result.proposal.createdTaskId, taskId, 'the created task id survives as history')
  assert.ok(result.proposal.decidedAt)
  assert.equal(result.proposal.id, created[0].id)
  assert.equal(database.getTask(taskId), null, 'the created task is deleted')

  const conflict = database.rollbackTaskProposal(created[0].id)
  assert.equal(conflict.error.status, 409)
})

test('decisions on unknown proposals report 404', () => {
  for (const method of ['approveTaskProposal', 'rejectTaskProposal', 'rollbackTaskProposal']) {
    const result = database[method](999999)
    assert.equal(result.error.status, 404, method)
    assert.ok(result.error.body.error)
  }
})

test('the proposals routes list, filter, and reject bad input', async () => {
  const { created } = database.createTaskProposals({
    proposals: [
      { title: 'Route listed proposal', priority: 'low' },
      { title: 'Route approved proposal', priority: 'low' }
    ],
    jobId: 'job-routes-1'
  })
  const listed = created[0]
  const approved = created[1]
  await fetch(`${baseUrl}/api/proposals/${approved.id}/approve`, { method: 'POST' })

  const all = await (await fetch(`${baseUrl}/api/proposals`)).json()
  assert.ok(all.some((entry) => entry.id === listed.id))
  assert.ok(all.some((entry) => entry.id === approved.id))

  const proposed = await (await fetch(`${baseUrl}/api/proposals?status=proposed`)).json()
  assert.ok(proposed.some((entry) => entry.id === listed.id))
  assert.ok(!proposed.some((entry) => entry.id === approved.id))

  const badStatus = await fetch(`${baseUrl}/api/proposals?status=bogus`)
  assert.equal(badStatus.status, 400)

  const detail = await (await fetch(`${baseUrl}/api/proposals/${listed.id}`)).json()
  assert.equal(detail.id, listed.id)
  assert.equal(detail.title, 'Route listed proposal')

  const missing = await fetch(`${baseUrl}/api/proposals/999999`)
  assert.equal(missing.status, 404)

  const invalid = await fetch(`${baseUrl}/api/proposals/not-a-number`)
  assert.equal(invalid.status, 400)
})

test('the decision routes approve, reject, and rollback with run stamping', async () => {
  const { created } = database.createTaskProposals({
    proposals: [
      { title: 'Route approve target', priority: 'low' },
      { title: 'Route reject target', priority: 'low' }
    ],
    jobId: 'job-routes-2'
  })
  const approveTarget = created[0]
  const rejectTarget = created[1]

  const approve = await fetch(`${baseUrl}/api/proposals/${approveTarget.id}/approve`, { method: 'POST' })
  assert.equal(approve.status, 200)
  const decision = await approve.json()
  assert.equal(decision.proposal.status, 'approved')
  assert.equal(decision.task.title, 'Route approve target')

  const doubleApprove = await fetch(`${baseUrl}/api/proposals/${approveTarget.id}/approve`, { method: 'POST' })
  assert.equal(doubleApprove.status, 409)

  const reject = await fetch(`${baseUrl}/api/proposals/${rejectTarget.id}/reject`, { method: 'POST' })
  assert.equal(reject.status, 200)
  const rejected = await reject.json()
  assert.equal(rejected.proposal.status, 'rejected')
  assert.equal(rejected.task, undefined)

  const rollback = await fetch(`${baseUrl}/api/proposals/${approveTarget.id}/rollback`, { method: 'POST' })
  assert.equal(rollback.status, 200)
  const rolled = await rollback.json()
  assert.equal(rolled.proposal.status, 'rolled_back')
  assert.equal(rolled.proposal.createdTaskId, decision.task.id)
  assert.equal(
    (await fetch(`${baseUrl}/api/tasks/${decision.task.id}`)).status,
    404,
    'the created task is deleted by rollback'
  )

  const missing = await fetch(`${baseUrl}/api/proposals/999999/approve`, { method: 'POST' })
  assert.equal(missing.status, 404)

  const invalid = await fetch(`${baseUrl}/api/proposals/nope/approve`, { method: 'POST' })
  assert.equal(invalid.status, 400)

  // Every decision is recorded as an api tool run, like any mutation.
  const apiRuns = database.listToolRuns({ kind: 'api', limit: 200 })
  assert.ok(apiRuns.some((run) => run.label === `POST /api/proposals/${approveTarget.id}/approve`))
  assert.ok(apiRuns.some((run) => run.label === `POST /api/proposals/${rejectTarget.id}/reject`))
  assert.ok(apiRuns.some((run) => run.label === `POST /api/proposals/${approveTarget.id}/rollback`))
})

test('non-JSON model output becomes a review proposal through the improve route', async () => {
  const app = createApp(database, {
    models: [LOCAL_MODEL],
    getResourceMetrics: idleMetrics,
    turnCooldownMs: 0,
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async () => 'The model rambled instead of returning JSON.'
    }
  })
  const improveServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    improveServer.once('listening', resolve)
    improveServer.once('error', reject)
  })
  try {
    const url = `http://127.0.0.1:${improveServer.address().port}`
    const improve = await fetch(`${url}/api/ai/improve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    assert.equal(improve.status, 200)
    const body = await improve.json()
    assert.ok(body.jobId.startsWith('job-'))
    assert.equal(body.proposals.length, 1)
    assert.equal(body.proposals[0].title, 'Review AI improvement output')
    assert.equal(body.proposals[0].description, 'The model rambled instead of returning JSON.')
    assert.equal(body.proposals[0].status, 'proposed')
    assert.equal(body.proposals[0].originJobId, body.jobId)
    assert.equal(body.skipped, 0)
  } finally {
    await new Promise((resolve) => improveServer.close(resolve))
  }
})

// Objective: Test task-to-model provenance from draft and improvement runs to approved tasks.
// Requirements: Draft responses carry jobId; source_job_id creation records origin, links the job, and 404/409s on bad references; improvement runs persist proposals whose approved tasks carry origin; ai runs match by task link or origin.
// Decisions: Reuse the aiComplete fixture pattern (injected local model plus fake modelClient) so no real backend is contacted; PATCH must never set provenance fields; the improve flow is exercised through its real decisions (re-run dedupe, approve) so origin linkage is proven end to end.
// Relevant Files: apps/api/test/taskProvenance.test.js, apps/api/src/app.js, apps/api/src/database.js, apps/api/src/taskJobStore.js
// Important Context: User file. The database lives in a temp directory and is shared across tests; each test builds its own app instance.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
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

const DRAFT = JSON.stringify({
  description: 'A drafted task from the model.',
  acceptance_criteria: ['First criterion', 'Second criterion']
})

const IMPROVEMENTS = JSON.stringify([
  {
    title: 'Improve tracking',
    description: 'Keep the domains in step.',
    priority: 'low',
    rationale: 'Tracking drifts after manual edits.'
  }
])

let directory
let database

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-task-provenance-'))
  database = createDatabase(join(directory, 'provenance.sqlite'))
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function withApp({ respond = async () => DRAFT } = {}, run) {
  const app = createApp(database, {
    models: [LOCAL_MODEL],
    getResourceMetrics: idleMetrics,
    turnCooldownMs: 0,
    modelClient: {
      probe: async () => ({ ok: true }),
      complete: async (model, request) => respond(model, request)
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
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

test('a draft response carries its job id and records provenance on the created task', async () => {
  await withApp({}, async (url) => {
    const draftResponse = await post(url, '/api/local-ai/refine-task', { title: 'Drafted feature' })
    assert.equal(draftResponse.status, 200)
    const draft = await draftResponse.json()
    assert.ok(draft.jobId.startsWith('job-'), 'the sync draft response includes the job id')
    assert.equal(draft.description, 'A drafted task from the model.')

    const created = await post(url, '/api/tasks', {
      title: 'Drafted feature',
      description: draft.description,
      source_job_id: draft.jobId
    })
    assert.equal(created.status, 201)
    const task = await created.json()
    assert.equal(task.origin_job_id, draft.jobId)

    const detail = await (await fetch(`${url}/api/tasks/${task.id}`)).json()
    assert.ok(detail.activity.some(
      (event) => event.action === 'drafted' && event.field === 'origin_job_id' &&
        event.newValue === draft.jobId
    ))
    assert.equal(detail.aiRuns.length, 1)
    assert.equal(detail.aiRuns[0].id, draft.jobId)

    const jobs = await (await fetch(`${url}/api/local-ai/jobs`)).json()
    const job = jobs.find((entry) => entry.id === draft.jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.taskId, task.id)
  })
})

test('task creation validates the source job reference and provenance stays immutable', async () => {
  await withApp({}, async (url) => {
    const tasksBefore = database.listTasks().length
    const unknown = await post(url, '/api/tasks', { title: 'No source', source_job_id: 'job-424242' })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error, 'AI job not found.')

    const invalid = await post(url, '/api/tasks', { title: 'Bad source', source_job_id: '   ' })
    assert.equal(invalid.status, 400)
    assert.equal(database.listTasks().length, tasksBefore, 'no task is created for a bad reference')

    // A job that refined an existing task is already linked to it.
    const task = database.createTask({ title: 'Existing task', description: '' })
    const refined = await post(url, '/api/local-ai/refine-task', {
      title: 'Existing task',
      task_id: task.id
    })
    assert.equal(refined.status, 200)
    const refineBody = await refined.json()
    assert.ok(refineBody.jobId.startsWith('job-'))
    const refinedDetail = await (await fetch(`${url}/api/tasks/${task.id}`)).json()
    assert.ok(refinedDetail.aiRuns.some((run) => run.id === refineBody.jobId))

    const conflict = await post(url, '/api/tasks', {
      title: 'From a linked job',
      source_job_id: refineBody.jobId
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error, 'This AI job is already linked to a task.')

    for (const field of ['source_job_id', 'origin_job_id']) {
      const patch = await fetch(`${url}/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: 'job-1' })
      })
      assert.equal(patch.status, 400, `${field} is not patchable`)
    }
    const untouched = await (await fetch(`${url}/api/tasks/${task.id}`)).json()
    assert.equal(untouched.origin_job_id, '')
  })
})

test('an improvement run is a job whose approved proposals carry the origin', async () => {
  await withApp({ respond: async () => IMPROVEMENTS }, async (url) => {
    const improve = await post(url, '/api/ai/improve', {})
    assert.equal(improve.status, 200)
    const body = await improve.json()
    assert.ok(body.jobId.startsWith('job-'))
    assert.equal(body.proposals.length, 1)
    assert.equal(body.skipped, 0)
    assert.equal(body.proposals[0].title, 'Improve tracking')
    assert.equal(body.proposals[0].status, 'proposed')
    assert.equal(body.proposals[0].originJobId, body.jobId)

    // The run is a dry-run: no task exists until the proposal is approved.
    const beforeApprove = await (await fetch(`${url}/api/tasks`)).json()
    assert.ok(!beforeApprove.some((task) => task.title === 'Improve tracking'))

    // A re-run skips titles that still have an undecided proposal.
    const rerun = await post(url, '/api/ai/improve', {})
    assert.equal(rerun.status, 200)
    const rerunBody = await rerun.json()
    assert.equal(rerunBody.proposals.length, 0)
    assert.equal(rerunBody.skipped, 1)

    const approve = await post(url, `/api/proposals/${body.proposals[0].id}/approve`, {})
    assert.equal(approve.status, 200)
    const decision = await approve.json()
    assert.equal(decision.proposal.status, 'approved')
    assert.equal(decision.proposal.createdTaskId, decision.task.id)
    assert.equal(decision.task.title, 'Improve tracking')
    assert.equal(decision.task.origin_job_id, body.jobId)

    const detail = await (await fetch(`${url}/api/tasks/${decision.task.id}`)).json()
    assert.ok(detail.activity.some(
      (event) => event.action === 'drafted' && event.field === 'origin_job_id' &&
        event.newValue === body.jobId
    ))
    assert.equal(detail.aiRuns.length, 1)
    assert.equal(detail.aiRuns[0].id, body.jobId)
    assert.equal(detail.aiRuns[0].model, 'local-0.5b')

    // The run itself stays task-unlinked: one run can draft several tasks.
    const jobs = await (await fetch(`${url}/api/local-ai/jobs`)).json()
    const job = jobs.find((entry) => entry.id === body.jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.taskId, undefined)
    assert.equal(job.title, 'Improve workspace')
  })
})

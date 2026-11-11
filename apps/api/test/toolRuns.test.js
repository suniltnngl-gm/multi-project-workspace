import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-tool-runs-'))
  await mkdir(join(directory, 'docs'), { recursive: true })
  database = createDatabase(join(directory, 'tool-runs.sqlite'), { rootDir: directory })
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

test('a mutating request stamps its events with an api run', async () => {
  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Provenance target' })
  })
  assert.equal(created.status, 201)
  const task = await created.json()

  const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json()
  const createdEvent = detail.activity.at(-1)
  assert.equal(createdEvent.action, 'created')
  assert.equal(createdEvent.run.kind, 'api')
  assert.equal(createdEvent.run.label, 'POST /api/tasks')

  const run = database.getToolRun(createdEvent.run.id)
  assert.equal(run.kind, 'api')
  assert.equal(run.label, 'POST /api/tasks')
  assert.ok(run.finishedAt, 'the request run finished with its response')
})

test('the run label records which resource the request touched', async () => {
  const list = await (await fetch(`${baseUrl}/api/tasks`)).json()
  const task = list[0]

  const updated = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'Touched through the API.' })
  })
  assert.equal(updated.status, 200)

  const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json()
  const updateEvent = detail.activity[0]
  assert.equal(updateEvent.action, 'updated')
  assert.equal(updateEvent.field, 'description')
  assert.equal(updateEvent.run.label, `PATCH /api/tasks/${task.id}`)
})

test('reads never start a run', async () => {
  const before = database.listToolRuns({ limit: 200 }).length
  await fetch(`${baseUrl}/api/tasks`)
  await fetch(`${baseUrl}/api/runs`)
  const after = database.listToolRuns({ limit: 200 }).length
  assert.equal(after, before, 'GET requests leave no run rows behind')
})

test('a scan stamps its events with a scan run even inside a request', async () => {
  const content = [
    '# Objective: Scanned note.',
    '# Requirements: Provenance points at the scanner.',
    ''
  ].join('\n')
  await writeFile(join(directory, 'docs', 'scanned.md'), content)

  const scanned = await fetch(`${baseUrl}/api/files/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: directory })
  })
  assert.equal(scanned.status, 200)

  const file = database.getUserFileByPath('docs/scanned.md')
  assert.ok(file, 'the scanned file is tracked')
  const detail = database.getUserFileDetail(file.id)
  const events = detail.activity
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.equal(event.run.kind, 'scan', 'the inner scan run wins over the request run')
    assert.equal(event.run.label, 'user-files')
  }

  const scanRuns = database.listToolRuns({ kind: 'scan', limit: 200 })
  assert.ok(scanRuns.some((run) => run.label === 'user-files'))
  assert.ok(scanRuns.every((run) => run.finishedAt), 'the scan run finished')
})

test('withToolRun keeps its context across awaits', async () => {
  await database.withToolRun({ kind: 'api', label: 'async-flow' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(database.currentToolRunId(), 'the run context survived the await')
    database.createTask({ title: 'Async provenance' })
  })
  const task = database.listTasks({ search: 'Async provenance' })[0]
  const detail = database.getTaskDetail(task.id)
  const createdEvent = detail.activity.at(-1)
  assert.equal(createdEvent.run.label, 'async-flow')
})

test('events without a run keep their legacy shape', () => {
  const file = database.createUserFile({ path: 'docs/manual.md', objective: 'Manual edit' })
  const detail = database.getUserFileDetail(file.id)
  const createdEvent = detail.activity.at(-1)
  assert.equal(createdEvent.action, 'created')
  assert.equal(createdEvent.run, undefined, 'no ambient run means no run field')
})

test('runs nest, and the innermost run stamps the events', () => {
  const outer = database.startToolRun({ kind: 'api', label: 'outer' })
  database.enterToolRun(outer)
  try {
    const inner = database.withToolRun({ kind: 'scan', label: 'inner' }, () => {
      database.createTask({ title: 'Nested provenance' })
      return database.currentToolRunId()
    })
    const innerRun = database.getToolRun(inner)
    assert.equal(innerRun.label, 'inner')

    const task = database.listTasks({ search: 'Nested provenance' })[0]
    const createdEvent = database.getTaskDetail(task.id).activity.at(-1)
    assert.equal(createdEvent.run.id, inner, 'the inner run stamped the event')
  } finally {
    database.finishToolRun(outer.id)
    assert.equal(database.currentToolRunId(), outer.id, 'leaving the inner run restores the outer')
  }
})

test('the runs routes list and filter runs', async () => {
  const runs = await (await fetch(`${baseUrl}/api/runs`)).json()
  assert.ok(Array.isArray(runs))
  assert.ok(runs.length > 0)
  assert.ok(runs[0].id >= 1)

  const scans = await (await fetch(`${baseUrl}/api/runs?kind=scan`)).json()
  assert.ok(scans.length > 0)
  assert.ok(scans.every((run) => run.kind === 'scan'))

  const detail = await (await fetch(`${baseUrl}/api/runs/${runs[0].id}`)).json()
  assert.equal(detail.id, runs[0].id)

  const missing = await fetch(`${baseUrl}/api/runs/999999`)
  assert.equal(missing.status, 404)

  const invalid = await fetch(`${baseUrl}/api/runs/not-a-number`)
  assert.equal(invalid.status, 400)
})

test('the migration adds run_id to both event tables', () => {
  for (const table of ['task_events', 'user_file_events']) {
    const columns = eventTableColumns(table)
    assert.ok(columns.includes('run_id'), `${table} carries run_id`)
  }
})

function eventTableColumns(table) {
  // The store surface does not expose the connection, so the column check
  // reads the same database file directly, read-only.
  const connection = new Database(join(directory, 'tool-runs.sqlite'), { readonly: true })
  const columns = connection.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  connection.close()
  return columns
}

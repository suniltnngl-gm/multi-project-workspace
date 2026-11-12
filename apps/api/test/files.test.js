import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { scanWorkspaceUserFiles } from '../src/workspaceScan.js'

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-files-'))
  database = createDatabase(join(directory, 'files.sqlite'))
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

test('user files can be scanned, created, updated, and deleted', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/files/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.ok(Array.isArray(scanned.paths))

  const createResponse = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'docs/example.md',
      objective: 'Track documentation',
      requirements: 'Keep it concise'
    })
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.equal(created.path, 'docs/example.md')
  assert.equal(created.objective, 'Track documentation')
  assert.equal(created.requirements, 'Keep it concise')

  const duplicateResponse = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/example.md' })
  })
  assert.equal(duplicateResponse.status, 409)

  const updateResponse = await fetch(`${baseUrl}/api/files/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions: 'Use Markdown' })
  })
  assert.equal(updateResponse.status, 200)
  assert.equal((await updateResponse.json()).decisions, 'Use Markdown')

  const listResponse = await fetch(`${baseUrl}/api/files`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.ok(listed.some((file) => file.path === 'docs/example.md'))

  const deleteResponse = await fetch(`${baseUrl}/api/files/${created.id}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 204)
})

test('the files search filter rejects non-string and oversized values', async () => {
  const repeated = await fetch(`${baseUrl}/api/files?search=a&search=b`)
  assert.equal(repeated.status, 400)

  const nested = await fetch(`${baseUrl}/api/files?search[term]=a`)
  assert.equal(nested.status, 400)

  const oversized = await fetch(`${baseUrl}/api/files?search=${'a'.repeat(201)}`)
  assert.equal(oversized.status, 400)

  const empty = await fetch(`${baseUrl}/api/files?search=`)
  assert.equal(empty.status, 200)
})

test('scans mark vanished files missing and restore them without losing history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-file-lifecycle-'))
  const lifecycleDatabase = createDatabase(join(root, 'lifecycle.sqlite'), { rootDir: root })
  try {
    await mkdir(join(root, 'docs'), { recursive: true })
    const filePath = join(root, 'docs', 'old.md')
    await writeFile(filePath, '# Objective: Kept for history.\n')

    const first = scanWorkspaceUserFiles({ rootDir: root, database: lifecycleDatabase })
    assert.equal(first.inserted, 1)
    assert.equal(first.missing, 0)
    assert.equal(first.restored, 0)
    const tracked = lifecycleDatabase.getUserFileByPath('docs/old.md')
    assert.equal(tracked.missingAt, null)

    await rm(filePath)
    const second = scanWorkspaceUserFiles({ rootDir: root, database: lifecycleDatabase })
    assert.equal(second.missing, 1)
    const missing = lifecycleDatabase.getUserFileByPath('docs/old.md')
    assert.ok(missing, 'the row survives the deleted file')
    assert.ok(missing.missingAt)
    assert.ok(
      lifecycleDatabase.getUserFileDetail(tracked.id).activity
        .some((event) => event.action === 'missing')
    )

    await writeFile(filePath, '# Objective: Kept for history.\n')
    const third = scanWorkspaceUserFiles({ rootDir: root, database: lifecycleDatabase })
    assert.equal(third.restored, 1)
    const restored = lifecycleDatabase.getUserFileByPath('docs/old.md')
    assert.equal(restored.missingAt, null)
    const activity = lifecycleDatabase.getUserFileDetail(tracked.id).activity
    assert.ok(activity.some((event) => event.action === 'restored'))
    assert.ok(activity.some((event) => event.action === 'created'), 'history is preserved')
  } finally {
    lifecycleDatabase.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('header syncs from the repository reach tracked fields', async () => {
  const searchResponse = await fetch(`${baseUrl}/api/files?search=tracking_status`)
  assert.equal(searchResponse.status, 200)
  const [reporter] = (await searchResponse.json())
    .filter((file) => file.path.endsWith('tracking_status.py'))
  assert.ok(reporter, 'scripts/tracking_status.py is tracked')
  assert.equal(reporter.objective, 'Report centralized tracking counts for the workspace.')
  assert.equal(
    reporter.requirements,
    'Read tracking tables without modifying them.'
  )

  const detailResponse = await fetch(`${baseUrl}/api/files/${reporter.id}`)
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.ok(detail.activity.some((event) => event.action === 'created'))
  const syncedObjective = detail.activity.find(
    (event) => event.action === 'synced' && event.field === 'objective'
  )
  assert.ok(syncedObjective, 'the objective sync is recorded')
  assert.equal(syncedObjective.oldValue, '')
  assert.equal(syncedObjective.newValue, 'Report centralized tracking counts for the workspace.')
})

test('rescanning unchanged files writes nothing', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/files/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.equal(scanned.inserted, 0)
  assert.equal(scanned.synced, 0)
  assert.equal(scanned.refreshed, 0)
  assert.equal(scanned.skipped, scanned.total)
})

test('manual edits survive rescans until the file changes', () => {
  database.scanUserFiles([
    { path: 'docs/guide.md', content: '# Objective: Original\n\nGuide body.\n' }
  ])
  const file = database.getUserFileByPath('docs/guide.md')
  assert.equal(file.objective, 'Original')

  database.updateUserFile(file.id, { objective: 'Manually curated' })
  assert.equal(database.getUserFileByPath('docs/guide.md').objective, 'Manually curated')

  const unchanged = database.scanUserFiles([
    { path: 'docs/guide.md', content: '# Objective: Original\n\nGuide body.\n' }
  ])
  assert.equal(unchanged.skipped, 1)
  assert.equal(database.getUserFileByPath('docs/guide.md').objective, 'Manually curated')

  const changed = database.scanUserFiles([
    { path: 'docs/guide.md', content: '# Objective: Revised\n\nGuide body.\n' }
  ])
  assert.equal(changed.synced, 1)
  assert.equal(database.getUserFileByPath('docs/guide.md').objective, 'Revised')

  const objectiveEvents = database.getUserFileDetail(file.id).activity
    .filter((event) => event.field === 'objective')
  assert.equal(objectiveEvents.length, 3)
  assert.equal(objectiveEvents[0].action, 'synced')
  assert.equal(objectiveEvents[0].oldValue, 'Manually curated')
  assert.equal(objectiveEvents[0].newValue, 'Revised')
})

test('scans only write header fields that changed', () => {
  database.scanUserFiles([
    {
      path: 'src/tool.mjs',
      content: '#!/usr/bin/env node\n// Objective: JS tool\n// Decisions: Keep it small\nimport fs from "node:fs"\n'
    }
  ])
  const file = database.getUserFileByPath('src/tool.mjs')
  assert.equal(file.objective, 'JS tool')
  assert.equal(file.decisions, 'Keep it small')

  const codeEdit = database.scanUserFiles([
    {
      path: 'src/tool.mjs',
      content: '#!/usr/bin/env node\n// Objective: JS tool\n// Decisions: Keep it small\nimport path from "node:path"\n'
    }
  ])
  assert.equal(codeEdit.refreshed, 1)
  assert.equal(
    database.getUserFileDetail(file.id).activity
      .filter((event) => event.action === 'synced').length,
    2
  )

  const headerEdit = database.scanUserFiles([
    {
      path: 'src/tool.mjs',
      content: '#!/usr/bin/env node\n// Objective: Bigger tool\n// Decisions: Keep it small\nimport path from "node:path"\n'
    }
  ])
  assert.equal(headerEdit.synced, 1)
  const latest = database.getUserFileDetail(file.id).activity[0]
  assert.equal(latest.action, 'synced')
  assert.equal(latest.field, 'objective')
  assert.equal(latest.oldValue, 'JS tool')
  assert.equal(latest.newValue, 'Bigger tool')

  database.scanUserFiles([
    {
      path: 'src/fixture.test.js',
      content: 'import assert from "node:assert"\nconst fixture = "# Objective: fixture value"\n'
    }
  ])
  assert.equal(database.getUserFileByPath('src/fixture.test.js').objective, '')
})

test('manual file updates record field events', () => {
  const file = database.createUserFile({ path: 'docs/manual.md', objective: 'Manual objective' })
  database.updateUserFile(file.id, { decisions: 'Record every change' })
  const activity = database.getUserFileDetail(file.id).activity
  assert.equal(activity[0].action, 'updated')
  assert.equal(activity[0].field, 'decisions')
  assert.equal(activity[0].oldValue, '')
  assert.equal(activity[0].newValue, 'Record every change')
  assert.equal(activity[1].action, 'created')
})

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
  directory = await mkdtemp(join(tmpdir(), 'workspace-tracking-'))
  database = createDatabase(join(directory, 'tracking.sqlite'))
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

test('folders can be scanned, created, updated, and deleted', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/folders/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.ok(Array.isArray(scanned.paths))
  assert.ok(scanned.paths.length > 0)
  assert.equal(scanned.total, scanned.paths.length)
  assert.equal(scanned.inserted, scanned.paths.length)
  assert.equal(scanned.updated, 0)
  for (const path of scanned.paths) {
    assert.ok(!path.includes('node_modules'), `unexpected vendor path: ${path}`)
    assert.ok(!/(^|\/)\.git(\/|$)/.test(path), `unexpected git path: ${path}`)
  }

  const rescanResponse = await fetch(`${baseUrl}/api/folders/scan`, { method: 'POST' })
  assert.equal(rescanResponse.status, 200)
  const rescanned = await rescanResponse.json()
  assert.equal(rescanned.inserted, 0)
  assert.equal(rescanned.updated, rescanned.total)
  assert.equal(rescanned.total, scanned.total)

  const createResponse = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tracking-test-folder', objective: 'Exercise folder tracking' })
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.equal(created.path, 'tracking-test-folder')
  assert.equal(created.objective, 'Exercise folder tracking')
  assert.ok(created.createdAt)

  const duplicateResponse = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tracking-test-folder' })
  })
  assert.equal(duplicateResponse.status, 409)

  const getResponse = await fetch(`${baseUrl}/api/folders/${created.id}`)
  assert.equal(getResponse.status, 200)
  assert.equal((await getResponse.json()).id, created.id)

  const missingResponse = await fetch(`${baseUrl}/api/folders/999999`)
  assert.equal(missingResponse.status, 404)

  const invalidResponse = await fetch(`${baseUrl}/api/folders/not-a-number`)
  assert.equal(invalidResponse.status, 400)
  assert.equal((await invalidResponse.json()).error, 'Folder ID must be a positive integer.')

  const listResponse = await fetch(`${baseUrl}/api/folders`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.ok(listed.some((folder) => folder.path === 'tracking-test-folder'))
  assert.ok(listed.length >= scanned.total)

  const updateResponse = await fetch(`${baseUrl}/api/folders/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objective: 'Updated objective' })
  })
  assert.equal(updateResponse.status, 200)
  const updated = await updateResponse.json()
  assert.equal(updated.objective, 'Updated objective')
  assert.equal(updated.path, 'tracking-test-folder')

  const missingUpdateResponse = await fetch(`${baseUrl}/api/folders/999999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objective: 'Nothing to update' })
  })
  assert.equal(missingUpdateResponse.status, 404)

  const deleteResponse = await fetch(`${baseUrl}/api/folders/${created.id}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 204)

  const deleteAgainResponse = await fetch(`${baseUrl}/api/folders/${created.id}`, { method: 'DELETE' })
  assert.equal(deleteAgainResponse.status, 404)
})

test('folder input is validated', async () => {
  const cases = [
    [{ objective: 'Missing path' }, 'Path must be a non-empty string.'],
    [{ path: '   ' }, 'Path must be a non-empty string.'],
    [{ path: `a/${'x'.repeat(500)}` }, 'Path must be at most 500 characters.'],
    [{ path: 'valid', unexpected: 'nope' }, 'Request includes an unsupported folder field.'],
    [{ path: 'valid', objective: 42 }, 'Objective must be a string.'],
    [{ path: 'valid', objective: 'x'.repeat(2001) }, 'Objective must be at most 2000 characters.']
  ]
  for (const [body, error] of cases) {
    const response = await fetch(`${baseUrl}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, error)
  }

  const partialResponse = await fetch(`${baseUrl}/api/folders/999999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(partialResponse.status, 400)
  assert.equal((await partialResponse.json()).error, 'Provide at least one field to update.')
})

test('git worktrees can be scanned and listed without duplicates', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/git-worktrees/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.ok(Array.isArray(scanned.entries))
  assert.ok(scanned.entries.length >= 1)
  assert.equal(scanned.total, scanned.entries.length)
  for (const entry of scanned.entries) {
    assert.equal(typeof entry.worktreePath, 'string')
    assert.ok(entry.worktreePath.length > 0)
    assert.equal(typeof entry.repositoryRoot, 'string')
    assert.equal(typeof entry.remoteUrl, 'string')
  }

  const listResponse = await fetch(`${baseUrl}/api/git-worktrees`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.equal(listed.length, scanned.entries.length)
  const scannedPaths = new Set(scanned.entries.map((entry) => entry.worktreePath))
  for (const worktree of listed) {
    assert.ok(scannedPaths.has(worktree.worktreePath))
    assert.equal(typeof worktree.branch, 'string')
    assert.equal(typeof worktree.headCommit, 'string')
  }

  const rescanResponse = await fetch(`${baseUrl}/api/git-worktrees/scan`, { method: 'POST' })
  assert.equal(rescanResponse.status, 200)
  const relistResponse = await fetch(`${baseUrl}/api/git-worktrees`)
  const relisted = await relistResponse.json()
  assert.equal(relisted.length, scanned.entries.length)
})

test('tools can be scanned and accumulate outcome counters', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/tools/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.equal(scanned.total, 9)
  assert.deepEqual(
    scanned.entries.map((entry) => entry.name).sort(),
    ['agy', 'colab', 'git', 'kaggle', 'node', 'npm', 'opencode', 'python', 'uv']
  )
  for (const entry of scanned.entries) {
    assert.equal(typeof entry.command, 'string')
    assert.equal(typeof entry.version, 'string')
    assert.equal(typeof entry.available, 'boolean')
  }

  const listResponse = await fetch(`${baseUrl}/api/tools`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.equal(listed.length, 9)
  const byName = new Map(listed.map((tool) => [tool.name, tool]))
  assert.equal(byName.get('node').available, true)
  assert.equal(byName.get('git').available, true)
  assert.ok(byName.get('git').version.length > 0)
  assert.equal(byName.get('git').successCount, 1)
  assert.equal(byName.get('git').failureCount, 0)

  const rescanResponse = await fetch(`${baseUrl}/api/tools/scan`, { method: 'POST' })
  assert.equal(rescanResponse.status, 200)
  const relistResponse = await fetch(`${baseUrl}/api/tools`)
  const recounted = await relistResponse.json()
  for (const tool of recounted) {
    assert.equal(tool.successCount > 0, tool.available, `success counter mismatch for ${tool.name}`)
    assert.equal(tool.failureCount > 0, !tool.available, `failure counter mismatch for ${tool.name}`)
  }
  assert.equal(new Map(recounted.map((tool) => [tool.name, tool])).get('git').successCount, 2)
})

test('environments can be scanned and refreshed without duplicates', async () => {
  const scanResponse = await fetch(`${baseUrl}/api/environments/scan`, { method: 'POST' })
  assert.equal(scanResponse.status, 200)
  const scanned = await scanResponse.json()
  assert.equal(scanned.total, 4)
  assert.deepEqual(
    scanned.entries.map((entry) => entry.name).sort(),
    ['architecture', 'cwd', 'node', 'os']
  )

  const listResponse = await fetch(`${baseUrl}/api/environments`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.equal(listed.length, 4)
  const byName = new Map(listed.map((fact) => [fact.name, fact]))
  assert.equal(byName.get('os').value, process.platform)
  assert.equal(byName.get('architecture').value, process.arch)
  assert.equal(byName.get('node').value, process.version)
  assert.equal(byName.get('cwd').value, process.cwd())
  for (const fact of listed) {
    assert.equal(typeof fact.source, 'string')
    assert.equal(typeof fact.checkedAt, 'string')
  }

  const rescanResponse = await fetch(`${baseUrl}/api/environments/scan`, { method: 'POST' })
  assert.equal(rescanResponse.status, 200)
  const relistResponse = await fetch(`${baseUrl}/api/environments`)
  assert.equal((await relistResponse.json()).length, 4)
})

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
      next_move: 'Review it'
    })
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.equal(created.path, 'docs/example.md')
  assert.equal(created.objective, 'Track documentation')
  assert.equal(created.next_move, 'Review it')

  const duplicateResponse = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/example.md' })
  })
  assert.equal(duplicateResponse.status, 409)

  const updateResponse = await fetch(`${baseUrl}/api/files/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ work_completed: 'Metadata added' })
  })
  assert.equal(updateResponse.status, 200)
  assert.equal((await updateResponse.json()).work_completed, 'Metadata added')

  const listResponse = await fetch(`${baseUrl}/api/files`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.ok(listed.some((file) => file.path === 'docs/example.md'))

  const deleteResponse = await fetch(`${baseUrl}/api/files/${created.id}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 204)
})

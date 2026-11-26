import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { createSwarmLiveRouter } from '../src/routes/swarmLive.js'

let directory
let stateRoot
let emptyRoot
let database
let server
let baseUrl
let originalStateDir

function snapshotTree(root, relative = '', out = {}) {
  return readdir(join(root, relative), { withFileTypes: true }).then(async (entries) => {
    for (const entry of entries) {
      const rel = join(relative, entry.name)
      if (entry.isDirectory()) {
        await snapshotTree(root, rel, out)
      } else if (entry.isFile()) {
        const info = await stat(join(root, rel))
        out[rel] = `${info.size}:${info.mtimeMs}`
      }
    }
    return out
  })
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`)
  return { status: response.status, body: await response.json() }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-swarm-live-'))
  stateRoot = join(directory, 'state')
  emptyRoot = join(directory, 'empty')
  for (const dir of [
    join(stateRoot, 'relay'),
    join(stateRoot, 'overnight'),
    join(stateRoot, 'repo-checkpoints'),
    emptyRoot
  ]) {
    await mkdir(dir, { recursive: true })
  }

  await writeFile(
    join(stateRoot, 'relay', 'ring-state.json'),
    JSON.stringify({
      schema: 'ring-state/v1',
      runId: 'run-live-test',
      generation: 7,
      round: 3,
      window: 2,
      activeSlot: 'sibling3',
      mode: 'pipeline',
      updatedAt: '2026-11-26T13:00:00.000Z',
      slots: {}
    })
  )
  await writeFile(
    join(stateRoot, 'repo-checkpoints', 'checkpoint-ledger.jsonl'),
    [
      JSON.stringify({ schema: 'checkpoint-telemetry/v1', commitSha: 'aaa', filesCount: 1 }),
      '{not valid json',
      JSON.stringify({ schema: 'checkpoint-telemetry/v1', commitSha: 'bbb', filesCount: 2 }),
      JSON.stringify({ schema: 'checkpoint-telemetry/v1', commitSha: 'ccc', filesCount: 3 })
    ].join('\n') + '\n'
  )
  await writeFile(join(stateRoot, 'overnight', 'STOP_SWARM'), '')

  originalStateDir = process.env.SWARM_STATE_DIR
  process.env.SWARM_STATE_DIR = stateRoot

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
  if (originalStateDir === undefined) delete process.env.SWARM_STATE_DIR
  else process.env.SWARM_STATE_DIR = originalStateDir
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('GET /api/swarm/live is wired into app.js and returns the composed read-only report', async () => {
  const { status, body } = await get('/api/swarm/live')
  assert.equal(status, 200)
  assert.equal(body.schema, 'swarm-live/v1')
  assert.equal(body.readOnly, true)
  assert.equal(body.stateRoot, stateRoot)
  assert.equal(body.health.schema, 'swarm-health-rollup/v1')
  assert.equal(body.health.stateRoot, stateRoot)
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)))

  assert.equal(body.ring?.runId, 'run-live-test')
  assert.equal(body.ring?.generation, 7)
  assert.equal(body.ring?.activeSlot, 'sibling3')

  assert.deepEqual(body.killSwitch, {
    active: true,
    path: join(stateRoot, 'overnight', 'STOP_SWARM')
  })

  assert.equal(body.checkpointLedger.present, true)
  assert.equal(body.checkpointLedger.malformedLinesSkipped, 1)
  assert.equal(body.checkpointLedger.returned, 3)
  assert.deepEqual(
    body.checkpointLedger.rows.map((row) => row.commitSha),
    ['aaa', 'bbb', 'ccc']
  )
})

test('GET /api/swarm/live performs no state mutations', async () => {
  const beforeTree = await snapshotTree(stateRoot)
  await get('/api/swarm/live')
  await get('/api/swarm/live')
  assert.deepEqual(await snapshotTree(stateRoot), beforeTree)
})

test('GET /api/swarm/live honours a changed SWARM_STATE_DIR and degrades on empty state', async () => {
  process.env.SWARM_STATE_DIR = emptyRoot
  try {
    const { status, body } = await get('/api/swarm/live')
    assert.equal(status, 200)
    assert.equal(body.stateRoot, emptyRoot)
    assert.equal(body.health.stateRoot, emptyRoot)
    assert.equal(body.ring, null)
    assert.equal(body.killSwitch.active, false)
    assert.equal(body.checkpointLedger.present, false)
    assert.equal(body.checkpointLedger.returned, 0)
    assert.deepEqual(body.checkpointLedger.rows, [])
  } finally {
    process.env.SWARM_STATE_DIR = stateRoot
  }
})

test('createSwarmLiveRouter injects now and caps the ledger at 50 recent rows', async () => {
  const root = join(directory, 'truncated')
  await mkdir(join(root, 'repo-checkpoints'), { recursive: true })
  const rows = Array.from({ length: 60 }, (_, index) => JSON.stringify({ seq: index }))
  await writeFile(join(root, 'repo-checkpoints', 'checkpoint-ledger.jsonl'), rows.join('\n') + '\n')

  const fixedNow = Date.UTC(2026, 10, 26, 13, 0, 0)
  const app = express()
  app.use(createSwarmLiveRouter({
    env: { SWARM_STATE_DIR: root },
    now: () => fixedNow
  }))
  const localServer = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    localServer.once('listening', resolve)
    localServer.once('error', reject)
  })
  try {
    const response = await fetch(`http://127.0.0.1:${localServer.address().port}/api/swarm/live`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.generatedAt, new Date(fixedNow).toISOString())
    assert.equal(body.health.generatedAt, new Date(fixedNow).toISOString())
    assert.equal(body.checkpointLedger.returned, 50)
    assert.deepEqual(body.checkpointLedger.rows.map((row) => row.seq), Array.from({ length: 50 }, (_, i) => i + 10))
  } finally {
    await new Promise((resolve) => localServer.close(resolve))
  }
})

// Objective: Test OpenCode model discovery, its TTL roster cache, and the roster endpoint.
// Requirements: Cover roster parsing, soft failure, cache TTL and refresh, in-flight dedup, and endpoint wiring.
// Decisions: Inject fake exec and discover functions so tests never run the real opencode CLI.
// Relevant Files: apps/api/test/opencodeDiscovery.test.js, apps/api/src/opencodeDiscovery.js, apps/api/src/app.js
// Important Context: User file. The endpoint test injects a cache with a fake discoverer returning a fixed roster.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import {
  createOpenCodeRosterCache,
  createOpenCodeRosterCacheFromEnv,
  discoverOpenCodeModels
} from '../src/opencodeDiscovery.js'

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-opencode-discovery-'))
  database = createDatabase(join(directory, 'discovery.sqlite'))
  const roster = ['console-nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'console-google/gemini-2.5-flash']
  let discoveryCalls = 0
  server = createApp(database, {
    opencodeRosterCache: createOpenCodeRosterCache({
      discover: async () => {
        discoveryCalls += 1
        return { ok: true, models: roster, error: null }
      }
    })
  }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  server.discoveryState = { calls: () => discoveryCalls }
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('discovery parses, dedupes, and sorts the roster', async () => {
  const execFileImpl = (command, args, options, callback) => {
    assert.equal(command, 'opencode')
    assert.deepEqual(args, ['models'])
    assert.equal(options.timeout, 15000)
    callback(null, 'console-b/b2\nconsole-a/a1\nconsole-b/b2\n\n  console-a/a0  \n')
  }
  const result = await discoverOpenCodeModels({ execFileImpl })
  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['console-a/a0', 'console-a/a1', 'console-b/b2'])
  assert.equal(result.error, null)
})

test('discovery reports CLI failures without throwing', async () => {
  const execFileImpl = (_command, _args, _options, callback) => {
    callback(new Error('spawn opencode ENOENT'))
  }
  const result = await discoverOpenCodeModels({ execFileImpl })
  assert.equal(result.ok, false)
  assert.deepEqual(result.models, [])
  assert.match(result.error, /ENOENT/)
})

test('the roster cache serves fresh results and forces refresh past the TTL', async () => {
  let calls = 0
  const discover = async () => {
    calls += 1
    return { ok: true, models: [`model-${calls}`], error: null }
  }
  let clock = 1000
  const cache = createOpenCodeRosterCache({ discover, now: () => clock })

  const first = await cache.get()
  assert.deepEqual(first.models, ['model-1'])
  assert.equal(first.fetchedAt, 1000)

  const cached = await cache.get()
  assert.equal(cached, first)

  clock += 500
  assert.equal((await cache.get()), first)

  clock += 600000
  const second = await cache.get()
  assert.deepEqual(second.models, ['model-2'])

  const forced = await cache.get({ refresh: true })
  assert.deepEqual(forced.models, ['model-3'])
})

test('the roster cache shares one in-flight discovery and caches failures', async () => {
  let resolveDiscovery
  const discover = () => new Promise((resolve) => { resolveDiscovery = resolve })
  const cache = createOpenCodeRosterCache({ discover })
  const firstCall = cache.get()
  const secondCall = cache.get()
  assert.equal(firstCall, secondCall)
  resolveDiscovery({ ok: false, models: [], error: 'timed out' })
  const failure = await firstCall
  assert.equal(failure.ok, false)
  assert.match(failure.error, /timed out/)

  const cachedFailure = await cache.get()
  assert.equal(cachedFailure, failure)
})

test('the roster cache reads its bounds from the environment', () => {
  const cache = createOpenCodeRosterCacheFromEnv({
    OPENCODE_AI_DISCOVERY_TIMEOUT_MS: '25000',
    OPENCODE_AI_DISCOVERY_TTL_MS: '120000'
  })
  assert.equal(typeof cache.get, 'function')
  assert.throws(() => createOpenCodeRosterCacheFromEnv({
    OPENCODE_AI_DISCOVERY_TIMEOUT_MS: '-1'
  }), /non-negative/)
})

test('the opencode roster endpoint reports the effective model and live roster', async () => {
  const response = await fetch(`${baseUrl}/api/models/opencode`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(typeof body.model, 'string')
  assert.ok(body.model.length > 0)
  assert.equal(body.inRoster, body.availableModels.includes(body.model))
  assert.ok(body.availableModels.includes('console-google/gemini-2.5-flash'))
  assert.equal(body.count, 2)
  assert.equal(typeof body.fetchedAt, 'number')
  const callsAfterFirst = server.discoveryState.calls()

  const cachedResponse = await fetch(`${baseUrl}/api/models/opencode`)
  const cachedBody = await cachedResponse.json()
  assert.equal(server.discoveryState.calls(), callsAfterFirst)
  assert.equal(cachedBody.fetchedAt, body.fetchedAt)

  const refreshResponse = await fetch(`${baseUrl}/api/models/opencode?refresh=1`)
  const refreshedBody = await refreshResponse.json()
  assert.equal(server.discoveryState.calls(), callsAfterFirst + 1)
  assert.ok(refreshedBody.fetchedAt >= body.fetchedAt)
})

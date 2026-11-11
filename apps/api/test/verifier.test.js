// Objective: Test the allowlisted local verifier module and its API endpoints.
// Requirements: Cover allowlist rejection, timeout, pass/fail parsing, and endpoint wiring.
// Decisions: Inject fast custom checks into createApp so endpoint tests never spawn the real suites.
// Relevant Files: apps/api/test/verifier.test.js, apps/api/src/localVerifier.js, apps/api/src/app.js
// Important Context: User file. Custom checks use node -e fixtures for deterministic pass, fail, timeout, and error states.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { createLocalVerifier } from '../src/localVerifier.js'

const CHECKS = [
  {
    id: 'passing',
    title: 'Passing check',
    command: 'node',
    args: ['-e', 'console.log("pass stdout"); process.exit(0)'],
    timeoutMs: 15000
  },
  {
    id: 'failing',
    title: 'Failing check',
    command: 'node',
    args: ['-e', 'console.error("fail stderr"); process.exit(3)'],
    timeoutMs: 15000
  },
  {
    id: 'hanging',
    title: 'Hanging check',
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 400
  }
]

let directory
let database
let server
let baseUrl

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-verifier-'))
  database = createDatabase(join(directory, 'verifier.sqlite'))
  server = createApp(database, {
    verifier: createLocalVerifier({ rootDir: directory, checks: CHECKS })
  }).listen(0, '127.0.0.1')
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

test('the verifier allowlist rejects unknown check ids', async () => {
  const verifier = createLocalVerifier({ rootDir: directory, checks: CHECKS })
  await assert.rejects(verifier.runChecks(['format-disk']), /Unknown check/)
  await assert.rejects(verifier.runChecks('lint'), /array of check ids/)
})

test('checks pass, fail, and time out with structured results', async () => {
  const verifier = createLocalVerifier({ rootDir: directory, checks: CHECKS })
  const { passed, results } = await verifier.runChecks()
  assert.equal(results.length, 3)

  assert.equal(results[0].id, 'passing')
  assert.equal(results[0].state, 'pass')
  assert.equal(results[0].exitCode, 0)
  assert.ok(results[0].output.includes('pass stdout'))

  assert.equal(results[1].id, 'failing')
  assert.equal(results[1].state, 'fail')
  assert.equal(results[1].exitCode, 3)
  assert.ok(results[1].output.includes('fail stderr'))

  assert.equal(results[2].id, 'hanging')
  assert.equal(results[2].state, 'timeout')
  assert.equal(results[2].signal, 'SIGKILL')
  assert.ok(results[2].durationMs < 5000, `timeout took too long: ${results[2].durationMs}ms`)
  assert.equal(passed, false)
})

test('a subset runs only the requested checks in order', async () => {
  const verifier = createLocalVerifier({ rootDir: directory, checks: CHECKS })
  const { results } = await verifier.runChecks(['failing', 'passing'])
  assert.deepEqual(results.map((result) => result.id), ['failing', 'passing'])
})

test('missing commands report an error state instead of throwing', async () => {
  const verifier = createLocalVerifier({
    rootDir: directory,
    checks: [
      {
        id: 'missing',
        title: 'Missing command',
        command: 'not-a-real-command-for-tests',
        args: [],
        timeoutMs: 5000
      }
    ]
  })
  const { passed, results } = await verifier.runChecks()
  assert.equal(results[0].state, 'error')
  assert.ok(results[0].error)
  assert.equal(passed, false)
})

test('the verify endpoints list checks and run a requested subset', async () => {
  const listResponse = await fetch(`${baseUrl}/api/verify`)
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json()
  assert.deepEqual(listed.checks.map((check) => check.id), ['passing', 'failing', 'hanging'])
  assert.equal(listed.checks[0].timeoutMs, 15000)

  const runResponse = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checks: ['passing'] })
  })
  assert.equal(runResponse.status, 200)
  const run = await runResponse.json()
  assert.equal(run.passed, true)
  assert.equal(run.results.length, 1)
  assert.equal(run.results[0].state, 'pass')

  const malformedResponse = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checks: 'lint' })
  })
  assert.equal(malformedResponse.status, 400)

  const unknownResponse = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checks: ['rm', '-rf'] })
  })
  assert.equal(unknownResponse.status, 400)
})

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase } from '../src/database.js'
import {
  resolveScript,
  scoreScriptIntent,
  validateScriptInput
} from '../src/agentScripts.js'

let directory
let artifactDirectory
let database
let clock

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-agent-scripts-'))
  artifactDirectory = join(directory, 'artifacts')
  database = createDatabase(join(directory, 'scripts.sqlite'), { artifactDir: artifactDirectory })
  clock = Date.parse('2026-02-01T00:00:00.000Z')
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

const SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: { path: { type: 'string' } }
}

function register(overrides = {}) {
  return database.registerAgentScript({
    name: 'list-markdown-files',
    intent: 'list markdown files in a folder',
    command: 'find {{path}} -name "*.md" -type f',
    inputSchema: SCHEMA,
    outputSchema: { type: 'array' },
    timeoutMs: 5000,
    costClass: 'free',
    ...overrides
  })
}

test('the resolver prefers verified scripts and reports missing inputs', () => {
  const verified = {
    id: 'scr_1',
    name: 'verified',
    intent: 'list markdown files in a folder',
    version: 2,
    verifiedAt: 1,
    inputSchema: SCHEMA
  }
  const unverified = {
    id: 'scr_2',
    name: 'unverified',
    intent: 'list markdown files in a folder',
    version: 9,
    inputSchema: SCHEMA
  }

  const resolved = resolveScript([unverified, verified], {
    intent: 'list all markdown files inside a folder',
    input: { path: 'docs' }
  })
  assert.equal(resolved.decision, 'script')
  assert.equal(resolved.script.id, 'scr_1')
  assert.equal(resolved.verified, true)

  const missing = resolveScript([verified], { intent: 'list markdown files in a folder', input: {} })
  assert.equal(missing.decision, 'needs_input')
  assert.deepEqual(missing.missingInputs, ['path'])

  const fallback = resolveScript([verified], { intent: 'summarize the last release notes' })
  assert.equal(fallback.decision, 'model')

  const blank = resolveScript([verified], { intent: '' })
  assert.equal(blank.error.status, 400)

  assert.equal(scoreScriptIntent('a', 'b'), 0)
  assert.equal(scoreScriptIntent('list markdown files', 'list markdown files'), 1)
})

test('registration is idempotent, versioned, and clears verification on change', () => {
  const created = register()
  assert.equal(created.version, 1)
  assert.equal(created.verifiedAt, undefined)

  const same = register()
  assert.equal(same.id, created.id)
  assert.equal(same.version, 1)

  const verified = database.markAgentScriptVerified(created.id, clock)
  assert.equal(verified.verifiedAt, clock)

  const changed = register({ command: 'find {{path}} -iname "*.md"' })
  assert.equal(changed.id, created.id)
  assert.equal(changed.version, 2)
  assert.equal(changed.verifiedAt, undefined)

  assert.equal(database.getAgentScript(created.id).command, 'find {{path}} -iname "*.md"')
  assert.equal(database.getAgentScriptByName('list-markdown-files').id, created.id)
  assert.equal(database.getAgentScript('scr_missing'), null)
  assert.equal(database.listAgentScripts({ verifiedOnly: true }).length, 0)
  assert.equal(database.listAgentScripts({ intent: 'markdown' }).length, 1)
})

test('registration validation rejects unsafe names and empty commands', () => {
  assert.match(validateScriptInput({ name: 'Bad Name' }).error, /name/)
  assert.match(validateScriptInput({ name: 'ok', intent: 'x', command: '  ' }).error, /command/)
  assert.match(
    validateScriptInput({ name: 'ok', intent: 'x', command: 'ls', timeout_ms: 10 }).error,
    /timeout/
  )
  assert.match(
    validateScriptInput({ name: 'ok', intent: 'x', command: 'ls', cost_class: 'premium' }).error,
    /cost class/
  )
  assert.equal(validateScriptInput({ name: 'ok', intent: 'x', command: 'ls' }).timeoutMs, 60000)
})

test('resolving through the store matches a registered script', () => {
  const resolved = database.resolveAgentScript({
    intent: 'list markdown files in a folder',
    input: { path: 'apps' }
  })
  assert.equal(resolved.decision, 'script')
  assert.equal(resolved.script.name, 'list-markdown-files')
  assert.equal(resolved.input.path, 'apps')

  const missing = database.resolveAgentScript({ intent: 'list markdown files in a folder' })
  assert.equal(missing.decision, 'needs_input')
  assert.deepEqual(missing.missingInputs, ['path'])
})

test('artifacts are deduplicated by content and pruned when expired', () => {
  const first = database.saveAgentArtifact({
    kind: 'summary',
    producer: 'worker-a',
    content: '{"files":["README.md"]}'
  })
  const second = database.saveAgentArtifact({
    kind: 'summary',
    producer: 'worker-b',
    content: '{"files":["README.md"]}'
  })
  assert.equal(first.contentHash, second.contentHash)
  assert.equal(first.bytes, Buffer.byteLength('{"files":["README.md"]}'))
  assert.equal(first.producer, 'worker-a')

  const stored = database.getAgentArtifact(first.contentHash, { includeContent: true })
  assert.equal(stored.content, '{"files":["README.md"]}')
  assert.ok(existsSync(join(artifactDirectory, first.contentHash)))

  const other = database.saveAgentArtifact({
    kind: 'summary',
    content: '{"files":["package.json"]}'
  })
  assert.notEqual(other.contentHash, first.contentHash)

  const expiring = database.saveAgentArtifact({
    kind: 'summary',
    content: '{"files":["temporary.md"]}',
    expiresAt: clock - 1
  })
  assert.ok(database.getAgentArtifact(expiring.contentHash))
  assert.equal(database.pruneAgentArtifacts(clock), 1)
  assert.equal(database.getAgentArtifact(expiring.contentHash), null)
  assert.equal(existsSync(join(artifactDirectory, expiring.contentHash)), false)
  assert.ok(database.getAgentArtifact(first.contentHash))
})

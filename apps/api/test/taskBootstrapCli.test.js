import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDatabase } from '../src/database.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = join(ROOT, 'scripts', 'task-bootstrap-register-current.mjs')

function fixture({ generation = 7, currentLeaseId = 'stale-pointer', activeLease = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-bootstrap-current-cli-'))
  const databasePath = join(directory, 'workspace.sqlite')
  const db = createDatabase(databasePath)
  db.db.prepare(
    'INSERT INTO project_writer_lease_state(project_id,fencing_generation,current_lease_id,updated_at) VALUES(?,?,?,?)'
  ).run('curl-ai-bridge', generation, currentLeaseId, new Date(0).toISOString())
  if (activeLease) {
    const now = new Date().toISOString()
    const sql = 'INSERT INTO project_writer_leases (lease_id,project_id,task_id,run_id,worker_id,owner_id,repositories_json,allowlist_json,allowlist_sha256,binding_sha256,authorization_ref,fencing_generation,acquired_at,heartbeat_at,expires_at,status,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    db.db.prepare(sql).run(
      'active-lease', 'curl-ai-bridge', 1, 'active-run', 'worker', 'owner',
      '[]', '{"files":[],"mutations":[]}', 'a'.repeat(64), 'b'.repeat(64),
      'provenance-only', generation, now, now,
      new Date(Date.now() + 60000).toISOString(), 'active', 'active-lease-key'
    )
  }
  db.close()
  return {
    databasePath,
    close() { rmSync(directory, { recursive: true, force: true }) }
  }
}

function run(f, command, task, extra = []) {
  return spawnSync(process.execPath, [CLI, command, '--database', f.databasePath, ...extra], {
    input: task === undefined ? undefined : JSON.stringify(task),
    encoding: 'utf8'
  })
}

const task = (overrides = {}) => ({
  project: 'curl-ai-bridge',
  title: 'Current-generation registration test',
  description: 'CLI integration test',
  priority: 'medium',
  task_type: 'feature',
  acceptance_criteria: 'Registration is idempotent and blocked by default.',
  ...overrides
})

test('status reads generation and current lease pointer without migration or mutation', () => {
  const f = fixture()
  try {
    const result = run(f, 'status')
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.projectId, 'curl-ai-bridge')
    assert.equal(output.fencingGeneration, 7)
    assert.equal(output.currentLeaseId, 'stale-pointer')
    assert.equal(output.currentLease, null)
  } finally { f.close() }
})

test('register exposes the current-generation helper and forces blocked status', () => {
  const f = fixture()
  try {
    const result = run(f, 'register', task(), [
      '--expected-generation', '7',
      '--authorization-ref', 'operator-chat-provenance:phase-2-test',
      '--idempotency-key', 'current-generation-cli-test'
    ])
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.replayed, false)
    assert.equal(output.status, 'blocked')
    assert.equal(output.completed, 0)
    assert.equal(output.fencingGeneration, 7)
    assert.equal(output.currentLeaseId, null)

    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try {
      const state = read.prepare("SELECT fencing_generation,current_lease_id FROM project_writer_lease_state WHERE project_id='curl-ai-bridge'").get()
      assert.equal(state.fencing_generation, 7)
      assert.equal(state.current_lease_id, 'stale-pointer')
      const stored = read.prepare('SELECT status,completed,project FROM tasks WHERE id=?').get(output.taskId)
      assert.deepEqual(stored, { status: 'blocked', completed: 0, project: 'curl-ai-bridge' })
      assert.equal(read.prepare('SELECT count(*) AS count FROM project_writer_bootstrap_events').get().count, 1)
      assert.equal(read.prepare('SELECT count(*) AS count FROM task_events WHERE task_id=?').get(output.taskId).count, 1)
      assert.equal(read.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally { read.close() }
  } finally { f.close() }
})

test('idempotent replay returns the same task without consuming another ID or generation', () => {
  const f = fixture()
  try {
    const args = [
      '--expected-generation', '7',
      '--authorization-ref', 'operator-chat-provenance:phase-2-test',
      '--idempotency-key', 'current-generation-replay'
    ]
    const first = run(f, 'register', task(), args)
    assert.equal(first.status, 0, first.stderr)
    const firstResult = JSON.parse(first.stdout)
    const replay = run(f, 'register', task({ title: 'Changed retry payload' }), args)
    assert.equal(replay.status, 0, replay.stderr)
    const replayResult = JSON.parse(replay.stdout)
    assert.equal(replayResult.replayed, true)
    assert.equal(replayResult.taskId, firstResult.taskId)

    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(read.prepare('SELECT count(*) AS count FROM tasks').get().count, 1)
      assert.equal(read.prepare("SELECT fencing_generation FROM project_writer_lease_state WHERE project_id='curl-ai-bridge'").get().fencing_generation, 7)
      assert.equal(read.prepare('SELECT count(*) AS count FROM project_writer_bootstrap_events').get().count, 1)
    } finally { read.close() }
  } finally { f.close() }
})

test('stale generation fails closed without creating a task', () => {
  const f = fixture()
  try {
    const result = run(f, 'register', task(), [
      '--expected-generation', '6',
      '--authorization-ref', 'operator-chat-provenance:stale-test',
      '--idempotency-key', 'stale-generation-test'
    ])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /task_bootstrap_generation_mismatch/)
    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try { assert.equal(read.prepare('SELECT count(*) AS count FROM tasks').get().count, 0) }
    finally { read.close() }
  } finally { f.close() }
})

test('wrong project is rejected before registration', () => {
  const f = fixture()
  try {
    const result = run(f, 'register', task({ project: 'another-project' }), [
      '--expected-generation', '7',
      '--authorization-ref', 'operator-chat-provenance:wrong-project',
      '--idempotency-key', 'wrong-project-test'
    ])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /task_bootstrap_wrong_project/)
  } finally { f.close() }
})

test('active writer lease blocks a new registration', () => {
  const f = fixture({ activeLease: true })
  try {
    const result = run(f, 'register', task(), [
      '--expected-generation', '7',
      '--authorization-ref', 'operator-chat-provenance:active-lease',
      '--idempotency-key', 'active-lease-test'
    ])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /task_bootstrap_active_lease_exists/)
  } finally { f.close() }
})

test('invalid input and missing database fail closed', () => {
  const f = fixture()
  try {
    const invalid = spawnSync(process.execPath, [CLI, 'register', '--database', f.databasePath,
      '--expected-generation', '7', '--authorization-ref', 'ref', '--idempotency-key', 'invalid-json'],
    { input: '{bad json', encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /JSON|Unexpected/)
    const missingPath = join(f.databasePath, '..', 'missing.sqlite')
    const missing = spawnSync(process.execPath, [CLI, 'status', '--database', missingPath], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /database_missing_or_symlink/)
  } finally { f.close() }
})

// --- #217 multi-project resolution ----------------------------------------------

function multiProjectFixture({ generation = 9 } = {}) {
  // Both projects must share the generation the test passes via --expected-generation,
  // otherwise the second registration correctly fails closed with a generation mismatch.
  const f = fixture({ generation })
  const db = createDatabase(f.databasePath)
  try {
    db.db.prepare(
      'INSERT INTO project_writer_lease_state(project_id,fencing_generation,current_lease_id,updated_at) VALUES(?,?,?,?)'
    ).run('multi-project-workspace', generation, null, new Date(0).toISOString())
  } finally { db.close() }
  return { ...f, generation }
}

test('#217 default resolution still lands on curl-ai-bridge when nothing is specified', () => {
  const f = fixture()
  try {
    const result = run(f, 'status')
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    // The git-root directory name is not a registered project in this fixture DB, so the
    // legacy default must win rather than failing closed.
    assert.equal(output.projectId, 'curl-ai-bridge')
  } finally { f.close() }
})

test('#217 explicit --project registers a governed task under that project', () => {
  const f = multiProjectFixture({ generation: 9 })
  try {
    const result = run(f, 'register', task({ project: 'multi-project-workspace', title: 'Repo-1 governed task' }), [
      '--project', 'multi-project-workspace',
      '--expected-generation', '9',
      '--authorization-ref', 'operator-chat-provenance:multi-project-test',
      '--idempotency-key', 'multi-project-cli-test'
    ])
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.projectId, 'multi-project-workspace')
    assert.equal(output.governed, true)
    assert.equal(output.registeredBy, 'task-bootstrap-register-current')

    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try {
      const stored = read.prepare('SELECT project,registered_by,governed FROM tasks WHERE id=?').get(output.taskId)
      assert.deepEqual(stored, { project: 'multi-project-workspace', registered_by: 'task-bootstrap-register-current', governed: 1 })
      assert.equal(read.prepare("SELECT fencing_generation FROM project_writer_lease_state WHERE project_id='multi-project-workspace'").get().fencing_generation, 9)
    } finally { read.close() }
  } finally { f.close() }
})

test('#217 title dedupe is scoped per project, so equal titles in two projects do not collide', () => {
  const f = multiProjectFixture({ generation: 9 })
  try {
    const argsFor = (key) => [
      '--expected-generation', '9',
      '--authorization-ref', 'operator-chat-provenance:dedupe-test',
      '--idempotency-key', key
    ]
    const payload = { project: 'multi-project-workspace', title: 'Shared title', task_type: 'feature' }
    const first = run(f, 'register', payload, ['--project', 'multi-project-workspace', ...argsFor('dedupe-multi')])
    assert.equal(first.status, 0, first.stderr)
    const otherPayload = { project: 'curl-ai-bridge', title: 'Shared title', task_type: 'feature' }
    const second = run(f, 'register', otherPayload, ['--project', 'curl-ai-bridge', ...argsFor('dedupe-cab')])
    assert.equal(second.status, 0, second.stderr)
    assert.notEqual(JSON.parse(first.stdout).taskId, JSON.parse(second.stdout).taskId)

    // Same project + same title is deduplicated instead of creating a duplicate.
    const third = run(f, 'register', payload, ['--project', 'multi-project-workspace', ...argsFor('dedupe-multi-2')])
    assert.equal(third.status, 0, third.stderr)
    const thirdOut = JSON.parse(third.stdout)
    assert.equal(thirdOut.replayed, true)
    assert.equal(thirdOut.deduplicatedByTitle, true)
    assert.equal(thirdOut.taskId, JSON.parse(first.stdout).taskId)

    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try { assert.equal(read.prepare('SELECT count(*) AS count FROM tasks').get().count, 2) }
    finally { read.close() }
  } finally { f.close() }
})

test('#217 unregistered project slug fails closed without creating a task', () => {
  const f = fixture()
  try {
    const result = run(f, 'register', task({ project: 'typo-prject' }), [
      '--project', 'typo-prject',
      '--expected-generation', '7',
      '--authorization-ref', 'operator-chat-provenance:unknown-project',
      '--idempotency-key', 'unknown-project-test'
    ])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown_project/)
    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true })
    try { assert.equal(read.prepare('SELECT count(*) AS count FROM tasks').get().count, 0) }
    finally { read.close() }
  } finally { f.close() }
})

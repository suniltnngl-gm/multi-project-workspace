import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDatabase } from '../src/database.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'task-bootstrap-'))
  const db = createDatabase(join(dir, 'workspace.sqlite'))
  db.db.prepare("INSERT INTO project_writer_lease_state(project_id,fencing_generation,current_lease_id,updated_at) VALUES('curl-ai-bridge',9,'retired-lease-id',?)").run(new Date(0).toISOString())
  db.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('tasks',145)").run()
  return { dir, db, close() { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const request = (overrides = {}) => ({
  task: { title: 'Portable Execution Tracking', project: 'curl-ai-bridge', status: 'todo', completed: 1 },
  authorizationRef: 'operator-approval:phase-a',
  idempotencyKey: 'bootstrap-pet-146',
  ...overrides
})

test('atomically creates blocked task, retired generation and immutable event; clears current lease', () => {
  const f = fixture()
  try {
    const result = f.db.registerTaskBootstrap(request())
    assert.equal(result.taskId, 146)
    assert.equal(result.status, 'blocked')
    assert.equal(result.completed, 0)
    assert.equal(result.fencingGeneration, 10)
    assert.equal(f.db.db.prepare('SELECT status,completed FROM tasks WHERE id=?').get(result.taskId).status, 'blocked')
    assert.equal(f.db.db.prepare('SELECT completed FROM tasks WHERE id=?').get(result.taskId).completed, 0)
    assert.deepEqual(f.db.db.prepare("SELECT fencing_generation,current_lease_id FROM project_writer_lease_state WHERE project_id='curl-ai-bridge'").get(), { fencing_generation: 10, current_lease_id: null })
    assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM project_writer_bootstrap_events').get().n, 1)
  } finally { f.close() }
})

test('rejects idempotency replay without consuming another task ID or generation', () => {
  const f = fixture()
  try {
    f.db.registerTaskBootstrap(request())
    assert.throws(() => f.db.registerTaskBootstrap(request()), /task_bootstrap_idempotency_replay/)
    assert.equal(f.db.db.prepare('SELECT max(id) AS id FROM tasks').get().id, 146)
    assert.equal(f.db.db.prepare("SELECT fencing_generation FROM project_writer_lease_state WHERE project_id='curl-ai-bridge'").get().fencing_generation, 10)
  } finally { f.close() }
})

test('rejects active writer lease', () => {
  const f = fixture()
  try {
    f.db.db.prepare(`INSERT INTO project_writer_leases
      (lease_id,project_id,task_id,run_id,worker_id,owner_id,repositories_json,allowlist_json,allowlist_sha256,binding_sha256,authorization_ref,fencing_generation,acquired_at,heartbeat_at,expires_at,status,idempotency_key)
      VALUES('active-lease','curl-ai-bridge',145,'run','worker','owner','[]','{}',?,?,'test',9,?,?,?,'active','active-key')`).run('a'.repeat(64), 'b'.repeat(64), new Date().toISOString(), new Date().toISOString(), new Date(Date.now()+60000).toISOString())
    assert.throws(() => f.db.registerTaskBootstrap(request()), /task_bootstrap_active_lease_exists/)
    assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0)
    assert.equal(f.db.db.prepare("SELECT fencing_generation FROM project_writer_lease_state WHERE project_id='curl-ai-bridge'").get().fencing_generation, 9)
  } finally { f.close() }
})

test('rejects wrong project and existing task ID', () => {
  const f = fixture()
  try {
    assert.throws(() => f.db.registerTaskBootstrap(request({ task: { title: 'wrong', project: 'workspace' } })), /task_bootstrap_wrong_project/)
    assert.throws(() => f.db.registerTaskBootstrap(request({ task: { title: 'existing', project: 'curl-ai-bridge', id: 145 } })), /task_bootstrap_existing_id_rejected/)
    assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0)
  } finally { f.close() }
})

test('forces blocked status and completed=0 regardless of supplied task values', () => {
  const f = fixture()
  try {
    const result = f.db.registerTaskBootstrap(request({ task: { title: 'forced', project: 'curl-ai-bridge', status: 'done', completed: 1 } }))
    assert.equal(result.status, 'blocked')
    assert.equal(result.completed, 0)
    assert.deepEqual(f.db.db.prepare('SELECT status,completed FROM tasks WHERE id=?').get(result.taskId), { status: 'blocked', completed: 0 })
  } finally { f.close() }
})

test('bootstrap event UPDATE and DELETE are rejected by database triggers', () => {
  const f = fixture()
  try {
    f.db.registerTaskBootstrap(request())
    assert.throws(() => f.db.db.prepare("UPDATE project_writer_bootstrap_events SET authorization_ref='tampered'").run(), /append-only/)
    assert.throws(() => f.db.db.prepare('DELETE FROM project_writer_bootstrap_events').run(), /append-only/)
    assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM project_writer_bootstrap_events').get().n, 1)
  } finally { f.close() }
})

test('createCurrentGenerationTaskBootstrapStore registers idempotently at current generation without consuming a generation or acquiring a lease', async () => {
  const { createCurrentGenerationTaskBootstrapStore } = await import('../src/db/taskBootstrap.js')
  const f = fixture()
  try {
    const store = createCurrentGenerationTaskBootstrapStore(f.db.db)
    const first = store.registerTaskAtCurrentGeneration({
      task: { project: 'curl-ai-bridge', title: 'CI-HYBRID-001 implementation', priority: 'medium', task_type: 'ci' },
      authorizationRef: 'auth-gen-9',
      idempotencyKey: 'idem-current-gen-1',
      expectedGeneration: 9
    })
    assert.equal(first.replayed, false)
    assert.equal(first.fencingGeneration, 9)
    assert.equal(first.currentLeaseId, null)
    assert.equal(first.status, 'blocked')

    // Generation was NOT incremented
    const state = f.db.db.prepare("SELECT fencing_generation, current_lease_id FROM project_writer_lease_state WHERE project_id = 'curl-ai-bridge'").get()
    assert.equal(state.fencing_generation, 9)
    assert.equal(state.current_lease_id, 'retired-lease-id')

    // Idempotent replay returns same taskId
    const replay = store.registerTaskAtCurrentGeneration({
      task: { project: 'curl-ai-bridge', title: 'CI-HYBRID-001 implementation' },
      authorizationRef: 'auth-gen-9',
      idempotencyKey: 'idem-current-gen-1',
      expectedGeneration: 9
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.taskId, first.taskId)

    // Stale generation fails closed
    assert.throws(() => store.registerTaskAtCurrentGeneration({
      task: { project: 'curl-ai-bridge', title: 'Stale gen' },
      authorizationRef: 'auth-stale',
      idempotencyKey: 'idem-stale',
      expectedGeneration: 8
    }), /task_bootstrap_generation_mismatch/)

    // Cross-project fails closed
    assert.throws(() => store.registerTaskAtCurrentGeneration({
      task: { project: 'multi-project-workspace', title: 'Cross project' },
      authorizationRef: 'auth-cross',
      idempotencyKey: 'idem-cross',
      expectedGeneration: 9
    }), /task_bootstrap_wrong_project/)
  } finally { f.close() }
})

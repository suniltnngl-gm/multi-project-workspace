import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/database.js'
import { SWARM_PLAN_VERSION, REQUIRED_PLAN_SECTIONS } from '../src/db/taskReadiness.js'

const readinessCliPath = resolve(fileURLToPath(new URL('../../../scripts/task-readiness-record.mjs', import.meta.url)))

function setupTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mpw-task-readiness-'))
  const dbPath = join(dir, 'test.sqlite')
  const evidencePath = join(dir, 'evidence.md')
  writeFileSync(evidencePath, '# Evidence\n', 'utf8')
  const db = createDatabase(dbPath)
  const now = '2026-11-19T08:04:37.758Z'
  const inserted = db.db.prepare(`
    INSERT INTO tasks (
      title, description, completed, project, status, priority, task_type,
      important_context, work_blocked, created_at, updated_at
    ) VALUES (?, ?, 0, 'curl-ai-bridge', 'blocked', 'high', 'feature', ?, ?, ?, ?)
  `).run(
    'SWARM-READINESS-BOOTSTRAP-001',
    'Test blocked task',
    'Initial context',
    'Awaiting operator review',
    now,
    now
  )
  const taskId = Number(inserted.lastInsertRowid)
  return { dir, db, taskId, initialUpdatedAt: now, evidencePath }
}

function makeValidPlan(evidencePath, anchors = [{ repositoryId: 1, headCommit: 'aaa111', branch: 'master' }]) {
  return {
    version: SWARM_PLAN_VERSION,
    reviewed: true,
    reviewer: 'operator-review',
    planningEvidence: 'Verified live pre-state',
    acceptanceCriteria: ['AC-1', 'AC-2'],
    dependencies: { upstream: ['ea96dc9'] },
    allowlist: ['CREATE apps/api/src/db/taskReadiness.js'],
    protectedExclusions: ['.github/workflows/ci.yml'],
    reversibilityAndBudget: { reversible: true, budgetUsd: 0 },
    verificationPlan: ['node --test'],
    evidenceRefs: [evidencePath],
    repositoryAnchors: anchors
  }
}

test('taskReadiness: records valid swarm-plan-v1 with no-authority invariants and append-only event', () => {
  const { dir, db, taskId, initialUpdatedAt, evidencePath } = setupTestDb()
  try {
    const leaseStateBefore = db.db.prepare('SELECT * FROM project_writer_lease_state').all()
    const leasesBefore = db.db.prepare('SELECT * FROM project_writer_leases').all()

    const currentAnchors = [{ repositoryId: 1, headCommit: 'aaa111', branch: 'master' }]
    const result = db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'readiness-key-1',
      actor: 'agy-planner',
      plan: makeValidPlan(evidencePath, currentAnchors),
      currentAnchors
    })

    assert.equal(result.taskId, taskId)
    assert.equal(result.status, 'blocked')
    assert.equal(result.workBlockedPreserved, true)
    assert.equal(result.replayed, false)
    assert.equal(result.authorityGranted, false)
    assert.equal(result.leaseAcquired, false)
    assert.equal(result.state, 'complete')
    assert.equal(result.disposition, 'ready_for_serialized_implementation')

    const task = db.db.prepare('SELECT status, work_blocked, completed, important_context, updated_at FROM tasks WHERE id = ?').get(taskId)
    assert.equal(task.status, 'blocked')
    assert.equal(task.work_blocked, 'Awaiting operator review')
    assert.equal(task.completed, 0)
    assert.ok(task.important_context.includes('Initial context'))
    assert.ok(task.important_context.includes('state=complete'))
    assert.ok(task.important_context.includes('disposition=ready_for_serialized_implementation'))
    assert.notEqual(task.updated_at, initialUpdatedAt)

    const events = db.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND action = 'readiness_recorded'").all(taskId)
    assert.equal(events.length, 1)
    assert.equal(events[0].field, `${SWARM_PLAN_VERSION}:readiness-key-1`)

    assert.deepEqual(db.db.prepare('SELECT * FROM project_writer_lease_state').all(), leaseStateBefore)
    assert.deepEqual(db.db.prepare('SELECT * FROM project_writer_leases').all(), leasesBefore)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taskReadiness: idempotent replay returns replayed=true without duplicate events', () => {
  const { dir, db, taskId, initialUpdatedAt, evidencePath } = setupTestDb()
  try {
    const plan = makeValidPlan(evidencePath)
    const first = db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'idem-replay-1',
      actor: 'agy-planner',
      plan
    })
    const replay = db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'idem-replay-1',
      actor: 'agy-planner',
      plan
    })

    assert.equal(replay.replayed, true)
    assert.equal(replay.eventId, first.eventId)
    assert.equal(replay.authorityGranted, false)
    assert.equal(replay.leaseAcquired, false)

    const events = db.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND action = 'readiness_recorded'").all(taskId)
    assert.equal(events.length, 1)

    const modifiedPlan = { ...plan, planningEvidence: 'Different plan payload' }
    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'idem-replay-1',
      actor: 'agy-planner',
      plan: modifiedPlan
    }), /task_readiness_idempotency_conflict/)

    const invalidPlan = { ...plan }
    delete invalidPlan.verificationPlan
    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'idem-replay-1',
      actor: 'agy-planner',
      plan: invalidPlan
    }), /task_readiness_section_missing:verificationPlan/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taskReadiness: fails closed on incomplete plan, missing evidence, stale anchors, CAS conflict, and non-blocked task', () => {
  const { dir, db, taskId, initialUpdatedAt, evidencePath } = setupTestDb()
  try {
    for (const section of REQUIRED_PLAN_SECTIONS) {
      const badPlan = makeValidPlan(evidencePath)
      delete badPlan[section]
      assert.throws(() => db.recordTaskReadiness({
        taskId,
        expectedUpdatedAt: initialUpdatedAt,
        idempotencyKey: `missing-${section}`,
        actor: 'agy',
        plan: badPlan
      }), new RegExp(`task_readiness_section_missing:${section}`))
    }

    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'missing-evidence',
      actor: 'agy',
      plan: makeValidPlan(join(dir, 'does-not-exist.md'))
    }), /task_readiness_evidence_missing/)

    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'stale-anchor',
      actor: 'agy',
      plan: makeValidPlan(evidencePath, [{ repositoryId: 1, headCommit: 'old-sha', branch: 'master' }]),
      currentAnchors: [{ repositoryId: 1, headCommit: 'new-sha', branch: 'master' }]
    }), /task_readiness_anchor_stale:1/)

    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      idempotencyKey: 'cas-conflict',
      actor: 'agy',
      plan: makeValidPlan(evidencePath)
    }), /task_readiness_cas_conflict/)

    db.db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId)
    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'not-blocked',
      actor: 'agy',
      plan: makeValidPlan(evidencePath)
    }), /task_readiness_task_not_blocked/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taskReadiness: task update and task_events insert are atomic (rollback on event failure)', () => {
  const { dir, db, taskId, initialUpdatedAt, evidencePath } = setupTestDb()
  try {
    db.db.exec(`
      CREATE TRIGGER fail_readiness_event
      BEFORE INSERT ON task_events
      WHEN NEW.action = 'readiness_recorded'
      BEGIN
        SELECT RAISE(ABORT, 'simulated_event_failure');
      END;
    `)

    assert.throws(() => db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt: initialUpdatedAt,
      idempotencyKey: 'atomic-rollback',
      actor: 'agy',
      plan: makeValidPlan(evidencePath)
    }), /simulated_event_failure/)

    const task = db.db.prepare('SELECT important_context, updated_at FROM tasks WHERE id = ?').get(taskId)
    assert.equal(task.important_context, 'Initial context')
    assert.equal(task.updated_at, initialUpdatedAt)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function initTempGitRepo(dir, branch = 'master') {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-b', branch], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

test('taskReadiness CLI: --dry-run enforces read-only pre-checks with zero writes, and live write records & replays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpw-readiness-cli-'))
  const mpwRepo = join(dir, 'multi-project-workspace')
  const cabRepo = join(dir, 'curl-ai-bridge')
  const dbPath = join(dir, 'test.sqlite')
  const evidencePath = join(dir, 'evidence.md')
  const planPath = join(dir, 'plan.json')
  writeFileSync(evidencePath, '# Evidence\n', 'utf8')

  const mpwHead = initTempGitRepo(mpwRepo, 'master')
  const cabHead = initTempGitRepo(cabRepo, 'main')
  const plan = makeValidPlan(evidencePath, [
    { repositoryId: 1, headCommit: mpwHead, branch: 'master' },
    { repositoryId: 4, headCommit: cabHead, branch: 'main' }
  ])
  writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8')

  const db = createDatabase(dbPath)
  const initialUpdatedAt = '2026-11-19T08:04:37.758Z'
  let taskId
  try {
    db.db.prepare('DELETE FROM repositories WHERE id IN (1, 4)').run()
    db.db.prepare(
      'INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).run('multi-project-workspace', mpwRepo, initialUpdatedAt, initialUpdatedAt)
    db.db.prepare(
      'INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (4, ?, ?, ?, ?)'
    ).run('curl-ai-bridge', cabRepo, initialUpdatedAt, initialUpdatedAt)

    taskId = Number(db.db.prepare(`
      INSERT INTO tasks (
        title, description, completed, project, status, priority, task_type,
        important_context, work_blocked, created_at, updated_at
      ) VALUES ('CLI Readiness Task', '', 0, 'curl-ai-bridge', 'blocked', 'high', 'feature', 'Initial', 'Blocked', ?, ?)
    `).run(initialUpdatedAt, initialUpdatedAt).lastInsertRowid)
  } finally {
    db.close()
  }

  try {
    // 1. --dry-run fails closed on stale expected-updated-at
    assert.throws(() => execFileSync(process.execPath, [
      readinessCliPath, '--db', dbPath, '--task-id', String(taskId),
      '--expected-updated-at', '2020-01-01T00:00:00.000Z',
      '--idempotency-key', 'cli-key-1', '--actor', 'agy-cli',
      '--plan-file', planPath, '--dry-run'
    ], { encoding: 'utf8', stdio: 'pipe' }), /task_readiness_cas_conflict/)

    // 2. --dry-run fails closed on missing task
    assert.throws(() => execFileSync(process.execPath, [
      readinessCliPath, '--db', dbPath, '--task-id', '999999',
      '--expected-updated-at', initialUpdatedAt,
      '--idempotency-key', 'cli-key-1', '--actor', 'agy-cli',
      '--plan-file', planPath, '--dry-run'
    ], { encoding: 'utf8', stdio: 'pipe' }), /task_readiness_task_not_found/)

    // 3. --dry-run passes on valid blocked task and makes zero writes
    const dryOut = JSON.parse(execFileSync(process.execPath, [
      readinessCliPath, '--db', dbPath, '--task-id', String(taskId),
      '--expected-updated-at', initialUpdatedAt,
      '--idempotency-key', 'cli-key-1', '--actor', 'agy-cli',
      '--plan-file', planPath, '--dry-run'
    ], { encoding: 'utf8' }))
    assert.equal(dryOut.dryRun, true)
    assert.equal(dryOut.valid, true)
    assert.equal(dryOut.wouldReplay, false)

    const verifyDry = createDatabase(dbPath)
    try {
      assert.equal(verifyDry.db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE action = 'readiness_recorded'").get().c, 0)
    } finally {
      verifyDry.close()
    }

    // 4. Live write against temp DB records readiness and replays idempotently
    const writeOut = JSON.parse(execFileSync(process.execPath, [
      readinessCliPath, '--db', dbPath, '--task-id', String(taskId),
      '--expected-updated-at', initialUpdatedAt,
      '--idempotency-key', 'cli-key-1', '--actor', 'agy-cli',
      '--plan-file', planPath
    ], { encoding: 'utf8' }))
    assert.equal(writeOut.replayed, false)
    assert.equal(writeOut.status, 'blocked')
    assert.equal(writeOut.authorityGranted, false)

    const replayOut = JSON.parse(execFileSync(process.execPath, [
      readinessCliPath, '--db', dbPath, '--task-id', String(taskId),
      '--expected-updated-at', initialUpdatedAt,
      '--idempotency-key', 'cli-key-1', '--actor', 'agy-cli',
      '--plan-file', planPath
    ], { encoding: 'utf8' }))
    assert.equal(replayOut.replayed, true)
    assert.equal(replayOut.eventId, writeOut.eventId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  PLAN_BINDING_SCHEMA,
  createPlanRecord,
  verifyPlanBinding,
  nextPlanRevision
} from '../../src/toolchain/dispatch/plan-binding.js'
import {
  quarantineDirtyWorktree
} from '../../src/toolchain/dispatch/worktree-quarantine.js'
import {
  dedupeByFingerprint,
  reconcileDiscovered
} from '../../src/toolchain/dispatch/discover-reconcile.js'

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-'))
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'baseline\n')
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  return dir
}

function gitStatus(dir) {
  return spawnSync('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8' }).stdout
}

// --- planRevision binding -------------------------------------------------------

test('plan binding accepts the matching revision and head', () => {
  const plan = createPlanRecord({
    workItemId: 'WI-1', planRevision: 2, baseHeadSha: 'abc123',
    allowlist: ['apps/api/src/a.js'], testTargets: ['apps/api/test/a.test.js']
  })
  assert.equal(plan.schema, PLAN_BINDING_SCHEMA)
  assert.equal(nextPlanRevision({ currentPlanRevision: 2 }), 3)
  const res = verifyPlanBinding({
    plan, workItem: { workItemId: 'WI-1', currentPlanRevision: 2 }, headSha: 'abc123'
  })
  assert.equal(res.ok, true)
})

test('negative: a build carrying a stale planRevision is refused before any edit', () => {
  const plan = createPlanRecord({ workItemId: 'WI-1', planRevision: 1, baseHeadSha: 'abc123' })
  const res = verifyPlanBinding({
    plan, workItem: { workItemId: 'WI-1', currentPlanRevision: 2 }, headSha: 'abc123'
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'stale_plan_revision')
})

test('negative: a plan bound to an older HEAD is refused even with a matching revision', () => {
  const plan = createPlanRecord({ workItemId: 'WI-1', planRevision: 2, baseHeadSha: 'oldhead' })
  const res = verifyPlanBinding({
    plan, workItem: { workItemId: 'WI-1', currentPlanRevision: 2 }, headSha: 'newhead'
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'stale_base_head')
})

test('negative: a plan without binding metadata cannot enter a build window', () => {
  const res = verifyPlanBinding({ plan: { allowlist: [] }, workItem: {}, headSha: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'missing_plan_binding')
})

// --- dirty-worktree quarantine --------------------------------------------------

test('a clean tree needs no quarantine and nothing is destroyed', () => {
  const dir = tempRepo()
  try {
    const res = quarantineDirtyWorktree({ repoDir: dir, workItemId: 'WI-1' })
    assert.equal(res.ok, true)
    assert.equal(res.reason, 'clean')
    assert.deepEqual(res.quarantined, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('negative: dirty files belonging to an active work-item lease are never quarantined', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'edited by WI-1\n')
    const res = quarantineDirtyWorktree({
      repoDir: dir, workItemId: 'WI-1', activeLease: true, allowRestore: true
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'dirty_tree_with_active_work_item')
    assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'edited by WI-1\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('orphaned dirty edits are snapshotted first; restore happens only when explicitly allowed', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'orphaned edit\n')
    writeFileSync(join(dir, 'stray.txt'), 'left by an aborted turn\n')

    // Default: observe and snapshot only — never destructively restore.
    const dry = quarantineDirtyWorktree({ repoDir: dir, workItemId: 'WI-2' })
    assert.equal(dry.ok, true)
    assert.equal(dry.restored, false)
    assert.ok(dry.quarantined.length >= 2)
    assert.ok(dry.quarantined.every((q) => existsSync(q.snapshotPath)))
    assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'orphaned edit\n')

    // Explicit restore: baseline returns, snapshots remain as evidence.
    const backupRoot = mkdtempSync(join(tmpdir(), 'wi-backup-'))
    const restored = quarantineDirtyWorktree({ repoDir: dir, workItemId: 'WI-2', allowRestore: true, backupRoot })
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, true)
    assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'baseline\n')
    assert.equal(existsSync(join(dir, 'stray.txt')), false)
    assert.ok(restored.quarantined.every((q) => existsSync(q.snapshotPath)))
    assert.equal(gitStatus(dir), '')
    rmSync(backupRoot, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- resting-state-only discovery reconciliation --------------------------------

test('discovery skips in-flight items and attaches evidence instead of duplicating resting ones', () => {
  const existing = [
    { id: 'T-1', title: 'same issue', fingerprint: 'fp-same', state: 'queued' },
    { id: 'T-2', title: 'building thing', fingerprint: 'fp-building', state: 'building' }
  ]
  const candidates = [
    { title: 'same issue', fingerprint: 'fp-same', summary: 'fresh evidence' },
    { title: 'brand new', fingerprint: 'fp-new', summary: 'new' }
  ]
  const res = reconcileDiscovered({
    candidates,
    existing,
    stateOf: (item) => item.state
  })
  assert.deepEqual(res.skipped.map((s) => s.reason), ['in_flight_skip'])
  // The duplicate fingerprint attaches to T-1 rather than creating a split-brain twin.
  assert.deepEqual(res.attached.map((a) => a.existingId), ['T-1'])
  assert.equal(res.attached[0].candidate.fingerprint, 'fp-same')
  assert.deepEqual(res.created.map((c) => c.fingerprint), ['fp-new'])
})

test('dedupeByFingerprint keeps the first resting record and folds later ones in as duplicates', () => {
  const items = [
    { id: 'a', fingerprint: 'f1', state: 'queued' },
    { id: 'b', fingerprint: 'f1', state: 'open_case' },
    { id: 'c', fingerprint: 'f2', state: 'queued' }
  ]
  const res = dedupeByFingerprint(items)
  assert.deepEqual(res.keep.map((k) => k.id), ['a', 'c'])
  assert.deepEqual(res.duplicates.map((d) => d.id), ['b'])
})

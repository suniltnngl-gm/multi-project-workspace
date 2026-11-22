import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreTask, rankTasks, selectParallelBatch } from '../../src/toolchain/dispatch/task-prioritizer.js'
import { selectNextTask, transitionToReplan } from '../../src/toolchain/dispatch/job-queue.js'

test('scoreTask & rankTasks prioritize P0/blocker/local over P2/remote and break ties by pool-LRU', () => {
  const p2Remote = { taskId: 't-remote', priority: 'P2', costTier: 'remote', state: 'queued', jobs: [{ id: 'j1', type: 'plan', status: 'pending' }] }
  const p1Local = { taskId: 't-local', priority: 'P1', costTier: 'local', state: 'queued', jobs: [{ id: 'j1', type: 'plan', status: 'pending' }] }
  const p0Blocker = { taskId: 't-blocker', priority: 'P0', blocker: true, unblocksCount: 2, costTier: 'daily', state: 'queued', jobs: [{ id: 'j1', type: 'plan', status: 'pending' }] }

  assert.ok(scoreTask(p0Blocker) > scoreTask(p1Local))
  assert.ok(scoreTask(p1Local) > scoreTask(p2Remote))

  const ranked = rankTasks([p2Remote, p1Local, p0Blocker])
  assert.deepStrictEqual(ranked.map((t) => t.taskId), ['t-blocker', 't-local', 't-remote'])

  const picked = selectNextTask([p2Remote, p1Local, p0Blocker])
  assert.strictEqual(picked.taskId, 't-blocker')
})

test('transitionToReplan bounds replans and parks task when maxReplans is exceeded', () => {
  let task = { taskId: 't-replan', state: 'review_build', maxReplans: 2, replanCount: 0, jobs: [] }
  task = transitionToReplan(task, { reason: 'missing_test' })
  assert.strictEqual(task.state, 'replanning')
  assert.strictEqual(task.replanCount, 1)
  assert.strictEqual(task.jobs.at(-1).type, 'replan')

  task = transitionToReplan(task, { reason: 'still_failing' })
  assert.strictEqual(task.state, 'replanning')
  assert.strictEqual(task.replanCount, 2)

  task = transitionToReplan(task, { reason: 'third_reject' })
  assert.strictEqual(task.state, 'parked')
  assert.match(task.parkReason, /max_replans_exceeded:third_reject/)
})

test('selectParallelBatch enforces maxLocalCpu=1, distinct pools, and writer worktree isolation', () => {
  const tasks = [
    { taskId: 'l1', priority: 'P0', costTier: 'local', state: 'queued', jobs: [{ id: 'j1', type: 'plan', status: 'pending' }] },
    { taskId: 'l2', priority: 'P0', costTier: 'local', state: 'queued', jobs: [{ id: 'j1', type: 'plan', status: 'pending' }] },
    { taskId: 'b1', priority: 'P1', costTier: 'daily', pinned: { compositeKey: 'pool-a:cli:m' }, state: 'queued', jobs: [{ id: 'j1', type: 'build', status: 'pending' }] },
    { taskId: 'b2', priority: 'P1', costTier: 'daily', pinned: { compositeKey: 'pool-b:cli:m' }, state: 'queued', jobs: [{ id: 'j1', type: 'build', status: 'pending' }] },
    { taskId: 'r1', priority: 'P2', costTier: 'daily', pinned: { compositeKey: 'pool-c:cli:m' }, state: 'queued', jobs: [{ id: 'j1', type: 'review', status: 'pending' }] }
  ]
  const batch = selectParallelBatch(tasks, { maxParallel: 3, maxLocalCpu: 1 })
  // Picks l1 (skips l2 due to maxLocalCpu=1), picks b1 (skips b2 due to same default-checkout writer), picks r1
  assert.deepStrictEqual(batch.map((t) => t.taskId), ['l1', 'b1', 'r1'])
})

test('selectParallelBatch blocks write-write and read-write file conflicts while allowing concurrent reads', () => {
  const tasks = [
    { taskId: 'w1', priority: 'P0', costTier: 'daily', pinned: { compositeKey: 'p1:c:m' }, worktree: 'wt1', writeFiles: ['a.js'], jobs: [{ id: 'j1', type: 'build', status: 'pending' }] },
    { taskId: 'w2-same-file', priority: 'P0', costTier: 'daily', pinned: { compositeKey: 'p2:c:m' }, worktree: 'wt2', writeFiles: ['a.js'], jobs: [{ id: 'j1', type: 'build', status: 'pending' }] },
    { taskId: 'r-dirty', priority: 'P1', costTier: 'daily', pinned: { compositeKey: 'p3:c:m' }, readFiles: ['a.js'], jobs: [{ id: 'j1', type: 'review', status: 'pending' }] },
    { taskId: 'r-clean1', priority: 'P2', costTier: 'daily', pinned: { compositeKey: 'p4:c:m' }, readFiles: ['b.js'], jobs: [{ id: 'j1', type: 'review', status: 'pending' }] },
    { taskId: 'r-clean2', priority: 'P2', costTier: 'daily', pinned: { compositeKey: 'p5:c:m' }, readFiles: ['b.js'], jobs: [{ id: 'j1', type: 'review', status: 'pending' }] }
  ]
  const batch = selectParallelBatch(tasks, { maxParallel: 4 })
  assert.deepStrictEqual(batch.map((t) => t.taskId), ['w1', 'r-clean1', 'r-clean2'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreTask, rankTasks } from '../../src/toolchain/dispatch/task-prioritizer.js'
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

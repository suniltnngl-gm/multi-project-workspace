import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCandidates, syncDiscoveredToQueue } from '../../../../scripts/swarm-discover.mjs'
import { readQueue, selectNextTask } from '../../src/toolchain/dispatch/job-queue.js'

test('discoverCandidates ranks seed tasks and syncDiscoveredToQueue deduplicates idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-discover-'))
  try {
    const candidates = discoverCandidates({
      repoDir: dir,
      seedTasks: [
        { taskId: 'task-low', priority: 'P3', costTier: 'remote' },
        { taskId: 'task-high', priority: 'P0', blocker: true, costTier: 'local' }
      ]
    })
    assert.strictEqual(candidates[0].taskId, 'task-high')
    assert.strictEqual(candidates[1].taskId, 'task-low')

    const first = syncDiscoveredToQueue(dir, candidates, { apply: true })
    assert.strictEqual(first.createdCount, 2)
    assert.strictEqual(first.skippedCount, 0)

    const second = syncDiscoveredToQueue(dir, candidates, { apply: true })
    assert.strictEqual(second.createdCount, 0)
    assert.strictEqual(second.skippedCount, 2)

    const next = selectNextTask(readQueue(dir))
    assert.strictEqual(next.taskId, 'task-high')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

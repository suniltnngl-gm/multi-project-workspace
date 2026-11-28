import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQueue } from '../src/toolchain/dispatch/job-queue.js'
import { readCases, readCase } from '../src/toolchain/dispatch/case-registry.js'
import { registerDiscoveredImmediately } from '../../../scripts/swarm-discover.mjs'

test('#303: registerDiscoveredImmediately registers out-of-scope tasks AND cases immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-discover-'))
  try {
    const queueDir = join(dir, 'queue', 'active')
    const caseDir = join(dir, 'queue', 'cases')
    mkdirSync(queueDir, { recursive: true })
    mkdirSync(caseDir, { recursive: true })

    const seed = {
      prioritized_work: [
        { id: 'disc-out-of-scope-1', title: 'Discovered mid-execution, different scope', priority: 'P2', options: [] }
      ],
      multi_option_cases: [
        { id: 'case-discovered-inline', title: 'Discovered multi-option decision', priority: 'P2', options: [{ id: 'opt-1', label: 'A' }, { id: 'opt-2', label: 'B' }] }
      ]
    }
    const seedFile = join(dir, 'seed.json')
    writeFileSync(seedFile, JSON.stringify(seed))

    const res = registerDiscoveredImmediately({
      repoDir: dir,
      queueDir,
      caseDir,
      seedTasks: JSON.parse(readFileSync(seedFile, 'utf8'))
    })

    assert.equal(res.ok, true)
    assert.equal(res.inline, true)
    assert.equal(res.registered, 1, 'task registered despite being out of current scope')
    assert.equal(res.cases, 1, 'case registered immediately')
    assert.ok(readQueue(queueDir).some((t) => t.taskId === 'disc-out-of-scope-1'))
    assert.ok(readCases(caseDir).some((c) => c.id === 'case-discovered-inline'))
    assert.equal(readCase(caseDir, 'case-discovered-inline').state, 'open_case')

    // Idempotent: a second call does not duplicate (fingerprint/taskId dedupe).
    const again = registerDiscoveredImmediately({ repoDir: dir, queueDir, caseDir, seedTasks: JSON.parse(readFileSync(seedFile, 'utf8')) })
    assert.equal(again.registered, 0)
    assert.ok(again.skipped.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#303: registration failure never throws — carrying task is unaffected', () => {
  const res = registerDiscoveredImmediately({ queueDir: null })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'queue_dir_required')
  assert.equal(res.registered, 0)
})

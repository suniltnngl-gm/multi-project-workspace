import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncLessonRegister } from '../../../../scripts/swarm-lesson-sync.mjs'
import { writeCase } from '../../src/toolchain/dispatch/case-registry.js'

test('syncLessonRegister extracts case findings idempotently with protected single-file backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-sync-'))
  try {
    const lessonsPath = join(dir, 'lesson-register.json')
    const casesDir = join(dir, 'cases')
    const queueDir = join(dir, 'queue')
    writeFileSync(lessonsPath, JSON.stringify({ schemaVersion: 'g10.6-v1', lessons: [] }), 'utf8')

    writeCase(casesDir, {
      id: 'case-demo',
      title: 'Demo case',
      kind: 'case',
      state: 'open_case',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      findings: { a: { optionId: 'a', ok: true, score: 90, latencyMs: 12, notes: 'fast' } }
    })

    const first = syncLessonRegister({ lessonsPath, casesDir, queueDir, apply: true })
    assert.strictEqual(first.addedCount, 1)
    assert.ok(first.backupPath)
    const saved = JSON.parse(readFileSync(lessonsPath, 'utf8'))
    assert.strictEqual(saved.lessons.length, 1)

    const second = syncLessonRegister({ lessonsPath, casesDir, queueDir, apply: true })
    assert.strictEqual(second.addedCount, 0)
    assert.strictEqual(second.totalCount, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

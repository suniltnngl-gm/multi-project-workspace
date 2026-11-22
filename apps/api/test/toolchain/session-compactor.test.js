import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactSessionFile, parseJsonl } from '../../src/toolchain/dispatch/session-compactor.js'

test('compactSessionFile folds older turns into 1 bounded summary and creates protected backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-compact-'))
  try {
    const file = join(dir, 's1.jsonl')
    const turns = Array.from({ length: 7 }, (_, i) => ({ prompt: `Task ${i + 1}`, reply: `Done ${i + 1}` }))
    writeFileSync(file, `${turns.map((t) => JSON.stringify(t)).join('\n')}\n`, 'utf8')

    const dry = compactSessionFile(file, { keepRecent: 4, apply: false })
    assert.strictEqual(dry.ok, true)
    assert.strictEqual(dry.compacted, true)
    assert.strictEqual(dry.beforeCount, 7)
    assert.strictEqual(dry.afterCount, 5)
    assert.strictEqual(dry.backupPath, null)

    const applied = compactSessionFile(file, { keepRecent: 4, apply: true })
    assert.strictEqual(applied.ok, true)
    assert.ok(applied.backupPath)
    const after = parseJsonl(readFileSync(file, 'utf8'))
    assert.strictEqual(after.length, 5)
    assert.strictEqual(after[0].role, 'summary')
    assert.strictEqual(after[0].compactedTurns, 3)
    assert.strictEqual(after[4].prompt, 'Task 7')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

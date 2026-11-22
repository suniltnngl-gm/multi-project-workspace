import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDirectToolLoop, executeToolCall } from '../../src/toolchain/dispatch/direct-tool-loop.js'

test('runDirectToolLoop executes read_file and blocks path traversal & unauthorized writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-tool-'))
  try {
    writeFileSync(join(dir, 'hello.txt'), 'world-123', 'utf8')

    // Blocks path traversal and unauthorized writes
    assert.throws(() => executeToolCall({ tool: 'read_file', args: { path: '../../etc/passwd' } }, { repoDir: dir }), /path_outside_repo/)
    const denied = executeToolCall({ tool: 'protected_write', args: { path: 'hello.txt', content: 'x' } }, { repoDir: dir, allowWrites: false })
    assert.strictEqual(denied.ok, false)
    assert.strictEqual(denied.error, 'writes_disabled_in_read_only_mode')

    // Multi-turn tool loop: turn 1 calls read_file, turn 2 returns final answer
    let step = 0
    const res = await runDirectToolLoop({
      repoDir: dir,
      prompt: 'What is in hello.txt?',
      callModel: async (msgs) => {
        step++
        if (step === 1) return '{"tool":"read_file","args":{"path":"hello.txt"}}'
        assert.match(msgs.at(-1).content, /world-123/)
        return 'hello.txt contains world-123'
      }
    })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.turns, 2)
    assert.strictEqual(res.finalAnswer, 'hello.txt contains world-123')
    assert.strictEqual(res.trace[0].tool, 'read_file')

    // Authorized protected_write creates backup and writes
    const w = executeToolCall({ tool: 'protected_write', args: { path: 'hello.txt', content: 'updated' } }, { repoDir: dir, allowWrites: true })
    assert.strictEqual(w.ok, true)
    assert.ok(w.backupPath)
    assert.strictEqual(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'updated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

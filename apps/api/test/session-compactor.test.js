import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateSessionCompaction,
  applyCompactPrefix,
  scanAndCompactLocalSessions
} from '../src/toolchain/dispatch/session-compactor.js'
import { buildCliCommand } from '../src/toolchain/dispatch/cli-commands.js'

describe('intelligent swarm session compaction policy', () => {
  it('triggers compact_prefix for oversized AGY transcript and prefixes /compact once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-compact-'))
    try {
      const transcript = join(dir, 'transcript.jsonl')
      writeFileSync(transcript, Array.from({ length: 45 }, (_, i) => JSON.stringify({ step: i })).join('\n') + '\n')

      const dec = evaluateSessionCompaction({ cli: 'agy', sessionId: 'conv-1', transcriptPath: transcript })
      assert.equal(dec.action, 'compact_prefix')
      assert.equal(dec.reason, 'agy_lines_threshold')
      assert.equal(applyCompactPrefix('Run tests', dec.action), '/compact Run tests')
      assert.equal(applyCompactPrefix('/compact Already prefixed', dec.action), '/compact Already prefixed')

      const cmd = buildCliCommand({
        cli: 'agy',
        model: 'gemini-3-flash',
        sessionId: 'conv-1',
        resume: true,
        prompt: 'Run tests',
        cwd: dir,
        autoCompact: true,
        transcriptPath: transcript
      })
      assert.equal(cmd.ok, true)
      assert.equal(cmd.prompt, '/compact Run tests')
      assert.equal(cmd.argv[1], '/compact Run tests')
      assert.equal(cmd.compaction.action, 'compact_prefix')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rotates non-AGY persistent CLI sessions when transcript exceeds threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rotate-'))
    try {
      const transcript = join(dir, 'opencode.jsonl')
      writeFileSync(transcript, Array.from({ length: 45 }, (_, i) => JSON.stringify({ turn: i })).join('\n') + '\n')

      const cmd = buildCliCommand({
        cli: 'opencode',
        model: 'gpt-oss-20b',
        provider: 'groq',
        sessionId: 'ses-123',
        resume: true,
        prompt: 'Fix lint',
        cwd: dir,
        autoCompact: true,
        transcriptPath: transcript
      })
      assert.equal(cmd.ok, true)
      assert.equal(cmd.argv.includes('--session'), false)
      assert.equal(cmd.compaction.action, 'rotate_session')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scans and compacts oversized local JSONL sessions in a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-compact-'))
    try {
      const small = join(dir, 'small.jsonl')
      const big = join(dir, 'big.jsonl')
      writeFileSync(small, '{"prompt":"hi","reply":"ok"}\n')
      writeFileSync(big, Array.from({ length: 15 }, (_, i) => JSON.stringify({ prompt: `p${i}`, reply: `r${i}` })).join('\n') + '\n')

      const results = scanAndCompactLocalSessions(dir, { minLines: 12, keepRecent: 4, apply: true })
      assert.equal(results.length, 2)
      const bigRes = results.find((r) => r.filePath === big)
      const smallRes = results.find((r) => r.filePath === small)
      assert.equal(smallRes.skipped, true)
      assert.equal(bigRes.compacted, true)
      assert.equal(bigRes.afterCount, 5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

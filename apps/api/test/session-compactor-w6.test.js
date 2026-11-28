import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compactTurns,
  isCanonicalEnvelope,
  verifyCompactionIntegrity,
  contextBudget,
  compactSessionFile
} from '../src/toolchain/dispatch/session-compactor.js'

const envelope = (id) => ({ schema: 'sibling-response/v1', id, prompt: `p-${id}`, reply: `r-${id}` })
const prose = (id) => ({ role: 'user', prompt: `prose-${id}`, reply: `reply-${id}` })

test('isCanonicalEnvelope detects schema-tagged records only', () => {
  assert.equal(isCanonicalEnvelope(envelope('a')), true)
  assert.equal(isCanonicalEnvelope({ schema: 'workflow-row/v2' }), true)
  assert.equal(isCanonicalEnvelope(prose(1)), false)
  assert.equal(isCanonicalEnvelope({ schema: 'no-version' }), false)
  assert.equal(isCanonicalEnvelope(null), false)
})

test('compactTurns preserves canonical envelopes verbatim across compaction', () => {
  const turns = [prose(1), prose(2), envelope('e1'), prose(3), prose(4), prose(5), prose(6), envelope('e2')]
  const res = compactTurns(turns, { keepRecent: 2, now: () => '2026-01-01T00:00:00.000Z' })
  assert.equal(res.compacted, true)
  assert.equal(res.preservedEnvelopes, 2)
  assert.equal(verifyCompactionIntegrity(turns, res.turns).ok, true)
  for (const env of [envelope('e1'), envelope('e2')]) {
    assert.ok(res.turns.some((t) => JSON.stringify(t) === JSON.stringify(env)), `envelope ${env.id} survived`)
  }
})

test('verifyCompactionIntegrity detects lost envelopes (fail closed)', () => {
  const turns = [envelope('e1'), prose(1), prose(2), prose(3), prose(4), prose(5)]
  const res = compactTurns(turns, { keepRecent: 2 })
  const lossy = res.turns.filter((t) => !isCanonicalEnvelope(t))
  const verdict = verifyCompactionIntegrity(turns, lossy)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.lost, ['sibling-response/v1'])
  assert.equal(verdict.preservedCount, 0)
})

test('contextBudget verdicts and prune candidates', () => {
  const within = contextBudget({ bytes: 100, lines: 2 })
  assert.equal(within.verdict, 'within_budget')
  assert.equal(within.withinBudget, true)
  const over = contextBudget({ bytes: 99_000, lines: 2 })
  assert.equal(over.verdict, 'over_byte_budget')
  const pruned = contextBudget({
    bytes: 100,
    lines: 2,
    usageAdapters: [
      { kind: 'translate', adapter: 'gguf', okRate: 1, total: 9 },
      { kind: 'translate', adapter: 'graphn', okRate: 0.8, total: 5 },
      { kind: 'measure', adapter: 'cold', okRate: 1, total: 1 }
    ]
  })
  assert.deepEqual(pruned.pruneCandidates, ['translate:gguf'])
})

test('compactSessionFile e2e: schema-tagged records survive apply on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w6-compact-'))
  const file = join(dir, 'session.jsonl')
  const turns = [prose(1), prose(2), envelope('e1'), prose(3), prose(4), prose(5), prose(6), prose(7)]
  writeFileSync(file, turns.map((t) => JSON.stringify(t)).join('\n') + '\n')
  try {
    const res = compactSessionFile(file, { keepRecent: 2, apply: true })
    assert.equal(res.ok, true)
    assert.equal(res.compacted, true)
    assert.equal(res.preservedEnvelopes, 1)
    assert.equal(res.integrity.ok, true)
    assert.ok(res.backupPath, 'lean backup written')
    assert.equal(typeof res.budget.verdict, 'string')
    const after = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(after.some((t) => t.schema === 'sibling-response/v1' && t.id === 'e1'), 'envelope on disk after apply')
    assert.ok(after.some((t) => t.role === 'summary' && t.compactedTurns > 0), 'summary record present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

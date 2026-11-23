import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_HANDOFF_LINES,
  buildHandoffCard,
  writeHandoffCard,
  readLatestHandoff,
  retireSession,
  grepSessionTranscript,
  buildReadOnlyAskCommand
} from '../src/toolchain/dispatch/session-handoff.js'
import { evaluateSessionCompaction } from '../src/toolchain/dispatch/session-compactor.js'
import {
  recordPoolCall,
  checkPoolFiveHourAdmission
} from '../src/toolchain/dispatch/overnight-supervisor.js'

test('buildHandoffCard stays within 30 lines and includes required sections', () => {
  const card = buildHandoffCard({
    sessionId: 'e4748928',
    headSha: '8971f2f',
    completed: ['Auto-compact policy', '601 tests passing'],
    openTasks: ['disc-dirty-tracked'],
    keyDecisions: ['Default grep mode for swarm ask'],
    nextSteps: ['Run swarm overnight']
  })
  const lines = card.trim().split('\n')
  assert.ok(lines.length <= MAX_HANDOFF_LINES)
  assert.match(card, /# Session Handoff: e4748928/)
  assert.match(card, /head_sha: 8971f2f/)
  assert.match(card, /Auto-compact policy/)
})

test('writeHandoffCard and readLatestHandoff round-trip cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-test-'))
  try {
    const card = buildHandoffCard({ sessionId: 'sess-alpha', headSha: 'abc1234', completed: ['Done A'] })
    const res = writeHandoffCard(dir, 'sess-alpha', card)
    assert.equal(res.ok, true)

    const exact = readLatestHandoff(dir, { sessionId: 'sess-alpha' })
    assert.equal(exact.exists, true)
    assert.match(exact.content, /Done A/)

    const latest = readLatestHandoff(dir)
    assert.equal(latest.exists, true)
    assert.equal(latest.sessionId, 'sess-alpha')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('grepSessionTranscript searches handoff card and transcript without LLM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grep-test-'))
  try {
    const handoffDir = join(dir, 'handoffs')
    const card = buildHandoffCard({ sessionId: 'old-123', keyDecisions: ['Use 60KB threshold for AGY'] })
    writeHandoffCard(handoffDir, 'old-123', card)

    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ role: 'user', content: 'unrelated message' }),
        JSON.stringify({ role: 'assistant', content: 'We set agyBytes to 60KB to protect weekly quota.' })
      ].join('\n') + '\n'
    )

    const res = grepSessionTranscript({
      sessionId: 'old-123',
      query: '60KB quota',
      transcriptPath,
      handoffDir
    })
    assert.equal(res.ok, true)
    assert.equal(res.handoffFound, true)
    assert.equal(res.matchCount, 2)
    assert.equal(res.matches[0].source, 'handoff')
    assert.equal(res.matches[1].source, 'transcript')
    assert.equal(res.sizeWarning, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildReadOnlyAskCommand wraps READ-ONLY prompt and flags >60KB sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-cmd-test-'))
  try {
    const bigTranscript = join(dir, 'big.jsonl')
    writeFileSync(bigTranscript, 'x'.repeat(65_000))

    const spec = buildReadOnlyAskCommand({
      sessionId: 'e4748928-5f30-471c-b6ee-4cf3ba073164',
      question: 'Why did we park disc-dirty-tracked?',
      transcriptPath: bigTranscript
    })
    assert.equal(spec.command, 'agy')
    assert.ok(spec.args.includes('--conversation'))
    assert.ok(spec.args.includes('e4748928-5f30-471c-b6ee-4cf3ba073164'))
    assert.match(spec.prompt, /READ-ONLY CLARIFICATION/)
    assert.equal(spec.sizeWarning, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluateSessionCompaction triggers rotate_session on cache_ttl_expired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-ttl-test-'))
  try {
    const tp = join(dir, 'transcript.jsonl')
    writeFileSync(tp, 'x'.repeat(20_000))
    const futureNow = Date.now() + 20 * 60 * 1000 // 20 min later (> 15 min cacheTtlMs)
    const decision = evaluateSessionCompaction({ cli: 'agy', transcriptPath: tp, nowMs: futureNow })
    assert.equal(decision.action, 'rotate_session')
    assert.equal(decision.reason, 'cache_ttl_expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retireSession writes handoff card and records retired-sessions.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retire-test-'))
  try {
    const res = retireSession({
      handoffDir: dir,
      sessionId: 'e4748928-5f30-471c-b6ee-4cf3ba073164',
      headSha: 'f3de9d4',
      completed: ['Shipped swarm handoff/ask'],
      reason: 'oversized_14mb'
    })
    assert.equal(res.ok, true)
    assert.equal(res.retiredCount, 1)
    const card = readLatestHandoff(dir, { sessionId: 'e4748928-5f30-471c-b6ee-4cf3ba073164' })
    assert.equal(card.exists, true)
    assert.match(card.content, /Shipped swarm handoff\/ask/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordPoolCall increments checkPoolFiveHourAdmission for the swarm-ask pool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-call-test-'))
  try {
    const before = checkPoolFiveHourAdmission(dir, 'agy-gemini')
    assert.equal(before.callsInWindow, 0)

    recordPoolCall(dir, { quotaPool: 'agy-gemini', source: 'swarm-ask', sessionId: 'test' })

    const after = checkPoolFiveHourAdmission(dir, 'agy-gemini')
    assert.equal(after.callsInWindow, 1)
    assert.equal(after.admitted, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

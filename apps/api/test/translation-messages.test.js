// W1 (SWARM-TRANSLATION-REG-002): sibling response/message translation + usage tracking.
// Deterministic and $0 — adapters only, no LLM calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  translateResponse,
  translateMessage,
  translationUsageStats,
  recordTranslationUsage,
  SIBLING_RESPONSE_SCHEMA,
  SIBLING_MESSAGE_SCHEMA
} from '../src/toolchain/dispatch/translation-registry.js'

function tmpUsage() {
  const dir = mkdtempSync(join(tmpdir(), 'transl-'))
  return { dir, path: join(dir, 'translation-usage.jsonl') }
}

test('translateResponse adapts codex exec output: verdict, tail findings, auth failure class', () => {
  const { dir, path } = tmpUsage()
  try {
    const ok = translateResponse('codex', 'worked on it\nVERDICT: ACCEPT\n38,192 tokens used', { usagePath: path, track: true })
    assert.equal(ok.schema, SIBLING_RESPONSE_SCHEMA)
    assert.equal(ok.verdict, 'ACCEPT')
    assert.equal(ok.failureClass, null)
    assert.equal(ok.ok, true)
    assert.equal(ok.evidence.tokensUsed, 38192)

    const blocked = translateResponse('codex', 'Blocked before provisioning: not logged in.', { usagePath: path })
    assert.equal(blocked.failureClass, 'auth_failure')
    assert.equal(blocked.ok, false)
    assert.ok(existsSync(path))
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('translateResponse adapts cline/vibe JSON and falls back to generic text for unknown siblings', () => {
  const { dir, path } = tmpUsage()
  try {
    const cline = translateResponse('cline', '{"verdict":"REJECT","findings":{"issues":["x"]}}', { usagePath: path })
    assert.equal(cline.verdict, 'REJECT')
    assert.deepEqual(cline.findings.issues, ['x'])

    const vibe = translateResponse('vibe', '{"status":"error","answer":"nope"}', { usagePath: path })
    assert.equal(vibe.failureClass, 'real_failure')

    const unknown = translateResponse('mystery-cli', 'plain text output\nVERDICT: ACCEPT', { usagePath: path })
    assert.equal(unknown.adapter, 'generic-text')
    assert.equal(unknown.verdict, 'ACCEPT')

    const stats = translationUsageStats(path)
    assert.equal(stats.schema, 'translation-usage-stats/v1')
    const failed = stats.adapters.find((a) => a.adapter === 'vibe')
    assert.equal(failed.okRate, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('translateMessage normalizes cross-CLI handoff envelopes with idempotent tracking', () => {
  const { dir, path } = tmpUsage()
  try {
    const msg = translateMessage({
      from: 'vibe', to: 'codex', message: { task: '289', phase: 'solve', summary: 'telemetry work', artifacts: ['a.diff'], text: 'continue' },
      usagePath: path
    })
    assert.equal(msg.schema, SIBLING_MESSAGE_SCHEMA)
    assert.equal(msg.from, 'vibe')
    assert.equal(msg.to, 'codex')
    assert.equal(msg.taskId, '289')
    assert.equal(msg.phase, 'solve')
    assert.deepEqual(msg.artifacts, ['a.diff'])

    const bare = translateMessage({ from: 'hermes', text: 'handoff body', usagePath: path })
    assert.equal(bare.taskId, null)
    assert.equal(bare.text, 'handoff body')

    const stats = translationUsageStats(path)
    const envAdapter = stats.adapters.find((a) => a.kind === 'message')
    assert.equal(envAdapter.total, 2)
    assert.equal(envAdapter.ok, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recordTranslationUsage requires a path; stats tolerate corrupt lines', () => {
  const { dir, path } = tmpUsage()
  try {
    assert.throws(() => recordTranslationUsage({ usagePath: null, record: { kind: 'response' } }), /usage_path_required/)
    writeFileSync(path, '{"kind":"response","adapter":"codex","ok":true}\nnot-json-at-all\n')
    const stats = translationUsageStats(path)
    assert.equal(stats.adapters.length, 1)
    assert.equal(stats.adapters[0].total, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

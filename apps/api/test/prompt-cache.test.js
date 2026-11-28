import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POOL_CACHE_PROFILES, cacheAdvisory } from '../../../scripts/prompt-cache-policy.mjs'
import { buildSiblingPrompt } from '../../../scripts/swarm-relay.mjs'
import { aggregateRelayTelemetry } from '../../../scripts/swarm-measure.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('CACHE-C-314: groq pools publish a 2h sliding TTL scoped to gpt-oss models', () => {
  const p = POOL_CACHE_PROFILES['console-groq']
  assert.equal(p.provider, 'groq')
  assert.equal(p.ttlMs, 2 * 60 * 60 * 1000)
  assert.equal(p.sliding, true)
  assert.equal(p.discount, 0.5)
  assert.ok(p.cacheableModelPattern.test('openai/gpt-oss-120b'))
  assert.ok(p.cacheableModelPattern.test('gpt-oss-20b'))
  assert.equal(p.cacheableModelPattern.test('qwen/qwen3.8-27b'), false)
})

test('CACHE-C-314: unknown pools are cacheUnknown, never assumed cacheable', () => {
  const adv = cacheAdvisory({ pool: 'nous-hermes-free', model: 'hermes-3' })
  assert.equal(adv.cacheEligible, false)
  assert.equal(adv.cacheUnknown, true)
  const none = cacheAdvisory({ pool: null, model: null })
  assert.equal(none.cacheUnknown, true)
})

test('CACHE-C-314: cacheEligible only for groq pool + gpt-oss model, with warm-return TTL', () => {
  const hit = cacheAdvisory({ pool: 'console-groq', model: 'openai/gpt-oss-120b' })
  assert.equal(hit.cacheEligible, true)
  assert.equal(hit.discount, 0.5)

  const modelMiss = cacheAdvisory({ pool: 'console-groq', model: 'allam-2-7b' })
  assert.equal(modelMiss.cacheEligible, false)
  assert.equal(modelMiss.reason, 'model_not_in_cacheable_set')

  const warm = cacheAdvisory({
    pool: 'console-groq', model: 'openai/gpt-oss-120b',
    lastAttemptAt: '2026-11-28T10:00:00.000Z', now: '2026-11-28T11:00:00.000Z'
  })
  assert.equal(warm.warmReturnWithinTtl, true)

  const cold = cacheAdvisory({
    pool: 'console-groq', model: 'openai/gpt-oss-120b',
    lastAttemptAt: '2026-11-28T10:00:00.000Z', now: '2026-11-28T13:00:00.000Z'
  })
  assert.equal(cold.warmReturnWithinTtl, false)
})

test('CACHE-C-314: static-prefix ordering — invariant instructions first, variable header last', () => {
  const mk = (window) => buildSiblingPrompt({
    mode: 'discover', window, windows: 4, sibling: 'direct', siblingSlot: 'sibling2',
    softWindowSec: 300, reportPath: `/tmp/w${window}.json`, deadlineIso: '2026-11-23T10:05:00.000Z'
  })
  const p1 = mk(1)
  const p2 = mk(2)
  // Shared static prefix across windows of the same job (cache hit precondition).
  let shared = 0
  const max = Math.min(p1.length, p2.length)
  while (shared < max && p1[shared] === p2[shared]) shared += 1
  assert.ok(shared > 100, `static prefix should be substantial, got ${shared} chars`)
  // Variable window header moved after the static instructions.
  const headerIdx = p1.indexOf('swarm relay window 1/4')
  const instrIdx = p1.indexOf('Discover prioritized work')
  assert.ok(instrIdx !== -1 && headerIdx !== -1 && instrIdx < headerIdx)
  // Report path still present for the window.
  assert.match(p1, /\/tmp\/w1\.json/)
})

test('CACHE-C-314: aggregateRelayTelemetry sums cached tokens per pool from attempt usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-cache-'))
  try {
    const reportsDir = join(dir, 'reports')
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(join(reportsDir, 'relay-pipeline-c.json'), JSON.stringify({
      cacheAdvisory: { pool: 'console-groq' },
      windows: [
        { attemptedModels: [{ model: 'openai/gpt-oss-120b', pool: 'console-groq', status: 'ok', usage: { input_tokens: 1000, cached_input_tokens: 800 } }] },
        { attemptedModels: [{ model: 'hermes', status: 'ok', usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 100 } } }] },
        { attemptedModels: [{ model: 'direct', status: 'ok' }], pool: 'cloudflare-workers-ai' }
      ]
    }))
    const agg = aggregateRelayTelemetry(reportsDir)
    assert.equal(agg.cacheUsage.attemptsWithUsage, 2)
    assert.equal(agg.cacheUsage.cachedInputTokens, 900)
    assert.equal(agg.cacheUsage.byPool['console-groq'].cachedInputTokens, 800)
    assert.equal(agg.cacheUsage.byPool['console-groq'].inputTokens, 1000)
    assert.equal(agg.cacheUsage.byPool.unknown.cachedInputTokens, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

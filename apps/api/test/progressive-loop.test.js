import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateProgressiveLoop, DEFAULT_IMPROVE_THRESHOLDS, PROGRESSIVE_LOOP_SCHEMA } from '../src/toolchain/dispatch/progressive-loop.js'

test('healthy loop with no signals produces no fixes and no lessons', () => {
  const res = evaluateProgressiveLoop({})
  assert.equal(res.schema, PROGRESSIVE_LOOP_SCHEMA)
  assert.equal(res.healthy, true)
  assert.deepEqual(res.adapterFixes, [])
  assert.deepEqual(res.lessons, [])
})

test('degrading adapters become fixes; perfect adapters become prune candidates', () => {
  const res = evaluateProgressiveLoop({
    usageAdapters: [
      { kind: 'response', adapter: 'codex', total: 10, ok: 7, okRate: 0.7 },
      { kind: 'translate', adapter: 'gguf', total: 9, ok: 9, okRate: 1 },
      { kind: 'translate', adapter: 'graphn', total: 2, ok: 2, okRate: 1 }
    ]
  })
  assert.equal(res.healthy, false)
  assert.deepEqual(res.adapterFixes.map((f) => f.adapter), ['codex'])
  assert.equal(res.adapterFixes[0].reason, `ok_rate_below_${DEFAULT_IMPROVE_THRESHOLDS.minOkRate}`)
  assert.deepEqual(res.pruneCandidates, ['translate:gguf']) // graphn volume too low to prune
})

test('telemetry failure classes feed adapter fixes as relay rows', () => {
  const res = evaluateProgressiveLoop({ telemetryFailureClasses: { cli_outcome_failed: 3 } })
  assert.equal(res.healthy, false)
  assert.equal(res.adapterFixes[0].kind, 'relay')
  assert.equal(res.adapterFixes[0].reason, 'telemetry_failure_class:cli_outcome_failed')
  assert.match(res.lessons[0].id, /improve:relay:cli_outcome_failed/)
})

test('lessons deduplicate against the existing ledger and cap per run', () => {
  const res = evaluateProgressiveLoop({
    telemetryFailureClasses: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
    existingLessons: ['improve:relay:a']
  })
  assert.equal(res.lessons.length, DEFAULT_IMPROVE_THRESHOLDS.maxLessonsPerRun)
  assert.ok(!res.lessons.some((l) => l.id === 'improve:relay:a'), 'existing lesson deduplicated')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeFallback,
  fallbackAllowed,
  fallbackCandidates,
  isFallbackEligible,
  parseFallbackChain
} from '../src/modelFallback.js'

test('fallback chains are ordered, trimmed, and de-duplicated', () => {
  assert.deepEqual(parseFallbackChain(' colab-3b > kaggle-3b>local-1.5b > kaggle-3b '), [
    'colab-3b',
    'kaggle-3b',
    'local-1.5b'
  ])
  assert.deepEqual(parseFallbackChain(''), [])
  assert.deepEqual(parseFallbackChain(undefined), [])
})

test('fallback candidates continue after the primary model', () => {
  const chain = ['colab-3b', 'kaggle-3b', 'local-1.5b']
  assert.deepEqual(fallbackCandidates(chain, 'colab-3b'), ['kaggle-3b', 'local-1.5b'])
  assert.deepEqual(fallbackCandidates(chain, 'kaggle-3b'), ['local-1.5b'])
  assert.deepEqual(fallbackCandidates(chain, 'local-0.5b'), chain)
  assert.deepEqual(fallbackCandidates([], 'colab-3b'), [])
})

test('only capacity, rate-limit, timeout, and GPU failures are eligible', () => {
  for (const status of [429, 503, 504]) {
    assert.equal(isFallbackEligible({ status }), true)
  }
  assert.equal(isFallbackEligible({ code: 'gpu_unavailable', status: 503 }), true)
  for (const status of [400, 401, 404, 500, 502]) {
    assert.equal(isFallbackEligible({ status }), false)
  }
  assert.equal(isFallbackEligible(new Error('invalid output')), false)
  assert.equal(isFallbackEligible(null), false)
})

test('session-bound requests fall back only when explicitly allowed', () => {
  const chain = ['colab-3b', 'local-1.5b']
  assert.equal(fallbackAllowed({ chain, sessionBound: false }), true)
  assert.equal(fallbackAllowed({ chain, sessionBound: true }), false)
  assert.equal(
    fallbackAllowed({ chain, sessionBound: true, allowSessions: true }),
    true
  )
  assert.equal(fallbackAllowed({ chain: [], sessionBound: false }), false)
})

test('fallback reasons are stable strings and bounded', () => {
  assert.equal(describeFallback(new Error('rate limited')), 'rate limited')
  assert.equal(describeFallback({ status: 503 }), '[object Object]')
  assert.equal(describeFallback(null), 'unknown error')
  assert.equal(describeFallback(new Error('x'.repeat(900))).length, 500)
})

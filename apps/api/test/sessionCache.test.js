import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  computeCacheFingerprint,
  detectCacheDrift,
  formatCompactHandoffPrefix,
  getLatestSessionHandoff,
} from '../src/sessionCache.js'
import { saveSessionHandoff } from '../../../scripts/ai-harvest.mjs'

test('computeCacheFingerprint is deterministic and order-independent for plugins', () => {
  const fp1 = computeCacheFingerprint({
    profile: 'default',
    enabledPlugins: ['gemini-api', 'firebase'],
    model: 'agy@gemini-3.8-flash-medium',
    systemPrefix: 'You are a helper.',
  })
  const fp2 = computeCacheFingerprint({
    profile: 'default',
    enabledPlugins: ['firebase', 'gemini-api'],
    model: 'agy@gemini-3.8-flash-medium',
    systemPrefix: 'You are a helper.',
  })
  const fp3 = computeCacheFingerprint({
    profile: 'conserve',
    enabledPlugins: ['firebase', 'gemini-api'],
    model: 'agy@gemini-3.8-flash-medium',
    systemPrefix: 'You are a helper.',
  })
  assert.equal(fp1, fp2)
  assert.notEqual(fp1, fp3)
})

test('detectCacheDrift flags profile, model, or plugin drift', () => {
  const same = detectCacheDrift({ previousFingerprint: 'abc', currentFingerprint: 'abc' })
  assert.equal(same.drifted, false)

  const drifted = detectCacheDrift({
    previousFingerprint: 'abc',
    currentFingerprint: 'def',
    previousProfile: 'default',
    currentProfile: 'conserve',
    previousModel: 'agy@gemini-3.8-flash-medium',
    currentModel: 'agy@claude-sonnet-5-5-medium',
  })
  assert.equal(drifted.drifted, true)
  assert.equal(drifted.reasons.length, 2)
})

test('formatCompactHandoffPrefix bounds output length and handles null', () => {
  assert.equal(formatCompactHandoffPrefix(null), '')
  const prefix = formatCompactHandoffPrefix(
    {
      source_agent: 'cline',
      target_repo: 'multi-project-workspace',
      summary: 'A'.repeat(500),
      completed_commits: ['abc1234'],
      next_actions: ['Run tests'],
      blockers: [],
    },
    { maxChars: 120 },
  )
  assert.ok(prefix.length <= 120)
  assert.ok(prefix.startsWith('[Handoff cline:multi-project-workspace]'))
})

test('getLatestSessionHandoff returns null when table is missing and returns latest row when present', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cache-'))
  const db = new DatabaseSync(path.join(tmpDir, 'cache.sqlite'))
  assert.equal(getLatestSessionHandoff(db), null)

  saveSessionHandoff(db, {
    conversationId: 'conv-cache-1',
    sourceAgent: 'agy',
    structuredOutput: {
      summary: 'Wired session cache',
      completed_commits: ['1234567'],
      next_actions: ['Verify'],
      blockers: [],
      target_repo: 'multi-project-workspace',
    },
    rawEnvelope: {},
  })
  const latest = getLatestSessionHandoff(db)
  assert.equal(latest.conversation_id, 'conv-cache-1')
  assert.equal(latest.summary, 'Wired session cache')
})

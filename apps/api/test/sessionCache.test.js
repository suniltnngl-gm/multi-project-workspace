import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  buildWorkerHandoffPrefix,
  computeCacheFingerprint,
  detectCacheDrift,
  formatCompactHandoffPrefix,
  getLatestSessionHandoff,
} from '../src/sessionCache.js'
import { createDatabase } from '../src/database.js'
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

test('ai_sessions persists cache_fingerprint and checkAiSessionCacheDrift flags drift', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-db-'))
  const database = createDatabase(path.join(tmpDir, 'sessions.sqlite'))
  const fp1 = computeCacheFingerprint({ profile: 'default', model: 'agy@gemini-3.8-flash-medium' })
  const created = database.createAiSession({
    title: 'Cache test',
    profile: 'default',
    model: 'agy@gemini-3.8-flash-medium',
    cacheFingerprint: fp1,
  })
  assert.equal(created.profile, 'default')
  assert.equal(created.model, 'agy@gemini-3.8-flash-medium')
  assert.equal(created.cacheFingerprint, fp1)

  const noDrift = database.checkAiSessionCacheDrift(created.id, {
    profile: 'default',
    model: 'agy@gemini-3.8-flash-medium',
    cacheFingerprint: fp1,
  })
  assert.equal(noDrift.drifted, false)

  const fp2 = computeCacheFingerprint({ profile: 'conserve', model: 'agy@claude-sonnet-5-5-medium' })
  const drift = database.checkAiSessionCacheDrift(created.id, {
    profile: 'conserve',
    model: 'agy@claude-sonnet-5-5-medium',
    cacheFingerprint: fp2,
  })
  assert.equal(drift.drifted, true)
  assert.equal(drift.reasons.length, 2)
})

test('buildWorkerHandoffPrefix clamps tight-TPM models (opencode/groq) and respects injectHandoff=false', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-clamp-'))
  const dbPath = path.join(tmpDir, 'clamp.sqlite')
  const database = createDatabase(dbPath)
  const sqlite = new DatabaseSync(dbPath)
  saveSessionHandoff(sqlite, {
    conversationId: 'conv-clamp',
    sourceAgent: 'agy',
    structuredOutput: {
      summary: 'S'.repeat(500),
      completed_commits: ['abc1234'],
      next_actions: ['Next step'],
      blockers: [],
      target_repo: 'multi-project-workspace',
    },
    rawEnvelope: {},
  })

  assert.equal(buildWorkerHandoffPrefix({ database, model: 'opencode/grok', injectHandoff: false }), '')
  const tight = buildWorkerHandoffPrefix({ database, model: 'groq/llama-3.1-8b-instant' })
  assert.ok(tight.length > 0 && tight.length <= 240)
  const normal = buildWorkerHandoffPrefix({ database, model: 'agy@gemini-3.8-flash-medium' })
  assert.ok(normal.length > 240 && normal.length <= 600)
})

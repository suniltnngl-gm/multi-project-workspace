import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import {
  SESSION_POOL_DISPATCH_SCHEMA_VERSION,
  resolveDispatchTarget
} from '../../src/toolchain/dispatch/session-pool-dispatcher.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schema = JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/src/toolchain/schemas/session-pool-dispatch.schema.json'), 'utf8'))
const now = () => Date.parse('2026-11-20T15:00:00Z')

const base = { cli: 'agy', repository: 'mpw', gateway: 'g1', provider: 'google', model: 'm-primary', status: 'idle' }
const request = { role: 'worker', repository: 'mpw', cli: 'agy', gateway: 'g1', provider: 'google', model: 'm-primary', workItem: 'SP-001' }

test('reuse prefers warm_observed session', () => {
  const sessions = [
    { ...base, role: 'worker', sessionId: 'cold', cacheState: 'unknown' },
    { ...base, role: 'worker', sessionId: 'warm', cacheState: 'warm_observed' }
  ]
  const plan = resolveDispatchTarget({ sessions, request, now })
  assert.equal(plan.action, 'reuse_session')
  assert.equal(plan.selectedSession.compositeKey, 'agy:warm')
  assert.equal(plan.cliArtifactBoundary.mergeNativeArtifacts, false)
  assertInventorySchema(plan, schema, 'reuse plan')
})

test('role isolation: reviewer session is never reused for worker', () => {
  const sessions = [{ ...base, role: 'reviewer', sessionId: 'r1', cacheState: 'warm_observed' }]
  const plan = resolveDispatchTarget({ sessions, request, now })
  assert.equal(plan.action, 'create_session')
  assert.equal(plan.selectedSession.sessionId, null)
  assertInventorySchema(plan, schema, 'create plan')
})

test('unavailable primary model falls back to persistent fallback session without switching models', () => {
  const sessions = [
    { ...base, role: 'worker', sessionId: 'p1', cacheState: 'warm_observed' },
    { ...base, role: 'worker', sessionId: 'f1', model: 'm-fallback', cacheState: 'warm_observed' }
  ]
  const plan = resolveDispatchTarget({
    sessions, request, now,
    unavailableModels: ['m-primary'],
    fallbackCandidates: [{ model: 'm-fallback' }]
  })
  assert.equal(plan.action, 'reuse_session')
  assert.equal(plan.fallbackUsed, true)
  assert.equal(plan.selectedSession.sessionId, 'f1')
  assert.equal(plan.selectedSession.model, 'm-fallback')
  assert.ok(plan.reasons.includes('model_not_switched'))
  assertInventorySchema(plan, schema, 'fallback plan')

  const created = resolveDispatchTarget({
    sessions: [sessions[0]], request, now,
    unavailableModels: ['m-primary'],
    fallbackCandidates: [{ model: 'm-fallback' }]
  })
  assert.equal(created.action, 'create_session')
  assert.equal(created.selectedSession.model, 'm-fallback')

  const blocked = resolveDispatchTarget({ sessions, request, now, unavailableModels: ['m-primary'] })
  assert.equal(blocked.action, 'blocked')
  assertInventorySchema(blocked, schema, 'blocked plan')
})

test('schema accepts plans and rejects invalid ones', () => {
  const plan = resolveDispatchTarget({ sessions: [], request, now })
  assert.equal(plan.schemaVersion, SESSION_POOL_DISPATCH_SCHEMA_VERSION)
  assert.deepEqual(validateInventorySchema(plan, schema), [])
  const bad = { ...plan, readOnly: false, action: 'merge', cliArtifactBoundary: { cli: 'agy', mergeNativeArtifacts: true }, extra: 1 }
  const errors = validateInventorySchema(bad, schema)
  assert.ok(errors.length >= 4, errors.join('\n'))
})

test('swarm-session-plan.mjs --json smoke test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp001-'))
  try {
    const registry = join(dir, 'registry.json')
    writeFileSync(registry, JSON.stringify({ sessions: [{ ...base, role: 'worker', sessionId: 'w1', cacheState: 'warm_observed' }] }))
    const r = spawnSync(process.execPath, [
      resolve(repoRoot, 'scripts/swarm-session-plan.mjs'),
      '--registry', registry, '--role', 'worker', '--repo', 'mpw', '--work-item', 'SP-001',
      '--cli', 'agy', '--model', 'm-primary', '--json'
    ], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.action, 'reuse_session')
    assert.equal(out.readOnly, true)
    assertInventorySchema(out, schema, 'cli plan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

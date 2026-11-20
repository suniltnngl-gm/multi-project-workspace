import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import { discoverCliLocations } from '../../src/toolchain/discovery/cli-locations/index.js'
import {
  SESSION_CORRELATION_SCHEMA_VERSION,
  correlateSessions
} from '../../src/toolchain/discovery/cli-locations/session-correlator.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schemaPath = resolve(repoRoot, 'apps/api/src/toolchain/schemas/session-correlation.schema.json')
const correlationSchema = JSON.parse(readFileSync(schemaPath, 'utf8'))

test('correlateSessions isolates identical sessionIds across CLIs and separates observed vs inferred locations', () => {
  const existing = new Set(['/home/dev/.gemini/antigravity-cli/brain', '/home/dev/.claude/projects'])
  const readable = new Set(['/home/dev/.gemini/antigravity-cli/brain'])

  const manifest = discoverCliLocations({
    platform: 'linux',
    cwd: '/workspace/proj',
    env: { HOME: '/home/dev' },
    fileExists: (p) => existing.has(p),
    canRead: (p) => readable.has(p),
    canWrite: () => false,
    now: () => Date.parse('2026-11-20T14:20:00Z')
  })

  const result = correlateSessions({
    cliLocationManifest: manifest,
    now: () => Date.parse('2026-11-20T14:20:00Z'),
    sessions: [
      {
        name: 'mpw-orchestrator-gemini',
        sessionId: 'same-id-123',
        role: 'orchestrator',
        repository: 'multi-project-workspace',
        workItem: 'P5.4',
        cli: 'agy',
        gateway: 'direct',
        provider: 'google-antigravity',
        model: 'gemini-3.8-flash',
        cacheState: 'warm_observed',
        status: 'active'
      },
      {
        name: 'mpw-worker-claude',
        sessionId: 'same-id-123',
        role: 'worker',
        repository: 'multi-project-workspace',
        workItem: 'P5.4',
        cli: 'claude',
        gateway: 'direct',
        provider: 'anthropic',
        model: 'claude-sonnet-5.5',
        cacheState: 'unknown',
        status: 'idle'
      },
      {
        name: 'unknown-cli-session',
        sessionId: 'ext-1',
        role: 'worker',
        cli: 'other-cli',
        status: 'idle'
      }
    ]
  })

  assert.equal(result.schemaVersion, SESSION_CORRELATION_SCHEMA_VERSION)
  assert.equal(result.readOnly, true)
  assertInventorySchema(result, correlationSchema, 'P5.4 session correlation')

  const [agyCorr, claudeCorr, otherCorr] = result.correlations
  assert.equal(agyCorr.compositeKey, 'agy:same-id-123')
  assert.equal(claudeCorr.compositeKey, 'claude:same-id-123')
  assert.notEqual(agyCorr.compositeKey, claudeCorr.compositeKey)

  assert.deepEqual(agyCorr.observed.verifiedArtifactDirs, ['/home/dev/.gemini/antigravity-cli/brain'])
  assert.equal(agyCorr.observed.cacheState, 'warm_observed')

  assert.deepEqual(claudeCorr.observed.verifiedSessionDirs, [])
  assert.deepEqual(claudeCorr.inferred.inaccessiblePaths, ['/home/dev/.claude/projects'])
  assert.ok(claudeCorr.warnings.includes('inaccessible_runtime_locations_present'))
  assert.ok(claudeCorr.warnings.includes('cache_state_unverified'))

  assert.equal(otherCorr.cliMatched, false)
  assert.ok(otherCorr.warnings.includes('cli_not_in_manifest:other-cli'))

  // Negative schema test
  const bad = { ...result, correlations: [{ compositeKey: 42 }] }
  assert.ok(validateInventorySchema(bad, correlationSchema).length > 0)
})

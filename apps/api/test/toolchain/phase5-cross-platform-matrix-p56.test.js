import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema } from '../../src/toolchain/schemas/validator.js'
import { buildCliEnvironmentInventory } from '../../src/toolchain/discovery/cli-locations/cli-environment-inventory.js'
import { runToolchainDoctor } from '../../src/toolchain/diagnostics/toolchain-doctor.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const loadSchema = (name) => JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/src/toolchain/schemas', name), 'utf8'))
const manifestSchema = loadSchema('cli-location-manifest.schema.json')
const correlationSchema = loadSchema('session-correlation.schema.json')
const now = () => Date.parse('2026-11-20T15:00:00Z')
const CLIS = ['agy', 'claude', 'codex', 'opencode', 'hermes', 'copilot', 'cline', 'vibe']

const SESSIONS = [
  ...CLIS.map((cli) => ({ cli, sessionId: `${cli}-1`, cacheState: 'warm_observed' })),
  { cli: 'ghost', sessionId: 'g1', cacheState: 'unknown' }
]

function verifyMatrix(inv, platform) {
  assert.equal(inv.readOnly, true)
  assert.equal(inv.cliLocations.platform, platform)
  assert.deepEqual(inv.cliLocations.clis.map((c) => c.cli).sort(), [...CLIS].sort())
  assertInventorySchema(inv.cliLocations, manifestSchema, `${platform} manifest`)
  assertInventorySchema(inv.sessionCorrelations, correlationSchema, `${platform} correlations`)
  const byKey = new Map(inv.sessionCorrelations.correlations.map((c) => [c.compositeKey, c]))
  for (const cli of CLIS) assert.equal(byKey.get(`${cli}:${cli}-1`).cliMatched, true)
  assert.equal(byKey.get('ghost:g1').cliMatched, false)

  const report = runToolchainDoctor({}, { cliEnvironmentInventory: inv })
  assert.equal(report.readOnly, true)
  assert.ok(report.checks.some((c) => c.area === 'cli-session' && c.message.includes('ghost:g1')))
  return report
}

const linuxOpts = (env = {}) => ({
  platform: 'linux',
  cwd: '/workspace/proj',
  env: { HOME: '/home/dev', ...env },
  fileExists: (p) => p.startsWith('/home/dev/'),
  canRead: (p) => !p.includes('.claude'),
  canWrite: () => false,
  now
})

const winOpts = (env = {}) => ({
  platform: 'win32',
  cwd: 'C:\\proj',
  env: {
    USERPROFILE: 'C:\\Users\\dev',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    ...env
  },
  fileExists: (p) => String(p).startsWith('C:\\Users\\dev'),
  canRead: (p) => !String(p).includes('.claude'),
  canWrite: () => false,
  now
})

test('Ubuntu 24.04 matrix: 8 adapters + correlation + doctor + schemas', () => {
  const inv = buildCliEnvironmentInventory({ ...linuxOpts(), sessions: SESSIONS })
  const report = verifyMatrix(inv, 'linux')
  assert.ok(report.checks.some((c) => c.area === 'cli-location'))
})

test('Windows 11 matrix: 8 adapters + env overrides + correlation + doctor + schemas', () => {
  const inv = buildCliEnvironmentInventory({
    ...winOpts({ CODEX_HOME: 'C:\\custom\\codex' }),
    sessions: SESSIONS
  })
  verifyMatrix(inv, 'win32')
  assert.match(JSON.stringify(inv.cliLocations), /C:\\\\Users\\\\dev/)
})

test('secret-exclusion: no secret env values leak into inventory or doctor report', () => {
  const secrets = {
    OPENAI_API_KEY: 'sk-dummy-openai-0000SECRET',
    ANTHROPIC_API_KEY: 'sk-ant-dummy-1111SECRET',
    GITHUB_TOKEN: 'ghp_dummy2222SECRET'
  }
  for (const opts of [linuxOpts(secrets), winOpts(secrets)]) {
    const inv = buildCliEnvironmentInventory({ ...opts, sessions: SESSIONS })
    const report = runToolchainDoctor({}, { cliEnvironmentInventory: inv })
    const blob = JSON.stringify(inv) + JSON.stringify(report)
    for (const value of Object.values(secrets)) assert.equal(blob.split(value).length - 1, 0)
  }
})

test('mixed cacheState: warm_observed no cli-cache warning, unknown has one', () => {
  const inv = buildCliEnvironmentInventory({
    ...linuxOpts(),
    sessions: [
      { cli: 'agy', sessionId: 'warm', cacheState: 'warm_observed' },
      { cli: 'agy', sessionId: 'cold', cacheState: 'unknown' }
    ]
  })
  const cache = runToolchainDoctor({}, { cliEnvironmentInventory: inv }).checks.filter((c) => c.area === 'cli-cache')
  assert.equal(cache.length, 1)
  assert.ok(cache[0].message.includes('agy:cold'))
  assert.ok(!cache.some((c) => c.message.includes('agy:warm')))
})

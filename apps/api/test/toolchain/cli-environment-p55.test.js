import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCliEnvironmentInventory } from '../../src/toolchain/discovery/cli-locations/cli-environment-inventory.js'
import { runToolchainDoctor } from '../../src/toolchain/diagnostics/toolchain-doctor.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const now = () => Date.parse('2026-11-20T15:00:00Z')

const linux = (sessions) => buildCliEnvironmentInventory({
  platform: 'linux',
  cwd: '/workspace/proj',
  env: { HOME: '/home/dev' },
  fileExists: (p) => p === '/home/dev/.gemini/antigravity-cli/brain' || p === '/home/dev/.claude/projects',
  canRead: (p) => p === '/home/dev/.gemini/antigravity-cli/brain',
  canWrite: () => false,
  now,
  sessions
})

test('linux inventory is read-only and correlates sessions', () => {
  const inv = linux([{ cli: 'agy', sessionId: 's1', cacheState: 'warm_observed' }])
  assert.equal(inv.schemaVersion, 'cli-environment-inventory/v1.0')
  assert.equal(inv.readOnly, true)
  assert.equal(inv.mode, 'scan')
  assert.equal(inv.observedAt, '2026-11-20T15:00:00.000Z')
  assert.equal(inv.sessionCorrelations.correlations[0].cliMatched, true)
})

test('windows inventory builds hermetically', () => {
  const inv = buildCliEnvironmentInventory({
    platform: 'win32',
    cwd: 'C:\\proj',
    env: { USERPROFILE: 'C:\\Users\\dev', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    fileExists: () => false,
    canRead: () => false,
    canWrite: () => false,
    now
  })
  assert.equal(inv.cliLocations.platform, 'win32')
  assert.equal(inv.readOnly, true)
  assert.deepEqual(inv.sessionCorrelations.correlations, [])
})

test('doctor surfaces inaccessible locations and unmatched sessions; stays backward compatible', () => {
  const inv = linux([
    { cli: 'nosuchcli', sessionId: 'x' },
    { cli: 'agy', sessionId: 'y' }
  ])
  const base = runToolchainDoctor({})
  const same = runToolchainDoctor({}, {})
  assert.deepEqual(same, base)

  const report = runToolchainDoctor({}, { cliEnvironmentInventory: inv })
  assert.ok(report.checks.some((c) => c.area === 'cli-location' && c.level === 'warn' && c.message.includes('/home/dev/.claude/projects')))
  assert.ok(report.checks.some((c) => c.area === 'cli-session' && c.message.includes('nosuchcli:x')))
  assert.ok(report.checks.some((c) => c.area === 'cli-cache'))
  assert.equal(report.summary.error, base.summary.error)
  assert.equal(report.readOnly, true)
})

test('toolchain-cli-inventory.mjs --json emits read-only inventory', () => {
  const r = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/toolchain-cli-inventory.mjs'), '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.schemaVersion, 'cli-environment-inventory/v1.0')
  assert.equal(out.readOnly, true)
  assert.ok(Array.isArray(out.cliLocations.clis))
})

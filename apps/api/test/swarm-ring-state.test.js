import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RING_STATE_DIR,
  ringStatePath,
  readRingState,
  writeRingState,
  createRingState
} from '../../../scripts/swarm-ring-state.mjs'
import { DEFAULT_STATE_ROOT, statePaths } from '../../../scripts/swarm-state-paths.mjs'

const SCRIPT_URL = new URL('../../../scripts/swarm-ring-state.mjs', import.meta.url)

test('DEFAULT_RING_STATE_DIR resolves through statePaths().relayDir (default root)', () => {
  assert.equal(DEFAULT_RING_STATE_DIR, statePaths().relayDir)
  assert.equal(DEFAULT_RING_STATE_DIR, join(DEFAULT_STATE_ROOT, 'relay'))
  assert.equal(ringStatePath(), join(DEFAULT_RING_STATE_DIR, 'ring-state.json'))
})

test('no inline homedir join remains in swarm-ring-state.mjs', () => {
  const source = readFileSync(SCRIPT_URL, 'utf8')
  assert.ok(!/homedir\(\)/.test(source), 'swarm-ring-state.mjs still calls homedir()')
  assert.ok(!/join\(homedir\(\)/.test(source), 'swarm-ring-state.mjs still joins homedir inline')
})

test('SWARM_STATE_DIR takes precedence over SWARM_STATE_ROOT and the legacy default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-override-'))
  const realHome = mkdtempSync(join(tmpdir(), 'ring-real-home-'))
  try {
    const legacy = join(dir, 'legacy-root')
    const override = join(dir, 'swarm-state')

    // No override: legacy default.
    assert.equal(statePaths({}).relayDir, join(DEFAULT_STATE_ROOT, 'relay'))

    // Legacy SWARM_STATE_ROOT applies when SWARM_STATE_DIR is unset.
    assert.equal(statePaths({ SWARM_STATE_ROOT: legacy }).relayDir, join(legacy, 'relay'))

    // SWARM_STATE_DIR wins over both SWARM_STATE_ROOT and the default.
    const env = { HOME: realHome, SWARM_STATE_DIR: override, SWARM_STATE_ROOT: legacy }
    assert.equal(statePaths(env).relayDir, join(override, 'relay'))
    assert.ok(!statePaths(env).relayDir.startsWith(realHome), 'relay dir leaked into real HOME')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('ring ledger round-trips through the SWARM_STATE_DIR override tree only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-roundtrip-'))
  const realHome = mkdtempSync(join(tmpdir(), 'ring-roundtrip-home-'))
  try {
    const env = { HOME: realHome, SWARM_STATE_DIR: join(dir, 'swarm-state') }
    const relayDir = statePaths(env).relayDir

    const state = createRingState({ siblings: ['hermes', 'direct'], mode: 'pipeline' })
    writeRingState(relayDir, state)

    assert.deepStrictEqual(readRingState(relayDir), state)
    assert.ok(existsSync(join(relayDir, 'ring-state.json')))
    assert.ok(!existsSync(join(realHome, '.local')), 'state wrote into real HOME despite override')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(realHome, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STATE_ROOT,
  resolveStateRoot,
  statePath,
  statePaths,
  BOOTSTRAP_DIRS
} from '../../../../scripts/swarm-state-paths.mjs'

test('SWARM_STATE_DIR wins, then legacy SWARM_STATE_ROOT, then the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-root-'))
  try {
    assert.equal(resolveStateRoot({}), DEFAULT_STATE_ROOT)
    assert.equal(resolveStateRoot({ SWARM_STATE_ROOT: join(dir, 'legacy') }), join(dir, 'legacy'))
    assert.equal(resolveStateRoot({ SWARM_STATE_DIR: join(dir, 'primary'), SWARM_STATE_ROOT: join(dir, 'legacy') }), join(dir, 'primary'))
    assert.throws(() => resolveStateRoot({ SWARM_STATE_DIR: '   ' }), /state_root_invalid/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every state path stays inside the override: no write can leak into the real home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-isolation-'))
  const realHome = mkdtempSync(join(tmpdir(), 'real-home-'))
  try {
    const env = { HOME: realHome, SWARM_STATE_DIR: join(dir, 'swarm-state') }
    const paths = statePaths(env)
    assert.equal(paths.root, join(dir, 'swarm-state'))
    for (const [key, value] of Object.entries(paths)) {
      if (key === 'root') continue
      assert.ok(value.startsWith(paths.root), `${key} escaped the state root: ${value}`)
      assert.ok(!value.startsWith(realHome), `${key} pointed at the real HOME: ${value}`)
    }
    // Exercise a real write through the resolver; only the override tree may change.
    mkdirSync(paths.jobsDir, { recursive: true })
    writeFileSync(statePath(env, 'registries', 'jobs', 'JOB-1.json'), '{}\n')
    assert.equal(existsSync(join(paths.jobsDir, 'JOB-1.json')), true)
    assert.equal(existsSync(join(realHome, '.local')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('bootstrap dir list is relative and idempotent-safe (no absolute segments)', () => {
  assert.ok(BOOTSTRAP_DIRS.includes('relay'))
  assert.ok(BOOTSTRAP_DIRS.includes('registries/work-items'))
  assert.ok(BOOTSTRAP_DIRS.every((d) => !d.startsWith('/')))
})

test('statePaths() emits well-known paths under the override root by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-default-'))
  try {
    const paths = statePaths({})
    assert.equal(paths.root, DEFAULT_STATE_ROOT)
    assert.equal(paths.reportsDir, join(DEFAULT_STATE_ROOT, 'reports'))
    assert.equal(paths.overnightDir, join(DEFAULT_STATE_ROOT, 'overnight'))
    assert.equal(paths.relayDir, join(DEFAULT_STATE_ROOT, 'relay'))
    assert.equal(paths.repoCheckpointsDir, join(DEFAULT_STATE_ROOT, 'repo-checkpoints'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

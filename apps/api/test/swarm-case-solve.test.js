import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCase } from '../../../apps/api/src/toolchain/dispatch/case-registry.js'

const CLI = resolve(new URL('../../../scripts/swarm-case-solve.mjs', import.meta.url).pathname)

function readCaseState(casesDir, id) {
  return readCase(casesDir, id)?.state ?? null
}

test('MC-206+: case-solve scans open cases from the sqlite case registry (and resolves on --apply)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-registry-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    const seed = { id: 'case-registry-check', title: 'Registry-backed case', state: 'open_case', priority: 'P3', options: [{ id: 'opt-1', label: 'Only safe option' }, { id: 'opt-2', label: 'Alternative safe option' }], findings: {} }
    writeFileSync(join(dir, 'seed.json'), JSON.stringify({ multi_option_cases: [seed] }))
    // Register it through the discover CLI so it lands in cases.sqlite the canonical way.
    const discover = resolve(new URL('../../../scripts/swarm-discover.mjs', import.meta.url).pathname)
    const reg = spawnSync(process.execPath, [discover, '--mode', 'discover', '--queue-dir', join(dir, 'queue', 'active'), '--case-dir', casesDir, '--seed-json', join(dir, 'seed.json'), '--apply'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(reg.status, 0, reg.stderr)

    const dry = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(dry.status, 0, dry.stderr)
    const dryOut = JSON.parse(dry.stdout)
    assert.equal(dryOut.scanned, 1, `registry case not scanned: ${dry.stdout}`)
    // Dry-run previews the decision but must not persist it.
    assert.equal(readCaseState(casesDir, 'case-registry-check'), 'open_case', 'dry-run persisted a resolution')

    const applied = spawnSync(process.execPath, [CLI, '--apply', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(applied.status, 0, applied.stderr)
    const out = JSON.parse(applied.stdout)
    assert.equal(out.scanned, 1)
    assert.equal(out.resolvedCount, 1)
    assert.equal(out.resolved[0].id, 'case-registry-check')

    const recheck = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(JSON.parse(recheck.stdout).scanned, 0, 'resolved case must leave the open set')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#233: case-solve scans cases under SWARM_STATE_DIR, not the default state root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-state-override-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    writeFileSync(join(casesDir, 'case-override-check.json'), JSON.stringify({
      id: 'case-override-check',
      title: 'Isolated case',
      state: 'open_case',
      options: [{ id: 'opt-1', label: 'Only option' }],
      findings: {}
    }))
    const res = spawnSync(process.execPath, [CLI, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: dir }
    })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.scanned, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

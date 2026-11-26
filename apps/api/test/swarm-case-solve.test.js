import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = resolve(new URL('../../../scripts/swarm-case-solve.mjs', import.meta.url).pathname)

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

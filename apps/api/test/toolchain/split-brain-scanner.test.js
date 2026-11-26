import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanWorkspaceProgressive,
  scanSplitBrainHazards,
  scanExternalProjects
} from '../../src/toolchain/dispatch/split-brain-scanner.js'
import { statePaths } from '../../../../scripts/swarm-state-paths.mjs'

test('#249: progressive workspace indexer caches mtime/size/sha256 and skips unchanged files on second pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prog-scan-'))
  try {
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'a.js'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(repo, 'node_modules', 'pkg', 'ignored.js'), 'ignored\n', 'utf8')

    const first = scanWorkspaceProgressive({ rootDir: repo, env: { SWARM_STATE_DIR: stateDir } })
    assert.equal(first.ok, true)
    assert.equal(first.scanned, 1)
    assert.equal(first.hashed, 1)
    assert.equal(first.cacheHits, 0)

    const second = scanWorkspaceProgressive({ rootDir: repo, env: { SWARM_STATE_DIR: stateDir } })
    assert.equal(second.scanned, 1)
    assert.equal(second.hashed, 0)
    assert.equal(second.cacheHits, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#249: split-brain hazard scanner flags dual_parent_slots, legacy_json_case_files, and stale_orchestrator_lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-scan-'))
  try {
    const env = { SWARM_STATE_DIR: dir }
    const paths = statePaths(env)
    mkdirSync(paths.relayDir, { recursive: true })
    mkdirSync(paths.casesDir, { recursive: true })

    writeFileSync(paths.ringStatePath, JSON.stringify({
      schema: 'ring-state/v1',
      slots: {
        sibling1: { role: 'parent', promotedAs: 'parent1' },
        sibling2: { role: 'parent', promotedAs: 'parent2' }
      }
    }))
    writeFileSync(join(paths.casesDir, 'old.json'), '{}')
    writeFileSync(paths.orchestratorLockPath, JSON.stringify({ holder: 'old-run', expiresAtMs: 1000 }))

    const res = scanSplitBrainHazards({ env, nowMs: 5000 })
    assert.equal(res.ok, false)
    const ids = res.hazards.map((h) => h.id).sort()
    assert.deepEqual(ids, ['dual_parent_slots', 'legacy_json_case_files', 'stale_orchestrator_lease'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#249: read-only external projects scanner classifies 4 buckets without mutating source files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-scan-'))
  try {
    mkdirSync(join(dir, 'my-private-app'), { recursive: true })
    writeFileSync(join(dir, 'my-private-app', 'package.json'), '{}')
    mkdirSync(join(dir, 'swarm-helper-cli'), { recursive: true })
    mkdirSync(join(dir, 'curl-ai-bridge'), { recursive: true })
    writeFileSync(join(dir, 'ROADMAP-IDEA.md'), '# idea\n')

    const res = scanExternalProjects(dir)
    assert.equal(res.ok, true)
    assert.equal(res.readOnly, true)
    const byName = Object.fromEntries(res.items.map((i) => [i.name, i.bucket]))
    assert.equal(byName['my-private-app'], 'merge_private')
    assert.equal(byName['swarm-helper-cli'], 'extract_public')
    assert.equal(byName['curl-ai-bridge'], 'drop_dedupe')
    assert.equal(byName['ROADMAP-IDEA.md'], 'archive_ideas')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEntrySwarmSync, formatDriftLine } from '../../../scripts/swarm-entry-drift.mjs'

test('entrypoint drift guard detects divergence between scripts/swarm-cli.sh and entry/swarm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const repoCopy = join(dir, 'scripts', 'swarm-cli.sh')
    const entry = join(dir, 'entry-swarm')
    writeFileSync(repoCopy, '#!/usr/bin/env bash\necho swarm\n')

    writeFileSync(entry, readFileSync(repoCopy, 'utf8'))
    const same = checkEntrySwarmSync({ repoDir: dir, entryPath: entry })
    assert.equal(same.ok, true)
    assert.equal(same.reason, 'in_sync')
    assert.match(formatDriftLine(same), /^entrypointSync=in_sync/)

    writeFileSync(entry, `${readFileSync(repoCopy, 'utf8')}\n# divergent edit\n`)
    const drifted = checkEntrySwarmSync({ repoDir: dir, entryPath: entry })
    assert.equal(drifted.ok, false)
    assert.equal(drifted.reason, 'drift')
    assert.match(formatDriftLine(drifted), /entrypointSync=DRIFT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

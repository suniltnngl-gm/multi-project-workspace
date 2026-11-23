import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEntrySwarmSync, findEntrySwarmCandidates, formatDriftLine } from '../../../scripts/swarm-entry-drift.mjs'

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

test('UNKNOWN branch: missing scripts/swarm-cli.sh reports repo_copy_missing even when an entry exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  try {
    // No scripts/ directory at all -> the versioned repo copy cannot be read.
    const entry = join(dir, 'entry-swarm')
    writeFileSync(entry, '#!/usr/bin/env bash\necho swarm\n')

    const result = checkEntrySwarmSync({ repoDir: dir, entryPath: entry })

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'repo_copy_missing')
    assert.equal(result.repoCopy, join(dir, 'scripts', 'swarm-cli.sh'))
    assert.equal(result.entryPath, undefined)
    // The unknown state must never be reported as DRIFT: there is no baseline to compare.
    assert.match(formatDriftLine(result), /^entrypointSync=UNKNOWN \(repo copy missing: /)
    assert.doesNotMatch(formatDriftLine(result), /DRIFT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('UNKNOWN branch: no entry/swarm found reports entrypoint_not_found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const repoCopy = join(dir, 'scripts', 'swarm-cli.sh')
    writeFileSync(repoCopy, '#!/usr/bin/env bash\necho swarm\n')
    const absentEntry = join(dir, 'does-not-exist', 'entry-swarm')

    const result = checkEntrySwarmSync({ repoDir: dir, entryPath: absentEntry })

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'entrypoint_not_found')
    assert.equal(result.repoCopy, repoCopy)
    assert.match(formatDriftLine(result), /^entrypointSync=UNKNOWN \(no entry\/swarm found\)$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('candidate resolution honors SWARM_ENTRYPOINT first and filters nulls', () => {
  const override = join(tmpdir(), 'override-swarm')
  const previous = process.env.SWARM_ENTRYPOINT
  process.env.SWARM_ENTRYPOINT = override
  try {
    const candidates = findEntrySwarmCandidates()
    assert.equal(candidates[0], override)
    assert.ok(!candidates.includes(null))
  } finally {
    if (previous === undefined) delete process.env.SWARM_ENTRYPOINT
    else process.env.SWARM_ENTRYPOINT = previous
  }

  // Unset override falls back to the two default locations.
  const previousAgain = process.env.SWARM_ENTRYPOINT
  delete process.env.SWARM_ENTRYPOINT
  try {
    const candidates = findEntrySwarmCandidates()
    assert.equal(candidates.length, 2)
    for (const candidate of candidates) assert.equal(typeof candidate, 'string')
  } finally {
    if (previousAgain !== undefined) process.env.SWARM_ENTRYPOINT = previousAgain
  }
})

#!/usr/bin/env node
/**
 * Drift guard between the two swarm entrypoints.
 *
 * `swarm` on PATH resolves to ~/Code/entry/swarm, which is intentionally NOT inside
 * the governed repo, while `scripts/swarm-cli.sh` IS versioned. They must stay
 * byte-identical or a fix committed to one copy silently never reaches siblings.
 *
 * Usage: node scripts/swarm-entry-drift.mjs [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function findEntrySwarmCandidates() {
  const home = homedir()
  return [
    process.env.SWARM_ENTRYPOINT || null,
    join(home, 'Code/entry/swarm'),
    join(home, '.local/bin/swarm')
  ].filter(Boolean)
}

export function checkEntrySwarmSync({ repoDir = process.cwd(), entryPath = null } = {}) {
  const repoCopy = resolve(repoDir, 'scripts', 'swarm-cli.sh')
  const candidates = entryPath ? [entryPath] : findEntrySwarmCandidates()
  const entry = candidates.find((p) => existsSync(p))
  if (!existsSync(repoCopy)) return { ok: false, reason: 'repo_copy_missing', repoCopy }
  if (!entry) return { ok: false, reason: 'entrypoint_not_found', repoCopy }

  let same = false
  try {
    same = readFileSync(repoCopy).equals(readFileSync(entry))
  } catch {
    same = false
  }
  return {
    ok: same,
    reason: same ? 'in_sync' : 'drift',
    repoCopy,
    entryPath: entry,
    // Resolve symlinks so ~/.local/bin/swarm -> entry/swarm reports the real file.
    entryReal: resolve(entry)
  }
}

export function formatDriftLine(result) {
  if (result.ok) return `entrypointSync=in_sync (${result.entryPath})`
  if (result.reason === 'repo_copy_missing') return `entrypointSync=UNKNOWN (repo copy missing: ${result.repoCopy})`
  if (result.reason === 'entrypoint_not_found') return 'entrypointSync=UNKNOWN (no entry/swarm found)'
  return `entrypointSync=DRIFT repo=${result.repoCopy} entry=${result.entryPath} (fix: cp scripts/swarm-cli.sh ~/Code/entry/swarm)`
}

function main() {
  const json = process.argv.includes('--json')
  const result = checkEntrySwarmSync({ repoDir: process.env.MPW_DIR || process.cwd() })
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`${formatDriftLine(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

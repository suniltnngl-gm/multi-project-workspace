#!/usr/bin/env node
/**
 * SWARM-PORTABLE-001 (#214) — `./workspace bootstrap --portable`.
 *
 * Idempotently creates the SWARM_STATE_DIR tree, verifies entrypoint symlink integrity and
 * runs a non-mutating readiness check. A fresh clone, container or CI runner bootstraps with
 * one command and never touches the developer's real ~/.local/state/curl-ai-bridge unless
 * that is the resolved root.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { statePaths, BOOTSTRAP_DIRS } from './swarm-state-paths.mjs'
import { checkEntrySwarmSync, formatDriftLine } from './swarm-entry-drift.mjs'

export function bootstrapPortable({
  env = process.env,
  repoDir = process.cwd(),
  apply = true,
  log = () => {}
} = {}) {
  const paths = statePaths(env)
  const created = []
  if (apply) {
    for (const rel of BOOTSTRAP_DIRS) {
      const abs = join(paths.root, rel)
      if (!existsSync(abs)) created.push(rel)
      mkdirSync(abs, { recursive: true, mode: 0o700 })
    }
  }
  const dirsReady = BOOTSTRAP_DIRS.every((rel) => existsSync(join(paths.root, rel)))
  const drift = checkEntrySwarmSync({ repoDir })
  const nodeRun = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' })
  const gitRun = spawnSync('git', ['--version'], { encoding: 'utf8' })
  const readiness = {
    node: nodeRun.status === 0 ? String(nodeRun.stdout).trim() : null,
    git: gitRun.status === 0 ? String(gitRun.stdout).trim() : null,
    dirsReady,
    entrypoint: formatDriftLine(drift),
    stateRootIsDefault: paths.root === join(env.HOME || '', '.local/state/curl-ai-bridge') || !env.SWARM_STATE_DIR
  }
  const ok = Boolean(readiness.dirsReady && readiness.node && readiness.git && drift.ok)
  log(`bootstrap --portable: ${ok ? 'ready' : 'incomplete'} (stateRoot=${paths.root})`)
  return { ok, mode: 'bootstrap-portable', stateRoot: paths.root, created, readiness, drift }
}

const isMain = typeof process.argv[1] === 'string'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const res = bootstrapPortable()
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
  process.exit(res.ok ? 0 : 1)
}

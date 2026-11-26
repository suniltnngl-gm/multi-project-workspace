/**
 * SWARM-SPLITBRAIN-SCAN-001 (#249) — Periodic Split-Brain Discovery +
 * Progressive Workspace Scan/Index + Read-Only External Root 4-Bucket Inventory.
 *
 * Strictly read-only against scanned roots (only writes its own mtime/hash cache
 * at `statePaths().workspaceIndexPath` via `protectedWriteFile`).
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { protectedWriteFile } from './mutation-guard.js'
import { statePaths } from '../../../../../scripts/swarm-state-paths.mjs'

export const WORKSPACE_INDEX_SCHEMA = 'workspace-index/v1'
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', '.cache'])

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * Progressive mtime/size/sha256 workspace indexer.
 * Unchanged files (matching `mtimeMs` and `size`) reuse their cached `sha256` in 0 ms.
 */
export function scanWorkspaceProgressive({
  rootDir,
  indexPath = null,
  env = process.env,
  persist = true,
  maxDepth = 5
} = {}) {
  if (!rootDir || !existsSync(rootDir)) {
    throw new Error(`scan_root_missing:${rootDir}`)
  }
  const cachePath = indexPath || statePaths(env).workspaceIndexPath
  let priorFiles = {}
  if (cachePath && existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (parsed && parsed.schema === WORKSPACE_INDEX_SCHEMA && parsed.files) {
        priorFiles = parsed.files
      }
    } catch {
      priorFiles = {}
    }
  }

  const nextFiles = {}
  let scanned = 0
  let cacheHits = 0
  let hashed = 0

  function walk(dir, depth) {
    if (depth > maxDepth) return
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) {
        walk(abs, depth + 1)
      } else if (st.isFile()) {
        scanned += 1
        const rel = relative(rootDir, abs)
        const prev = priorFiles[rel]
        const mtimeMs = Math.round(st.mtimeMs)
        if (prev && prev.mtimeMs === mtimeMs && prev.size === st.size && prev.sha256) {
          nextFiles[rel] = prev
          cacheHits += 1
        } else {
          nextFiles[rel] = { mtimeMs, size: st.size, sha256: sha256File(abs) }
          hashed += 1
        }
      }
    }
  }

  walk(rootDir, 0)

  const indexDoc = {
    schema: WORKSPACE_INDEX_SCHEMA,
    rootDir,
    updatedAt: new Date().toISOString(),
    totalFiles: scanned,
    files: nextFiles
  }
  if (persist && cachePath) {
    protectedWriteFile(cachePath, `${JSON.stringify(indexDoc, null, 2)}\n`)
  }
  return { ok: true, indexPath: cachePath, scanned, cacheHits, hashed, totalFiles: scanned }
}

/**
 * Periodic split-brain hazard detector across the canonical state root.
 * Checks for:
 *   - `dual_parent_slots` in `ring-state.json`
 *   - `legacy_json_case_files` in `statePaths().casesDir`
 *   - `stale_orchestrator_lease` in `statePaths().orchestratorLockPath`
 */
export function scanSplitBrainHazards({ env = process.env, nowMs = Date.now() } = {}) {
  const paths = statePaths(env)
  const hazards = []

  if (existsSync(paths.ringStatePath)) {
    try {
      const ring = JSON.parse(readFileSync(paths.ringStatePath, 'utf8'))
      const parents = Object.entries(ring?.slots || {}).filter(([, s]) => s && s.role === 'parent')
      if (parents.length > 1) {
        hazards.push({
          id: 'dual_parent_slots',
          severity: 'P1',
          detail: `Found ${parents.length} simultaneous parent slots: ${parents.map(([k]) => k).join(', ')}`
        })
      }
    } catch { /* ignore unreadable ring */ }
  }

  if (existsSync(paths.casesDir)) {
    const legacy = readdirSync(paths.casesDir).filter((f) => f.endsWith('.json'))
    if (legacy.length > 0) {
      hazards.push({
        id: 'legacy_json_case_files',
        severity: 'P1',
        detail: `Found ${legacy.length} legacy JSON case file(s) in ${paths.casesDir}`
      })
    }
  }

  if (existsSync(paths.orchestratorLockPath)) {
    try {
      const lock = JSON.parse(readFileSync(paths.orchestratorLockPath, 'utf8'))
      const exp = Number(lock?.expiresAtMs || 0)
      if (exp > 0 && exp < nowMs) {
        hazards.push({
          id: 'stale_orchestrator_lease',
          severity: 'P1',
          detail: `Expired orchestrator lease held by ${lock.holder || 'unknown'} (expiredAt=${new Date(exp).toISOString()})`
        })
      }
    } catch { /* ignore unreadable lock */ }
  }

  return { ok: hazards.length === 0, hazardCount: hazards.length, hazards }
}

/**
 * Read-only 4-bucket consolidation classifier for an external projects root
 * (e.g. `/home/sunilkr/Code/projects/`):
 *   1. `merge_private`  -> `curl-ai-bridge` (Private)
 *   2. `extract_public` -> `multi-project-workspace` (Public)
 *   3. `archive_ideas`  -> `curl-ai-bridge/docs/ideas/` (Private)
 *   4. `drop_dedupe`    -> drop/dedupe
 */
export function scanExternalProjects(rootDir) {
  if (!rootDir || !existsSync(rootDir)) {
    return { ok: false, error: `external_root_missing:${rootDir}`, items: [] }
  }
  const items = []
  for (const name of readdirSync(rootDir).sort()) {
    const p = join(rootDir, name)
    let st
    try { st = statSync(p) } catch { continue }
    const lower = name.toLowerCase()
    let bucket = 'archive_ideas'
    let target = 'curl-ai-bridge/docs/ideas/'
    if (
      SKIP_DIRS.has(name) ||
      lower.includes('curl-ai-bridge') ||
      lower.includes('multi-project-workspace') ||
      lower.includes('backup') ||
      lower === 'temp' ||
      lower === 'tmp' ||
      lower.endsWith('.bak')
    ) {
      bucket = 'drop_dedupe'
      target = 'drop/dedupe'
    } else if (
      lower.includes('swarm') ||
      lower.includes('workspace') ||
      lower.includes('orchestr') ||
      lower.includes('dashboard') ||
      lower.includes('cli')
    ) {
      bucket = 'extract_public'
      target = 'multi-project-workspace (Public)'
    } else if (st.isDirectory() && (existsSync(join(p, 'package.json')) || existsSync(join(p, 'pyproject.toml')))) {
      bucket = 'merge_private'
      target = 'curl-ai-bridge (Private)'
    }
    items.push({ name, path: p, isDir: st.isDirectory(), bucket, target })
  }
  return { ok: true, readOnly: true, sourceRoot: rootDir, totalItems: items.length, items }
}

#!/usr/bin/env node
/**
 * SP-009 Part 2: Zero-LLM Discover / Create / Rediscover CLI.
 *
 * Completes the 6-stage closed loop:
 *   Discover/Create -> Prioritize/Schedule -> Plan/Replan -> Build/Rebuild -> Review/Publish -> Rediscover
 *
 * Defaults to --dry-run (zero writes). Pass --apply --queue-dir <dir> to enqueue newly
 * discovered tasks (deduplicated by taskId) into the SP-007/SP-009 job queue.
 *
 * Periodic discovery also scans the durable state tree for split-brain conditions
 * and can maintain a progressive mtime/hash workspace index. All scanning, hashing
 * and classification is delegated to `split-brain-scanner.js` (#251) — this CLI is
 * a shaping adapter, never a second authority. Opt-in read-only external-root
 * scanning inventories directories without mutating any file.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { statePaths } from '../scripts/swarm-state-paths.mjs'
import {
  WORKSPACE_INDEX_SCHEMA,
  scanExternalProjects,
  scanSplitBrainHazards,
  scanWorkspaceProgressive
} from '../apps/api/src/toolchain/dispatch/split-brain-scanner.js'
import { createTask, readQueue, queueStats } from '../apps/api/src/toolchain/dispatch/job-queue.js'
import { rankTasks, scoreTask } from '../apps/api/src/toolchain/dispatch/task-prioritizer.js'
import { createWorkItem } from '../apps/api/src/toolchain/dispatch/case-task-lifecycle.js'
import { readCases, writeCase } from '../apps/api/src/toolchain/dispatch/case-registry.js'
import { isReconcilable } from '../apps/api/src/toolchain/dispatch/cas-state.js'
import { appendLifecycleTransition } from '../apps/api/src/toolchain/dispatch/lifecycle-audit.js'

function auditDuplicate(auditDir, event) {
  if (!auditDir) return
  try {
    appendLifecycleTransition(auditDir, event)
  } catch { /* telemetry is best-effort; discovery results are unchanged */ }
}

export function computeEvidenceFingerprint({ source = 'unknown', summary = '', headSha = '' } = {}) {
  return createHash('sha256').update(`${source}|${headSha}|${String(summary).trim()}`).digest('hex').slice(0, 16)
}

/**
 * CLI adapters over `split-brain-scanner.js` (#251). Hashing, hazard detection and
 * 4-bucket classification live in the canonical module; this file only shapes the
 * discover CLI payload and candidates.
 */
export function readJsonSafe(path) {
  if (!path || !existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Progressive workspace index adapter. External roots stay inventory-only; the
 * canonical indexer runs once for the primary (repo) root and persists only on
 * `--apply`. A discovery window is read-only by default.
 */
export function scanWorkspaceIndex({ roots = [], indexPath = null, env = process.env, apply = false } = {}) {
  const path = indexPath || statePaths(env).workspaceIndexPath
  const prior = readJsonSafe(path)
  const primary = roots.find((r) => r && (typeof r === 'string' || r.path))
  if (!primary) return { ok: true, changed: false, fileCount: 0, path }
  const rootDir = typeof primary === 'string' ? primary : primary.path
  const scanned = scanWorkspaceProgressive({ rootDir, indexPath: path, env, persist: Boolean(apply) })
  const changed = prior?.schema !== WORKSPACE_INDEX_SCHEMA
    || scanned.hashed > 0
    || scanned.totalFiles !== prior?.totalFiles
  return {
    ok: scanned.ok,
    changed,
    fileCount: scanned.totalFiles,
    path: scanned.indexPath,
    scanned: scanned.scanned,
    cacheHits: scanned.cacheHits,
    hashed: scanned.hashed
  }
}

/**
 * Split-brain discovery adapter: delegates to the canonical hazard scanner and
 * maps its `id/severity/detail` hazards into the CLI's finding shape (no local
 * hazard logic, no extra `inline_state_paths` check).
 */
export function discoverSplitBrainChecks({ env = process.env, stateRoot = null, nowMs = Date.now() } = {}) {
  const effectiveEnv = stateRoot ? { ...env, SWARM_STATE_DIR: stateRoot } : env
  const scanned = scanSplitBrainHazards({ env: effectiveEnv, nowMs })
  const findings = (scanned.hazards || []).map((h) => ({ kind: h.id, severity: h.severity, detail: h.detail }))
  return {
    ok: scanned.ok,
    checkCount: 3,
    findingCount: scanned.hazardCount,
    findings,
    hazards: scanned.hazards,
    stateRoot: statePaths(effectiveEnv).root
  }
}

function splitBrainCandidates(checks) {
  return (checks.findings || []).map((f) => ({
    taskId: `disc-splitbrain-${f.kind}`,
    source: 'split_brain',
    priority: f.severity || 'P1',
    blocker: true,
    costTier: 'local',
    summary: `Split-brain check '${f.kind}': ${f.detail}`,
    jobs: [{ type: 'plan' }, { type: 'build' }, { type: 'review' }]
  }))
}

/**
 * External-root inventory adapter: canonical 4-bucket classifier plus canonical
 * progressive indexer for the file count. Proposes read-only split/merge cases and
 * never writes to the external root. Use externalRoots: [{ path, readOnly: true }].
 */
export function discoverExternalRoots({ externalRoots = [], env = process.env } = {}) {
  const candidates = []
  const inventories = []
  for (const spec of externalRoots) {
    const dir = typeof spec === 'string' ? spec : spec?.path
    if (!dir || !existsSync(dir)) continue
    const root = resolve(dir)
    const classified = scanExternalProjects(root)
    const inventory = scanWorkspaceProgressive({ rootDir: root, env, persist: false })
    const fileCount = inventory.totalFiles
    const buckets = {}
    for (const item of classified.items || []) buckets[item.bucket] = (buckets[item.bucket] || 0) + 1
    inventories.push({ root, fileCount, readOnly: true, buckets })
    candidates.push({
      taskId: `disc-extroot-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`,
      source: 'external_root',
      priority: 'P2',
      blocker: false,
      costTier: 'local',
      readOnly: true,
      kind: 'case',
      buckets,
      options: [
        { id: 'split', label: `Keep ${root} separate (read-only inventory of ${fileCount} file(s))` },
        { id: 'merge', label: `Consolidate ${root} into the governed workspace (requires operator authorization)` }
      ],
      summary: `External root ${root}: read-only split/merge consolidation (${fileCount} file(s))`,
      jobs: [{ type: 'plan' }, { type: 'review' }]
    })
  }
  return { candidates, inventories, candidateCount: candidates.length }
}

function safeGit(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

export function parseSeedPayload(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.tasks)) return parsed.tasks
  // Support relay-discover-report/v1 (prioritized_work + multi_option_cases)
  const items = []
  if (Array.isArray(parsed?.prioritized_work)) {
    for (const w of parsed.prioritized_work) {
      if (!w?.id) continue
      items.push({
        taskId: String(w.id).toLowerCase(),
        summary: w.title || w.summary || w.id,
        priority: w.priority || 'P2',
        costTier: w.costTier || 'daily',
        source: 'relay_discover',
        options: Array.isArray(w.options) && w.options.length > 1
          ? w.options.map((o, idx) => (typeof o === 'object' && o ? o : { id: `opt-${idx + 1}`, label: String(o) }))
          : []
      })
    }
  }
  if (Array.isArray(parsed?.multi_option_cases)) {
    for (const c of parsed.multi_option_cases) {
      if (!c?.id) continue
      items.push({
        taskId: String(c.id).toLowerCase(),
        summary: c.title || c.id,
        priority: c.priority || 'P2',
        costTier: c.costTier || 'local',
        source: 'relay_discover_case',
        options: Array.isArray(c.options) ? c.options : []
      })
    }
  }
  return items
}

export function discoverCandidates({
  repoDir = process.cwd(),
  seedTasks = [],
  maxTodos = 5,
  env = process.env,
  splitBrain = true,
  externalRoots = []
} = {}) {
  const root = resolve(repoDir)
  const candidates = []

  // Periodic split-brain discovery. Findings only appear when a real anomaly is
  // present, so a healthy tree adds no candidates. Never mutates state.
  if (splitBrain !== false) {
    candidates.push(...splitBrainCandidates(discoverSplitBrainChecks({ env })))
  }

  // Opt-in read-only external-root inventory (split/merge consolidation cases).
  if (Array.isArray(externalRoots) && externalRoots.length) {
    candidates.push(...discoverExternalRoots({ externalRoots, env }).candidates)
  }

  const dirtyTracked = safeGit(root, ['diff', '--name-only'])
  if (dirtyTracked) {
    const files = dirtyTracked.split(/\r?\n/).filter(Boolean)
    candidates.push({
      taskId: 'disc-dirty-tracked',
      source: 'git_diff',
      priority: 'P1',
      blocker: false,
      costTier: 'local',
      summary: `Review/commit ${files.length} modified tracked file(s): ${files.slice(0, 5).join(', ')}`,
      jobs: [{ type: 'plan' }, { type: 'build' }, { type: 'review' }, { type: 'publish' }]
    })
  }

  const todos = safeGit(root, ['grep', '-n', '-I', '-E', 'FIXME|TODO', '--', 'scripts/', 'apps/api/src/toolchain/', ':!scripts/swarm-discover.mjs'])
  if (todos) {
    const lines = todos.split(/\r?\n/).filter(Boolean).slice(0, maxTodos)
    lines.forEach((line, idx) => {
      const isFixme = /\bFIXME\b/.test(line)
      candidates.push({
        taskId: `disc-todo-${idx + 1}`,
        source: isFixme ? 'git_fixme' : 'git_todo',
        priority: isFixme ? 'P1' : 'P2',
        blocker: false,
        costTier: 'local',
        summary: line.slice(0, 160),
        jobs: [{ type: 'plan' }, { type: 'build' }, { type: 'review' }]
      })
    })
  }

  for (const s of seedTasks) {
    if (!s?.taskId) continue
    const workItem = createWorkItem({
      id: String(s.taskId),
      title: s.summary || s.taskId,
      options: s.options || [],
      priority: s.priority || 'P2',
      costTier: s.costTier || 'daily'
    })
    candidates.push({
      taskId: workItem.id,
      kind: workItem.kind,
      state: workItem.state,
      options: workItem.options,
      source: s.source || 'seed',
      priority: workItem.priority,
      blocker: Boolean(s.blocker),
      unblocksCount: Number(s.unblocksCount || 0),
      costTier: workItem.costTier,
      summary: workItem.title,
      jobs: Array.isArray(s.jobs) && s.jobs.length ? s.jobs : [{ type: 'plan' }, { type: 'build' }, { type: 'review' }]
    })
  }

  const headSha = safeGit(root, ['rev-parse', '--short', 'HEAD']) || 'no-git'
  return rankTasks(candidates).map((c) => ({
    ...c,
    headSha,
    evidenceFingerprint: computeEvidenceFingerprint({ source: c.source, summary: c.summary, headSha }),
    score: scoreTask(c)
  }))
}

/**
 * Auto-archive any active `disc-*` task in queueDir whose premise is no longer present
 * in the live discovered candidate set (e.g., `disc-dirty-tracked` after tree is clean).
 */
export function reconcileStaleDiscoveredTasks(queueDir, candidates, { apply = false } = {}) {
  if (!queueDir || !existsSync(queueDir)) return { expiredCount: 0, expired: [] }
  const liveIds = new Set((candidates || []).map((c) => c.taskId))
  const existing = readQueue(queueDir)
  const expired = []
  const archiveDir = join(queueDir, '..', 'archive')
  // #210/#212: only resting states may be archived. Anything scheduled/planning/building/
  // reviewing/publishing is left untouched (in_flight_skip), so an active item can never
  // disappear mid-window.
  for (const t of existing) {
    if (!String(t.taskId || '').startsWith('disc-')) continue
    if (!isReconcilable(t.state)) continue
    if (!liveIds.has(t.taskId)) {
      expired.push(t.taskId)
      if (apply) {
        const src = join(queueDir, `${t.taskId}.json`)
        if (existsSync(src)) {
          mkdirSync(archiveDir, { recursive: true })
          renameSync(src, join(archiveDir, `${t.taskId}.json`))
        }
      }
    }
  }
  return { expiredCount: expired.length, expired }
}

export function syncDiscoveredToQueue(queueDir, candidates, { apply = false, caseDir = null, auditDir = null } = {}) {
  const reconciled = reconcileStaleDiscoveredTasks(queueDir, candidates, { apply })
  const existing = readQueue(queueDir)
  const existingIds = new Set(existing.map((t) => t.taskId))
  const existingCaseIds = new Set(caseDir ? readCases(caseDir).map((c) => c.id) : [])
  // #210/#212: fingerprint dedupe. A candidate matching an already-tracked resting record
  // is attached to it rather than duplicated into a second contradictory task/case.
  const knownFingerprints = new Set([
    ...existing.map((t) => t.fingerprint || t.evidenceFingerprint),
    ...(caseDir ? readCases(caseDir).map((c) => c.fingerprint || c.evidenceFingerprint) : [])
  ].filter(Boolean))
  const created = []
  const cases = []
  const skipped = []

  for (const c of candidates) {
    const fp = c.fingerprint || c.evidenceFingerprint
    if (fp && knownFingerprints.has(fp)) {
      skipped.push(`${c.taskId}:duplicate_fingerprint`)
      auditDuplicate(auditDir, {
        event: 'duplicate_fingerprint',
        reason: 'duplicate_fingerprint',
        fingerprint: fp,
        taskId: c.taskId ?? null
      })
      continue
    }
    if (c.kind === 'case') {
      if (existingCaseIds.has(c.taskId)) {
        skipped.push(c.taskId)
        continue
      }
      if (apply && caseDir) {
        writeCase(caseDir, {
          id: c.taskId,
          title: c.summary,
          kind: 'case',
          state: 'open_case',
          priority: c.priority,
          costTier: c.costTier,
          options: c.options || [],
          selectedOption: null
        })
      }
      cases.push(c.taskId)
      continue
    }
    if (existingIds.has(c.taskId)) {
      skipped.push(c.taskId)
      continue
    }
    if (apply) {
      createTask(queueDir, {
        taskId: c.taskId,
        priority: c.priority,
        blocker: c.blocker,
        unblocksCount: c.unblocksCount || 0,
        costTier: c.costTier,
        jobs: c.jobs
      })
    }
    created.push(c.taskId)
  }

  return {
    apply,
    createdCount: created.length,
    created,
    caseCount: cases.length,
    cases,
    skippedCount: skipped.length,
    skipped,
    expiredCount: reconciled.expiredCount,
    expired: reconciled.expired,
    stats: existsSync(queueDir) ? queueStats(queueDir) : null
  }
}

const argv = process.argv.slice(2)
/**
 * #303: inline discovery-registration. Called by executing entrypoints (relay,
 * case-solve) at the end of a run so ANY candidate discovered while carrying out
 * a task is registered immediately — regardless of current scope. Scope gating
 * applies to *execution* (the serialized lease), never to *registration*.
 * Never throws: registration failure must not fail the carrying task.
 */
export function registerDiscoveredImmediately({ repoDir = process.cwd(), queueDir, caseDir = null, auditDir = null, seedTasks = [], splitBrain = true, externalRoots = [] } = {}) {
  if (!queueDir) return { ok: false, reason: 'queue_dir_required', registered: 0, cases: 0, skipped: [] }
  try {
    const seedItems = Array.isArray(seedTasks) ? seedTasks : parseSeedPayload(seedTasks)
    const candidates = discoverCandidates({ repoDir, seedTasks: seedItems, splitBrain, externalRoots })
    const sync = syncDiscoveredToQueue(queueDir, candidates, { apply: true, caseDir, auditDir })
    return {
      ok: true,
      inline: true,
      candidateCount: candidates.length,
      registered: sync?.created?.length ?? 0,
      cases: sync?.cases?.length ?? 0,
      skipped: sync?.skipped ?? [],
      created: sync?.created ?? []
    }
  } catch (err) {
    return { ok: false, reason: `registration_error:${err?.message || 'unknown'}`, registered: 0, cases: 0, skipped: [] }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-discover.mjs [options]
      --mode <discover|rediscover>  Discovery mode (default: discover)
      --repo <dir>                  Repository root (default: cwd)
      --queue-dir <dir>             Task queue directory
      --case-dir <dir>              Case registry directory for multi-option cases
      --seed-json <file>            Optional JSON file of seed tasks/cases
      --external-root <dir>         Opt-in read-only external root (repeatable)
      --no-split-brain              Disable periodic split-brain discovery checks
      --index-workspace             Build the progressive workspace index (index only)
      --dry-run                     Preview only (default)
      --apply                       Persist tasks, cases and the workspace index
      --json                        Output JSON
  -h, --help                        Show this help
`)
    process.exit(0)
  }
  const opts = {
    mode: 'discover',
    repoDir: process.cwd(),
    queueDir: null,
    caseDir: null,
    seedJson: null,
    splitBrain: true,
    externalRoots: [],
    indexWorkspace: false,
    apply: false,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--no-split-brain') opts.splitBrain = false
    else if (a === '--index-workspace') opts.indexWorkspace = true
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--repo') opts.repoDir = argv[++i]
    else if (a === '--queue-dir') opts.queueDir = argv[++i]
    else if (a === '--case-dir') opts.caseDir = argv[++i]
    else if (a === '--seed-json') opts.seedJson = argv[++i]
    else if (a === '--external-root') {
      opts.externalRoots.push({ path: argv[++i], readOnly: true })
    }
  }

  // #301: only --apply mutates the queue/case registries, so only --apply takes
  // the shared orchestrator lease — continuous discovery cycles (cron) can never
  // split-work with relay/run/overnight/queue-run/case-solve. Dry-runs stay lease-free.
  let discoverLease = null
  const discoverLeaseRunId = `swarm-discover-${process.pid}-${Date.now()}`
  const leaseInherited = Boolean(process.env.SWARM_ORCHESTRATOR_LEASE_PARENT)
  if (opts.apply && !leaseInherited) {
    const { acquireOrchestratorLock, releaseOrchestratorLock } = await import('./swarm-orchestrator-lock.mjs')
    const orchRes = acquireOrchestratorLock({
      stateDir: statePaths().root,
      runId: discoverLeaseRunId,
      resource: 'orchestrator',
      holder: 'swarm-discover',
      auditDir: statePaths().root
    })
    if (!orchRes.ok) {
      process.stderr.write(`swarm discover: ${orchRes.reason}: orchestrator held by ${orchRes.holder} runId=${orchRes.runId}\n`)
      process.exit(3)
    }
    discoverLease = orchRes
    process.on('exit', () => {
      try {
        releaseOrchestratorLock({ stateDir: statePaths().root, runId: discoverLeaseRunId, generation: discoverLease.lock.generation, resource: 'orchestrator' })
      } catch { /* already released */ }
    })
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
  }

  let seedTasks = []
  if (opts.seedJson && existsSync(opts.seedJson)) {
    const parsed = JSON.parse(readFileSync(opts.seedJson, 'utf8'))
    seedTasks = parseSeedPayload(parsed)
  }

  const candidates = discoverCandidates({
    repoDir: opts.repoDir,
    seedTasks,
    splitBrain: opts.splitBrain,
    externalRoots: opts.externalRoots
  })
  const splitBrainChecks = opts.splitBrain ? discoverSplitBrainChecks() : null
  const externalScan = opts.externalRoots.length ? discoverExternalRoots({ externalRoots: opts.externalRoots }) : null
  const workspaceIndex = opts.indexWorkspace
    ? scanWorkspaceIndex({
      roots: [opts.repoDir, ...opts.externalRoots.map((e) => ({ ...e, readOnly: true }))],
      apply: opts.apply
    })
    : null
  const sync = opts.queueDir
    ? syncDiscoveredToQueue(opts.queueDir, candidates, {
      apply: opts.apply,
      caseDir: opts.caseDir,
      auditDir: statePaths().root
    })
    : null
  const payload = {
    ok: true,
    mode: opts.mode,
    repo: resolve(opts.repoDir),
    candidateCount: candidates.length,
    candidates,
    splitBrainChecks,
    externalScan,
    workspaceIndex: workspaceIndex ? { changed: workspaceIndex.changed, fileCount: workspaceIndex.fileCount, path: workspaceIndex.path } : null,
    sync
  }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${opts.mode}: ${candidates.length} candidate(s)\n`)
}

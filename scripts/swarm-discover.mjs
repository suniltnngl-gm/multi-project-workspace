#!/usr/bin/env node
/**
 * SP-009 Part 2: Zero-LLM Discover / Create / Rediscover CLI.
 *
 * Completes the 6-stage closed loop:
 *   Discover/Create -> Prioritize/Schedule -> Plan/Replan -> Build/Rebuild -> Review/Publish -> Rediscover
 *
 * Defaults to --dry-run (zero writes). Pass --apply --queue-dir <dir> to enqueue newly
 * discovered tasks (deduplicated by taskId) into the SP-007/SP-009 job queue.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createTask, readQueue, queueStats } from '../apps/api/src/toolchain/dispatch/job-queue.js'
import { rankTasks, scoreTask } from '../apps/api/src/toolchain/dispatch/task-prioritizer.js'
import { createWorkItem } from '../apps/api/src/toolchain/dispatch/case-task-lifecycle.js'
import { readCases, writeCase } from '../apps/api/src/toolchain/dispatch/case-registry.js'

export function computeEvidenceFingerprint({ source = 'unknown', summary = '', headSha = '' } = {}) {
  return createHash('sha256').update(`${source}|${headSha}|${String(summary).trim()}`).digest('hex').slice(0, 16)
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

export function discoverCandidates({ repoDir = process.cwd(), seedTasks = [], maxTodos = 5 } = {}) {
  const root = resolve(repoDir)
  const candidates = []

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
  const RESTING_STATES = new Set(['queued', 'parked'])
  for (const t of existing) {
    if (!String(t.taskId || '').startsWith('disc-')) continue
    if (!RESTING_STATES.has(t.state)) continue
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

export function syncDiscoveredToQueue(queueDir, candidates, { apply = false, caseDir = null } = {}) {
  const reconciled = reconcileStaleDiscoveredTasks(queueDir, candidates, { apply })
  const existing = readQueue(queueDir)
  const existingIds = new Set(existing.map((t) => t.taskId))
  const existingCaseIds = new Set(caseDir ? readCases(caseDir).map((c) => c.id) : [])
  const created = []
  const cases = []
  const skipped = []

  for (const c of candidates) {
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
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-discover.mjs [options]
      --mode <discover|rediscover>  Discovery mode (default: discover)
      --repo <dir>                  Repository root (default: cwd)
      --queue-dir <dir>             Task queue directory
      --case-dir <dir>              Case registry directory for multi-option cases
      --seed-json <file>            Optional JSON file of seed tasks/cases
      --dry-run                     Preview only (default)
      --apply                       Persist tasks and cases
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
    apply: false,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--repo') opts.repoDir = argv[++i]
    else if (a === '--queue-dir') opts.queueDir = argv[++i]
    else if (a === '--case-dir') opts.caseDir = argv[++i]
    else if (a === '--seed-json') opts.seedJson = argv[++i]
  }

  let seedTasks = []
  if (opts.seedJson && existsSync(opts.seedJson)) {
    const parsed = JSON.parse(readFileSync(opts.seedJson, 'utf8'))
    seedTasks = parseSeedPayload(parsed)
  }

  const candidates = discoverCandidates({ repoDir: opts.repoDir, seedTasks })
  const sync = opts.queueDir ? syncDiscoveredToQueue(opts.queueDir, candidates, { apply: opts.apply, caseDir: opts.caseDir }) : null
  const payload = {
    ok: true,
    mode: opts.mode,
    repo: resolve(opts.repoDir),
    candidateCount: candidates.length,
    candidates,
    sync
  }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${opts.mode}: ${candidates.length} candidate(s)\n`)
}

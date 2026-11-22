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
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createTask, readQueue, queueStats } from '../apps/api/src/toolchain/dispatch/job-queue.js'
import { rankTasks, scoreTask } from '../apps/api/src/toolchain/dispatch/task-prioritizer.js'
import { createWorkItem } from '../apps/api/src/toolchain/dispatch/case-task-lifecycle.js'

function safeGit(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return ''
  }
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

  return rankTasks(candidates).map((c) => ({ ...c, score: scoreTask(c) }))
}

export function syncDiscoveredToQueue(queueDir, candidates, { apply = false } = {}) {
  const existing = readQueue(queueDir)
  const existingIds = new Set(existing.map((t) => t.taskId))
  const created = []
  const cases = []
  const skipped = []

  for (const c of candidates) {
    if (c.kind === 'case') {
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
    stats: existsSync(queueDir) ? queueStats(queueDir) : null
  }
}

const argv = process.argv.slice(2)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  const opts = {
    mode: 'discover',
    repoDir: process.cwd(),
    queueDir: null,
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
    else if (a === '--seed-json') opts.seedJson = argv[++i]
  }

  let seedTasks = []
  if (opts.seedJson && existsSync(opts.seedJson)) {
    const parsed = JSON.parse(readFileSync(opts.seedJson, 'utf8'))
    seedTasks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
  }

  const candidates = discoverCandidates({ repoDir: opts.repoDir, seedTasks })
  const sync = opts.queueDir ? syncDiscoveredToQueue(opts.queueDir, candidates, { apply: opts.apply }) : null
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

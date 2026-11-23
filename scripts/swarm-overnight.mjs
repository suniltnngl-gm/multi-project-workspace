#!/usr/bin/env node
/**
 * SP-010 Unattended / Overnight Swarm Runner.
 *
 * Runs bounded ticks with:
 * - Kill-switch check (`<stateDir>/STOP_SWARM`)
 * - Wall-clock budget (`--max-minutes`), `--max-ticks`, and consecutive-failure circuit breaker
 * - Host resource gate (SP-004) before each tick
 * - Persistent 5-hour rolling pool-call cap enforcement (`copilot=1/5h`, `agy=4/5h`)
 * - Periodic zero-LLM lesson sync + atomic `overnight-report.json`
 *
 * Defaults to --dry-run (safe simulation, zero LLM spawns). Pass --execute for live ticks.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gatherTelemetry } from '../apps/api/src/toolchain/dispatch/host-telemetry.js'
import { evaluateResourceGate } from '../apps/api/src/toolchain/dispatch/resource-gate.js'
import { readQueue, selectNextTask, queueStats } from '../apps/api/src/toolchain/dispatch/job-queue.js'
import {
  evaluateOvernightGuard,
  checkPoolFiveHourAdmission,
  recordPoolCall,
  writeOvernightReport
} from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'
import { scanAndCompactLocalSessions } from '../apps/api/src/toolchain/dispatch/session-compactor.js'
import { createLeaseStore } from '../apps/api/src/toolchain/dispatch/lease-store.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { discoverCandidates, reconcileStaleDiscoveredTasks } from './swarm-discover.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-overnight.mjs [options]
      --state-dir <dir>        Overnight state dir (ledger, STOP_SWARM, report)
      --queue-dir <dir>        Active task queue directory
      --max-ticks <n>          Max bounded ticks (default: 10)
      --max-minutes <n>        Max wall-clock minutes (default: 480)
      --max-failures <n>       Consecutive failure circuit breaker (default: 3)
      --tick-interval-sec <n>  Delay between ticks (default: 0)
      --case-dir <dir>         Case registry directory for --auto-discover
      --auto-discover          Run swarm-discover --mode rediscover on idle/start
      --lesson-sync            Run swarm-lesson-sync --apply at end of run
      --auto-compact           Auto-compact oversized local JSONL sessions at end of run
      --sessions-dir <dir>     Sessions dir for --auto-compact
      --dry-run                Simulate ticks only (default)
      --execute                Run live bounded queue ticks
      --json                   Output JSON summary
  -h, --help                   Show this help
`)
  process.exit(0)
}
const opts = {
  stateDir: join(homedir(), '.local/state/curl-ai-bridge/overnight'),
  queueDir: join(homedir(), '.local/state/curl-ai-bridge/queue/active'),
  caseDir: join(homedir(), '.local/state/curl-ai-bridge/queue/cases'),
  registry: join(homedir(), '.local/state/curl-ai-bridge/sessions/swarm-sessions.json'),
  sessionsDir: join(homedir(), '.local/state/curl-ai-bridge/sessions'),
  maxTicks: 10,
  maxMinutes: 480,
  maxFailures: 3,
  tickIntervalSec: 0,
  autoDiscover: false,
  lessonSync: true,
  autoCompact: true,
  selfImprove: true,
  execute: false,
  json: false
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--execute') opts.execute = true
  else if (a === '--dry-run') opts.execute = false
  else if (a === '--auto-discover') opts.autoDiscover = true
  else if (a === '--lesson-sync') opts.lessonSync = true
  else if (a === '--no-lesson-sync') opts.lessonSync = false
  else if (a === '--auto-compact') opts.autoCompact = true
  else if (a === '--no-auto-compact') opts.autoCompact = false
  else if (a === '--self-improve') opts.selfImprove = true
  else if (a === '--no-self-improve') opts.selfImprove = false
  else if (a === '--state-dir') opts.stateDir = resolve(argv[++i])
  else if (a === '--queue-dir') opts.queueDir = resolve(argv[++i])
  else if (a === '--case-dir') opts.caseDir = resolve(argv[++i])
  else if (a === '--registry') opts.registry = resolve(argv[++i])
  else if (a === '--sessions-dir') opts.sessionsDir = resolve(argv[++i])
  else if (a === '--max-ticks') opts.maxTicks = Number(argv[++i]) || 10
  else if (a === '--max-minutes') opts.maxMinutes = Number(argv[++i]) || 480
  else if (a === '--max-failures') opts.maxFailures = Number(argv[++i]) || 3
  else if (a === '--tick-interval-sec') opts.tickIntervalSec = Number(argv[++i]) || 0
}

const startedAtMs = Date.now()
const maxDurationMs = opts.maxMinutes * 60 * 1000
const ticks = []
let consecutiveFailures = 0
let stopReason = 'completed'
const repoDir = resolve(new URL('..', import.meta.url).pathname)
const reapedEntries = []

try {
  createLeaseStore({ stateDir: opts.queueDir }).reap()
} catch {}

function reconcileStaleTasks() {
  try {
    const liveCandidates = discoverCandidates({ repoDir })
    const res = reconcileStaleDiscoveredTasks(opts.queueDir, liveCandidates, { apply: opts.execute })
    for (const id of res.expired) {
      if (!reapedEntries.includes(id)) reapedEntries.push(id)
    }
  } catch {}
}

while (true) {
  const guard = evaluateOvernightGuard({
    stateDir: opts.stateDir,
    startedAtMs,
    nowMs: Date.now(),
    ticksCompleted: ticks.length,
    maxTicks: opts.maxTicks,
    maxDurationMs,
    consecutiveFailures,
    maxConsecutiveFailures: opts.maxFailures
  })
  if (!guard.continue) {
    stopReason = guard.reason
    break
  }

  const telemetry = gatherTelemetry()
  const gate = evaluateResourceGate({ telemetry, activeCount: 0, now: new Date() })
  if (gate.verdict !== 'admitted') {
    ticks.push({ tick: ticks.length + 1, status: 'deferred_resource_gate', reason: gate.primaryReason })
    consecutiveFailures++
    continue
  }

  reconcileStaleTasks()
  let tasks = readQueue(opts.queueDir)
  let nextTask = selectNextTask(tasks)
  if (!nextTask && opts.autoDiscover) {
    const discoverCli = resolve(new URL('./swarm-discover.mjs', import.meta.url).pathname)
    const repoDir = resolve(new URL('..', import.meta.url).pathname)
    spawnSync(
      process.execPath,
      [discoverCli, '--mode', 'rediscover', '--repo', repoDir, '--queue-dir', opts.queueDir, '--case-dir', opts.caseDir, ...(opts.execute ? ['--apply'] : ['--dry-run']), '--json'],
      { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    )
    tasks = readQueue(opts.queueDir)
    nextTask = selectNextTask(tasks)
  }
  if (!nextTask) {
    ticks.push({ tick: ticks.length + 1, status: 'idle', reason: 'no_actionable_tasks' })
    stopReason = 'queue_idle'
    break
  }

  const TIER_DEFAULT_POOL = {
    weekly: 'agy-gemini',
    monthly: 'github-copilot',
    daily: 'opencode-tidepool-free',
    local: 'local-llama-cpp'
  }
  const pool =
    nextTask.pinned?.compositeKey?.split(':')[0] ||
    TIER_DEFAULT_POOL[nextTask.costTier] ||
    nextTask.costTier ||
    'local-llama-cpp'
  const capCheck = checkPoolFiveHourAdmission(opts.stateDir, pool)
  if (!capCheck.admitted) {
    ticks.push({ tick: ticks.length + 1, taskId: nextTask.taskId, pool, status: 'deferred_5h_cap', reason: capCheck.reason })
    stopReason = 'five_hour_cap_reached'
    break
  }

  if (!opts.execute) {
    ticks.push({ tick: ticks.length + 1, taskId: nextTask.taskId, pool, status: 'dry_run_ok' })
    consecutiveFailures = 0
    continue
  }

  const queueRunner = resolve(new URL('./swarm-queue-run.mjs', import.meta.url).pathname)
  const res = spawnSync(
    process.execPath,
    [queueRunner, '--queue-dir', opts.queueDir, '--registry', opts.registry, '--quota-pool', pool, '--calls-in-window', String(capCheck.callsInWindow), '--json'],
    { cwd: resolve(new URL('..', import.meta.url).pathname), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }
  )
  const ok = res.status === 0
  recordPoolCall(opts.stateDir, { quotaPool: pool, taskId: nextTask.taskId, status: ok ? 'ok' : `exit_${res.status}` })
  ticks.push({ tick: ticks.length + 1, taskId: nextTask.taskId, pool, status: ok ? 'ok' : 'failed', exitCode: res.status })
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1
}

let lessonSyncRan = false
if (opts.lessonSync) {
  const lessonCli = resolve(new URL('./swarm-lesson-sync.mjs', import.meta.url).pathname)
  const lres = spawnSync(
    process.execPath,
    [lessonCli, ...(opts.execute ? ['--apply'] : ['--dry-run']), '--json'],
    { cwd: resolve(new URL('..', import.meta.url).pathname), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
  )
  lessonSyncRan = lres.status === 0
}

const autoCompactResults = opts.autoCompact
  ? scanAndCompactLocalSessions(opts.sessionsDir, { apply: opts.execute })
  : []

const selfImproveLessons = []
if (opts.selfImprove) {
  const failedTicks = ticks.filter((t) => t.status === 'failed' || t.status === 'deferred_5h_cap')
  if (failedTicks.length > 0 && opts.execute) {
    const lessonPath = join(opts.stateDir, '..', 'lessons', 'lesson-register.json')
    try {
      const reg = existsSync(lessonPath) ? JSON.parse(readFileSync(lessonPath, 'utf8')) : { lessons: {} }
      if (!reg.lessons || typeof reg.lessons !== 'object' || Array.isArray(reg.lessons)) reg.lessons = {}
      for (const ft of failedTicks) {
        const lid = `LES-SELF-IMPROVE-${String(ft.taskId || ft.status).toUpperCase().replace(/[^A-Z0-9_-]/g, '-')}`
        reg.lessons[lid] = {
          id: lid,
          rule: `Auto-captured from overnight tick #${ft.tick} (${ft.status}, pool=${ft.pool || 'none'}, exit=${ft.exitCode ?? 'n/a'}): inspect job timeout/provider or rotate pool before retry.`,
          updatedAt: new Date().toISOString()
        }
        selfImproveLessons.push(lid)
      }
      protectedWriteFile(lessonPath, `${JSON.stringify(reg, null, 2)}\n`)
    } catch {}
  }
}

const report = {
  ok: true,
  mode: opts.execute ? 'execute' : 'dry-run',
  stopReason,
  ticksExecuted: ticks.length,
  consecutiveFailures,
  autoDiscover: opts.autoDiscover,
  lessonSyncRan,
  autoCompact: { enabled: opts.autoCompact, results: autoCompactResults },
  selfImprove: { enabled: opts.selfImprove, staleArchived: reapedEntries, lessonsRecorded: selfImproveLessons },
  elapsedMs: Date.now() - startedAtMs,
  queueStats: queueStats(opts.queueDir),
  ticks
}
const reportPath = writeOvernightReport(opts.stateDir, report)
const output = { ...report, reportPath }
process.stdout.write(opts.json ? `${JSON.stringify(output, null, 2)}\n` : `overnight (${report.mode}): ${stopReason} after ${ticks.length} tick(s) -> ${reportPath}\n`)

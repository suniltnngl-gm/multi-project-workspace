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

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-overnight.mjs [options]
      --state-dir <dir>        Overnight state dir (ledger, STOP_SWARM, report)
      --queue-dir <dir>        Active task queue directory
      --max-ticks <n>          Max bounded ticks (default: 10)
      --max-minutes <n>        Max wall-clock minutes (default: 480)
      --max-failures <n>       Consecutive failure circuit breaker (default: 3)
      --tick-interval-sec <n>  Delay between ticks (default: 0)
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
  maxTicks: 10,
  maxMinutes: 480,
  maxFailures: 3,
  tickIntervalSec: 0,
  execute: false,
  json: false
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--execute') opts.execute = true
  else if (a === '--dry-run') opts.execute = false
  else if (a === '--state-dir') opts.stateDir = resolve(argv[++i])
  else if (a === '--queue-dir') opts.queueDir = resolve(argv[++i])
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

  const tasks = readQueue(opts.queueDir)
  const nextTask = selectNextTask(tasks)
  if (!nextTask) {
    ticks.push({ tick: ticks.length + 1, status: 'idle', reason: 'no_actionable_tasks' })
    stopReason = 'queue_idle'
    break
  }

  const pool = nextTask.pinned?.compositeKey?.split(':')[0] || nextTask.costTier || 'local-llama-cpp'
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
    [queueRunner, '--queue-dir', opts.queueDir, '--quota-pool', pool, '--calls-in-window', String(capCheck.callsInWindow), '--json'],
    { cwd: resolve(new URL('..', import.meta.url).pathname), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }
  )
  const ok = res.status === 0
  recordPoolCall(opts.stateDir, { quotaPool: pool, taskId: nextTask.taskId, status: ok ? 'ok' : `exit_${res.status}` })
  ticks.push({ tick: ticks.length + 1, taskId: nextTask.taskId, pool, status: ok ? 'ok' : 'failed', exitCode: res.status })
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1
}

const report = {
  ok: true,
  mode: opts.execute ? 'execute' : 'dry-run',
  stopReason,
  ticksExecuted: ticks.length,
  consecutiveFailures,
  elapsedMs: Date.now() - startedAtMs,
  queueStats: queueStats(opts.queueDir),
  ticks
}
const reportPath = writeOvernightReport(opts.stateDir, report)
const output = { ...report, reportPath }
process.stdout.write(opts.json ? `${JSON.stringify(output, null, 2)}\n` : `overnight (${report.mode}): ${stopReason} after ${ticks.length} tick(s) -> ${reportPath}\n`)

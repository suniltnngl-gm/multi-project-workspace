/**
 * SP-010 Overnight Watchdog & Supervisor for safe unattended swarm runs.
 *
 * Provides:
 * - Persistent 5-hour rolling pool-call ledger (JSONL) so `evaluateFiveHourCap`
 *   survives restarts and enforces `copilot=1/5h`, `agy=4/5h` across ticks.
 * - Graceful kill-switch sentinel (`STOP_SWARM` file in stateDir).
 * - Wall-clock budget (`maxDurationMs`), `maxTicks`, and consecutive-failure
 *   circuit breaker (`maxConsecutiveFailures`).
 * - Atomic overnight summary report writer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { evaluateFiveHourCap } from './burn-rate-pacer.js'

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

export function ledgerPath(stateDir) {
  return join(stateDir, 'pool-calls-5h.jsonl')
}

export function killSwitchPath(stateDir) {
  return join(stateDir, 'STOP_SWARM')
}

export function recordPoolCall(stateDir, { quotaPool, taskId = null, status = 'ok', nowMs = Date.now(), ...telemetry }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const entry = {
    quotaPool: String(quotaPool || 'unknown'),
    taskId,
    status,
    atMs: nowMs,
    at: new Date(nowMs).toISOString(),
    ...telemetry
  }
  appendFileSync(ledgerPath(stateDir), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  return entry
}

export function countPoolCallsInWindow(stateDir, quotaPool, { nowMs = Date.now(), windowMs = FIVE_HOURS_MS } = {}) {
  const file = ledgerPath(stateDir)
  if (!existsSync(file)) return 0
  const cutoff = nowMs - windowMs
  let count = 0
  for (const line of readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    try {
      const rec = JSON.parse(line)
      if (rec.quotaPool === quotaPool && Number(rec.atMs) >= cutoff && Number(rec.atMs) <= nowMs) {
        count++
      }
    } catch {}
  }
  return count
}

export function checkPoolFiveHourAdmission(stateDir, quotaPool, { nowMs = Date.now(), caps } = {}) {
  const callsInWindow = countPoolCallsInWindow(stateDir, quotaPool, { nowMs })
  return evaluateFiveHourCap({ quotaPool, callsInWindow, ...(caps ? { caps } : {}) })
}

export function evaluateOvernightGuard({
  stateDir,
  startedAtMs,
  nowMs = Date.now(),
  ticksCompleted = 0,
  maxTicks = 50,
  maxDurationMs = 8 * 60 * 60 * 1000,
  consecutiveFailures = 0,
  maxConsecutiveFailures = 3
}) {
  if (stateDir && existsSync(killSwitchPath(stateDir))) {
    return { continue: false, reason: 'kill_switch_present' }
  }
  if (ticksCompleted >= maxTicks) {
    return { continue: false, reason: `max_ticks_reached:${ticksCompleted}/${maxTicks}` }
  }
  if (nowMs - startedAtMs >= maxDurationMs) {
    return { continue: false, reason: `max_duration_reached:${Math.round((nowMs - startedAtMs) / 1000)}s` }
  }
  if (consecutiveFailures >= maxConsecutiveFailures) {
    return { continue: false, reason: `circuit_breaker_open:${consecutiveFailures}/${maxConsecutiveFailures}` }
  }
  return { continue: true, reason: 'ok' }
}

export function writeOvernightReport(stateDir, report) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const target = join(stateDir, 'overnight-report.json')
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${JSON.stringify({ ...report, writtenAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
  return target
}

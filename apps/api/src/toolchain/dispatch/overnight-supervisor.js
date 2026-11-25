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

export function ledgerLockPath(stateDir) {
  return join(stateDir, 'quota-ledger.lock.json')
}

/** Audit a rejected pool-call write so the health rollup can count it (no invented zeros). */
function auditRejectedPoolCall(stateDir, reason, lock, lease) {
  try {
    const line = `${JSON.stringify({
      event: 'pool_call_rejected',
      reason,
      holder: lock?.runId ?? null,
      generation: lock?.generation ?? null,
      expectedGeneration: lease?.generation ?? null,
      at: new Date().toISOString()
    })}\n`
    appendFileSync(join(stateDir, 'lifecycle-transitions.jsonl'), line, { encoding: 'utf8', mode: 0o600 })
  } catch { /* audit is observational */ }
}

/**
 * Append one pool call to the rolling 5h ledger.
 *
 * Generation fence (#216): when a quota-ledger lease exists on disk, the caller must hold
 * the CURRENT generation. A stale writer is refused with `stale_lease_generation` (or
 * `orchestrator_lock_held` for a different run) and the refusal is audited. A caller that
 * presents a lease while no lock exists has lost it (`lease_lost`). Single-shot operator
 * CLIs that never take the lease opt in explicitly with `unleasedOperator: true`.
 */
export function recordPoolCall(stateDir, {
  quotaPool,
  taskId = null,
  status = 'ok',
  nowMs = Date.now(),
  lease = null,
  unleasedOperator = false,
  ...telemetry
}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lockPath = ledgerLockPath(stateDir)
  let lock = null
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch { lock = null }

  if (lock && String(lock.schema || '') !== 'orchestrator-lock/v1') lock = null

  if (lock) {
    if (!lease) {
      const err = new Error(`orchestrator_lock_held:${lock.runId}`)
      auditRejectedPoolCall(stateDir, 'orchestrator_lock_held', lock, null)
      throw err
    }
    if (String(lease.runId) !== String(lock.runId)) {
      auditRejectedPoolCall(stateDir, 'orchestrator_lock_held', lock, lease)
      throw new Error(`orchestrator_lock_held:${lock.runId}`)
    }
    if (Number(lease.generation) !== Number(lock.generation)) {
      auditRejectedPoolCall(stateDir, 'stale_lease_generation', lock, lease)
      throw new Error(`stale_lease_generation:${lock.generation}:${Number(lease.generation)}`)
    }
  } else if (lease) {
    throw new Error('lease_lost:quota-ledger')
  }

  const entry = {
    quotaPool: String(quotaPool || 'unknown'),
    taskId,
    status,
    atMs: nowMs,
    at: new Date(nowMs).toISOString(),
    leaseRunId: lease?.runId ?? null,
    leaseGeneration: lease?.generation ?? null,
    unleasedOperator: Boolean(unleasedOperator),
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

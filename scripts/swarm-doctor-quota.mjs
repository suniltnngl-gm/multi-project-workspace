#!/usr/bin/env node
/**
 * Compact relay quota-status summary for `swarm doctor`.
 *
 * Deliberately pure and $0: the doctor runs before any sibling CLI is spawned, so
 * this reads only the SQLite quota store and the rolling 5h call ledger.
 * No network, no LLM, no side effects.
 *
 * #190: the relay's own view (`swarm relay quota-status`) reported every pool inline.
 * The doctor now prints one greppable summary line plus one line per eligible lane,
 * reusing the relay's budget math (`loadPoolBudgets`) so the two cannot drift apart.
 */
import { join } from 'node:path'
import { countPoolCallsInWindow } from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'

/** Short, stable reason code per pool (keeps the doctor line greppable). */
export function quotaReasonCode(b) {
  if (!b.quotaAdmitted && Number.isFinite(b.cap) && b.callsInWindow >= b.cap) return 'cap5h'
  if (!b.quotaAdmitted) return 'weekly_exhausted'
  if (b.conserve) return 'conserve'
  return 'admitted'
}

/**
 * Build the compact summary. Pure given injected inputs:
 *   stateDir     -> rolling 5h ledger root (its overnight/pool-calls-5h.jsonl)
 *   statusInfo   -> { ok, source, quota, conservePools } from readQuotaStatus
 *   budgets      -> loadPoolBudgets output
 *   countCalls / nowMs -> test seams; default to the live ledger and Date.now()
 */
export function buildRelayQuotaSummary({
  stateDir = null,
  allowConserve = false,
  statusInfo = { ok: true, source: 'sqlite', quota: {}, conservePools: [] },
  budgets = {},
  countCalls = null,
  nowMs = Date.now(),
  maxPools = 4
} = {}) {
  const dir = stateDir || join(process.env.SWARM_STATE_ROOT || join(process.env.HOME || '', '.local/state/curl-ai-bridge'), 'overnight')
  const count = typeof countCalls === 'function'
    ? countCalls
    : (pool) => countPoolCallsInWindow(dir, pool, { nowMs })

  const entries = Object.values(budgets).map((b) => {
    const callsInWindow = Number(count(b.pool)) || 0
    return {
      ...b,
      callsInWindow,
      cap: Number.isFinite(b.cap) ? b.cap : null,
      weeklyRemainingPct: Number(b.weeklyRemainingPct ?? 100),
      eligible: Boolean(b.admitted && (!b.conserve || allowConserve)),
      reasonCode: quotaReasonCode({ ...b, callsInWindow })
    }
  })

  const eligible = entries.filter((b) => b.eligible)
  const conserveCount = entries.filter((b) => b.conserve).length
  const totalCalls = entries.reduce((n, b) => n + b.callsInWindow, 0)
  const top = [...eligible].sort((a, b) => {
    if (b.weeklyRemainingPct !== a.weeklyRemainingPct) return b.weeklyRemainingPct - a.weeklyRemainingPct
    if (b.callsInWindow !== a.callsInWindow) return b.callsInWindow - a.callsInWindow
    return String(a.pool).localeCompare(String(b.pool))
  }).slice(0, maxPools)

  return {
    schema: 'relay-quota-summary/v1',
    ok: Boolean(statusInfo.ok),
    source: statusInfo.source || (statusInfo.ok ? 'sqlite' : 'fallback'),
    allowConserve: Boolean(allowConserve),
    total: entries.length,
    eligibleCount: eligible.length,
    conserveCount,
    totalCalls,
    headline: `quota: ${eligible.length}/${entries.length} eligible pools (${totalCalls} calls/5h${allowConserve ? ', allowConserve' : ''})`,
    pools: entries.map((b) => ({
      pool: b.pool,
      eligible: b.eligible,
      quotaAdmitted: Boolean(b.quotaAdmitted),
      conserve: Boolean(b.conserve),
      callsInWindow: b.callsInWindow,
      cap: b.cap,
      weeklyRemainingPct: b.weeklyRemainingPct,
      reasonCode: b.reasonCode
    })),
    top: top.map((b) => ({
      pool: b.pool,
      eligible: b.eligible,
      conserve: b.conserve,
      callsInWindow: b.callsInWindow,
      cap: b.cap,
      weeklyRemainingPct: b.weeklyRemainingPct,
      reasonCode: b.reasonCode
    }))
  }
}

/**
 * Render the doctor block. `headline` is the greppable one-liner; the following
 * lines are the highest-value eligible lanes ("(no eligible pool)" when none).
 */
export function formatRelayQuotaDoctor(summary, { indent = '  ' } = {}) {
  if (!summary || !summary.ok) return ['relay_quota: unavailable (quota store unreadable)']
  const lines = [summary.headline]
  for (const b of summary.top) {
    const cap = Number.isFinite(b.cap) ? b.cap : 'uncapped'
    lines.push(`${indent}${b.pool}: eligible=${b.eligible} conserve=${b.conserve} calls5h=${b.callsInWindow}/${cap} weekly=${b.weeklyRemainingPct}%`)
  }
  if (!summary.top.length) lines.push(`${indent}(no eligible pool)`)
  return lines
}

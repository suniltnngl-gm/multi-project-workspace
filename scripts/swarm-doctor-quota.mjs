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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statePaths } from './swarm-state-paths.mjs'
import { countPoolCallsInWindow } from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'

/** Short, stable reason code per pool (keeps the doctor line greppable). */
export function quotaReasonCode(b) {
  const cap = Number.isFinite(b.cap) ? b.cap : null
  if (cap !== null && b.callsInWindow >= cap) return 'cap5h'
  if (b.quotaAdmitted === false && Number(b.weeklyRemainingPct ?? 100) <= 0) return 'weekly_exhausted'
  if (b.conserve) return 'conserve'
  return 'admitted'
}

/**
 * One pool's `swarm relay quota-status` line. Shared by the relay's human output
 * and (via `buildRelayQuotaSummary`) the doctor, so the two views cannot diverge.
 */
export function formatQuotaStatusLine(b) {
  const cap = Number.isFinite(b.cap) ? b.cap : 'uncapped'
  return `  ${b.pool}: eligible=${b.eligible} quotaAdmitted=${b.quotaAdmitted} conserve=${b.conserve} calls5h=${b.callsInWindow}/${cap} weekly=${b.weeklyRemainingPct}% reason=${b.reason}`
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
  const dir = stateDir || statePaths().overnightDir

  const entries = Object.values(budgets).map((b) => {
    const callsInWindow = typeof countCalls === 'function'
      ? Number(countCalls(b.pool)) || 0
      : Number(countPoolCallsInWindow(dir, b.pool, { nowMs })) || 0
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
    headline: `relay_quota: ${eligible.length}/${entries.length} eligible pools (${totalCalls} calls/5h${allowConserve ? ', allowConserve' : ''})`,
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

/**
 * CLI entry: `node scripts/swarm-doctor-quota.mjs [--json] [--allow-conserve]`.
 * Prints the same block `swarm doctor` embeds. Never throws on an unreadable
 * quota store — the doctor must stay usable when SQLite is locked or absent.
 */
async function main() {
  const argv = process.argv.slice(2)
  const allowConserve = argv.includes('--allow-conserve')
  const json = argv.includes('--json')
  const stateRoot = statePaths().root

  let summary
  try {
    const { readLiveSqliteQuota, loadPoolBudgets } = await import('./swarm-quota-ring.mjs')
    // Pin the workspace root so a relocated checkout (or an isolated HOME in tests)
    // still reads the same SQLite store as `entry/swarm relay quota-status`.
    // Read-only: only sets DATABASE_PATH when the caller left it unset.
    const mpwDir = process.env.MPW_DIR || process.cwd()
    if (!process.env.DATABASE_PATH) {
      process.env.DATABASE_PATH = join(mpwDir, 'apps/api/data/workspace.sqlite')
    }
    const statusInfo = readLiveSqliteQuota()
    const budgets = loadPoolBudgets({
      countCalls: (pool) => countPoolCallsInWindow(join(stateRoot, 'overnight'), pool),
      quota: statusInfo.quota,
      conservePools: statusInfo.conservePools
    })
    summary = buildRelayQuotaSummary({ stateDir: join(stateRoot, 'overnight'), allowConserve, statusInfo, budgets })
  } catch (err) {
    summary = { ok: false, error: err.message, headline: 'relay_quota: unavailable (quota store unreadable)', top: [] }
  }

  process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatRelayQuotaDoctor(summary).join('\n')}\n`)
}

// Only run as a CLI, never when imported by a test or by swarm-relay.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}

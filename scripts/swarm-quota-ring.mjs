#!/usr/bin/env node
/**
 * Quota-aware ring slot selection (pure; no I/O, no network).
 *
 * Merges three admission layers per quota pool:
 *   1. 5h rolling cap (DEFAULT_FIVE_HOUR_CAPS / ledger counts),
 *   2. weekly/session remaining from the quota store (weeklyRemainingPct === 0 excludes),
 *   3. CONSERVE pools (excluded unless allowConserve, bounded by maxConserveWindows),
 * and for github-copilot the monthly daily-budget pacer (evaluateMonthlyDailyBudget).
 *
 * The relay owns scheduling; this module only answers "which sibling may take this
 * window, and why".
 */
import { evaluateMonthlyDailyBudget } from '../apps/api/src/toolchain/dispatch/burn-rate-pacer.js'

export const RING_PRESETS = Object.freeze({
  'tier1-ring': ['hermes', 'direct', 'gemini-api', 'opencode']
})

/** Default quota pool per relay sibling CLI. */
export const DEFAULT_SIBLING_POOL = Object.freeze({
  hermes: 'nous-hermes-free',
  direct: 'cloudflare-workers-ai',
  'gemini-api': 'gemini-api-key',
  opencode: 'opencode-tidepool-free',
  agy: 'agy-gemini',
  copilot: 'github-copilot',
  local: 'local-llama-cpp'
})

/**
 * Per-pool policy. `cap5h` mirrors DEFAULT_FIVE_HOUR_CAPS; `limitKnown: false` means
 * the provider's own daily limit is not surfaced by our tooling (no artificial cap).
 */
export const POOL_POLICY = Object.freeze({
  'github-copilot': { cap5h: 1, limitKnown: true, conserve: false, dailyBudgetPct: 3, reservePct: 10 },
  'agy-gemini': { cap5h: 4, limitKnown: true, conserve: true },
  'agy-argon': { cap5h: 4, limitKnown: true, conserve: true },
  'agy-claude-gpt': { cap5h: 4, limitKnown: true, conserve: true },
  'cloudflare-workers-ai': { cap5h: null, limitKnown: false },
  'gemini-api-key': { cap5h: null, limitKnown: true, dailyLimit: 50 },
  'opencode-tidepool-free': { cap5h: null, limitKnown: true, dailyLimit: 100 },
  'nous-hermes-free': { cap5h: null, limitKnown: false },
  'local-llama-cpp': { cap5h: null, limitKnown: false }
})

export function resolveRing(siblings, preset = null) {
  if (preset) {
    const list = RING_PRESETS[preset]
    if (!list) throw new Error(`unknown_ring_preset:${preset}`)
    return [...list]
  }
  const raw = Array.isArray(siblings) ? siblings : String(siblings ?? '').split(',')
  return raw.flatMap((s) => String(s).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean)
}

export function poolForSibling(sibling) {
  return DEFAULT_SIBLING_POOL[sibling] || null
}

/**
 * Build per-pool budgets. Pure given injected inputs:
 *   countCalls(pool) -> number   (5h ledger count; failures included by the caller)
 *   quota[pool] -> { weeklyRemainingPct }
 *   conservePools -> string[]    (from the quota strategy; merges with POOL_POLICY)
 */
export function loadPoolBudgets({
  policies = POOL_POLICY,
  countCalls = null,
  quota = {},
  conservePools = []
} = {}) {
  const budgets = {}
  for (const [pool, policy] of Object.entries(policies)) {
    const callsInWindow = countCalls ? Number(countCalls(pool) || 0) : 0
    const cap = policy.cap5h ?? null
    const conserve = Boolean(policy.conserve) || conservePools.includes(pool)
    const weeklyRemainingPct = Number(quota[pool]?.weeklyRemainingPct ?? 100)
    const capped = cap !== null && callsInWindow >= cap
    const exhausted = weeklyRemainingPct <= 0
    budgets[pool] = {
      pool,
      cap,
      callsInWindow,
      limitKnown: policy.limitKnown !== false,
      weeklyRemainingPct,
      conserve,
      dailyBudgetPct: policy.dailyBudgetPct ?? null,
      reservePct: policy.reservePct ?? null,
      admitted: !capped && !exhausted,
      reason: capped ? 'five_hour_cap_reached' : exhausted ? 'weekly_quota_exhausted' : 'admitted'
    }
  }
  return budgets
}

/** Copilot monthly daily-budget gate (3%/day, 10% reserve by policy). */
export function evaluateCopilotMonthly({
  remainingPct = null,
  daysRemaining = null,
  dailyBudgetPct = 3,
  reservePct = 10
} = {}) {
  const budget = evaluateMonthlyDailyBudget({
    quotaPool: 'github-copilot',
    remainingPct,
    daysRemaining: daysRemaining ?? 15,
    dailyBudgetPct,
    reservePct,
    callsIn5hWindow: 0
  })
  return {
    admitted: Boolean(budget.admitted),
    mode: budget.mode,
    targetFloorPct: budget.targetFloorPct,
    reason: budget.admitted ? 'within_monthly_budget' : 'monthly_budget_floor'
  }
}

/**
 * Choose the sibling for one window.
 * Deterministic: walks the ring from the roster position, substituting the next
 * admitted sibling when the preferred one is capped / exhausted / CONSERVE-excluded.
 */
export function selectSlot({
  ring,
  windowIndex = 0,
  budgets = {},
  modelMap = {},
  allowConserve = false,
  maxConserveWindows = 1,
  conserveWindowsUsed = 0,
  copilotMonthly = null
} = {}) {
  const list = Array.isArray(ring) ? ring : resolveRing(ring)
  if (!list.length) throw new Error('ring_empty')
  const preferred = list[((windowIndex % list.length) + list.length) % list.length]
  let conserveUsed = Number(conserveWindowsUsed) || 0

  for (let step = 0; step < list.length; step += 1) {
    const sibling = list[(list.indexOf(preferred) + step) % list.length]
    const pool = poolForSibling(sibling)
    const budget = budgets[pool] || {
      pool, cap: null, callsInWindow: 0, limitKnown: false, weeklyRemainingPct: 100,
      conserve: false, dailyBudgetPct: null, reservePct: null, admitted: true, reason: 'unknown_pool'
    }
    if (budget.conserve && !allowConserve) continue
    if (budget.conserve && conserveUsed >= Number(maxConserveWindows)) continue
    if (!budget.admitted) continue
    if (pool === 'github-copilot' && copilotMonthly) {
      const monthly = evaluateCopilotMonthly({
        remainingPct: copilotMonthly.remainingPct ?? null,
        daysRemaining: copilotMonthly.daysRemaining ?? null,
        dailyBudgetPct: budget.dailyBudgetPct ?? 3,
        reservePct: budget.reservePct ?? 10
      })
      if (!monthly.admitted) continue
    }
    return {
      sibling,
      pool,
      model: modelMap[sibling] || null,
      substitutedFor: sibling === preferred ? null : preferred,
      conserve: Boolean(budget.conserve),
      conserveWindowsUsed: conserveUsed + (budget.conserve ? 1 : 0),
      admitted: true,
      reason: sibling === preferred ? 'roster' : `substitute_for:${preferred}`
    }
  }

  return {
    sibling: preferred,
    pool: poolForSibling(preferred),
    model: modelMap[preferred] || null,
    substitutedFor: null,
    conserve: false,
    conserveWindowsUsed: conserveUsed,
    admitted: false,
    reason: 'no_admitted_pool'
  }
}

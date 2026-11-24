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
import { createDatabase } from '../apps/api/src/database.js'
import { createModelBudget } from '../apps/api/src/modelBudget.js'
import { createModelRegistry, modelQuotaProfiles } from '../apps/api/src/modelRegistry.js'
import { buildQuotaReport } from './ai-quota.mjs'
import { ROOT_DIR, resolveDatabasePath } from './env.mjs'

export const RING_PRESETS = Object.freeze({
  'tier1-ring': ['hermes', 'direct', 'gemini-api', 'opencode'],
  'k5-pipeline-ring': ['hermes', 'direct', 'gemini-api', 'direct-vercel', 'guest']
})

export const PIPELINE_JOBS = Object.freeze([
  'discover',
  'case-solve',
  'build',
  'review',
  'publish'
])

/** Default quota pool per relay sibling CLI. */
export const DEFAULT_SIBLING_POOL = Object.freeze({
  hermes: 'nous-hermes-free',
  direct: 'cloudflare-workers-ai',
  'direct-vercel': 'vercel-ai-gateway',
  'gemini-api': 'gemini-api-key',
  opencode: 'opencode-tidepool-free',
  agy: 'agy-gemini',
  copilot: 'github-copilot',
  local: 'local-llama-cpp',
  guest: 'github-copilot',
  cline: 'cline-free',
  vibe: 'mistral-vibe',
  codex: 'codex-exec'
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
  'vercel-ai-gateway': { cap5h: null, limitKnown: false },
  'gemini-api-key': { cap5h: null, limitKnown: true, dailyLimit: 50 },
  'opencode-tidepool-free': { cap5h: null, limitKnown: true, dailyLimit: 100 },
  'nous-hermes-free': { cap5h: null, limitKnown: false },
  'local-llama-cpp': { cap5h: null, limitKnown: false },
  // Added in #205 after live headless validation (sibling-validation matrix, 2026-11-24):
  // each CLI's own provider quota is not surfaced by our tooling, so no artificial cap.
  'cline-free': { cap5h: null, limitKnown: false },
  'mistral-vibe': { cap5h: null, limitKnown: false },
  'codex-exec': { cap5h: null, limitKnown: false }
})

/**
 * Load live weekly/5h remaining percentages and CONSERVE flags directly from the
 * workspace SQLite database (`apps/api/data/workspace.sqlite`) via `createModelBudget`
 * and `buildQuotaReport`. Never makes network or LLM calls.
 */
export function readLiveSqliteQuota({ databasePath = null, env = process.env } = {}) {
  try {
    const dbPath = databasePath || resolveDatabasePath({ explicitPath: null, rootDir: ROOT_DIR, env })
    const db = createDatabase(dbPath)
    const models = createModelRegistry({ env })
    const budget = createModelBudget({
      env,
      repository: db,
      profiles: modelQuotaProfiles(models)
    })
    const report = buildQuotaReport(budget, env)
    try { db.close?.() } catch {}

    const quota = {}
    const conserveSet = new Set()
    const mapTargetToPool = (target) => {
      const t = String(target || '')
      if (t.includes('claude')) return 'agy-claude-gpt'
      if (t.includes('argon')) return 'agy-argon'
      if (t.startsWith('agy@') || t === 'agy') return 'agy-gemini'
      if (t.startsWith('gemini-api')) return 'gemini-api-key'
      if (t.startsWith('opencode')) return 'opencode-tidepool-free'
      return null
    }

    for (const p of report.agyPools || []) {
      const pool = mapTargetToPool(p.target)
      if (!pool) continue
      const weeklyRemainingPct = p.weekly?.remainingPct ?? (p.ok ? 100 : 0)
      const sessionRemainingPct = p.session5h?.remainingPct ?? (p.ok ? 100 : 0)
      quota[pool] = {
        weeklyRemainingPct: p.ok ? Number(weeklyRemainingPct) : 0,
        sessionRemainingPct: Number(sessionRemainingPct),
        aheadOfPace: Boolean(p.aheadOfPace),
        ok: Boolean(p.ok),
        roleAdvice: p.roleAdvice || null
      }
      if (p.aheadOfPace || !p.ok) conserveSet.add(pool)
    }
    for (const t of report.strategy?.conservePools || []) {
      const pool = mapTargetToPool(t)
      if (pool) conserveSet.add(pool)
    }
    return { ok: true, source: 'sqlite', databasePath: dbPath, quota, conservePools: [...conserveSet] }
  } catch (err) {
    return { ok: false, source: 'fallback', error: err.message, quota: {}, conservePools: [] }
  }
}

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
    const quotaAdmitted = !capped && !exhausted
    const eligible = quotaAdmitted && !conserve
    budgets[pool] = {
      pool,
      cap,
      callsInWindow,
      limitKnown: policy.limitKnown !== false,
      weeklyRemainingPct,
      conserve,
      dailyBudgetPct: policy.dailyBudgetPct ?? null,
      reservePct: policy.reservePct ?? null,
      admitted: quotaAdmitted,
      quotaAdmitted,
      eligible,
      reason: capped
        ? 'five_hour_cap_reached'
        : exhausted
          ? 'weekly_quota_exhausted'
          : conserve
            ? 'conserve_excluded_by_default'
            : 'admitted'
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
 * Deterministic candidate order for the virtual `guest` roster slot.
 *
 * Order: `copilot` on its cadence round, then `agy` when CONSERVE admission is
 * allowed, then the live roster siblings in ring order (so a stage never resolves
 * to the resource-gated `local` dry-run default while a real CLI is available),
 * and finally `$0` `local`/`hermes` as the last resort.
 */
export function guestFallbackCandidates({ list, round = null, allowConserve = false, copilotCadenceRound = 6 } = {}) {
  const ring = Array.isArray(list) ? list : resolveRing(list)
  const currentRound = round ?? 1
  const out = []
  if (copilotCadenceRound > 0 && currentRound % copilotCadenceRound === 0) out.push('copilot')
  if (allowConserve) out.push('agy')
  const pos = ring.indexOf('guest')
  if (pos >= 0) {
    for (let step = 1; step < ring.length; step += 1) {
      const candidate = ring[(pos + step) % ring.length]
      if (candidate !== 'guest' && !out.includes(candidate)) out.push(candidate)
    }
  }
  for (const fallback of ['local', 'hermes']) {
    if (!out.includes(fallback)) out.push(fallback)
  }
  return out
}

/**
 * Choose the sibling for one window.
 * Deterministic: walks the ring from the roster position, substituting the next
 * admitted sibling when the preferred one is capped / exhausted / CONSERVE-excluded.
 */
export function selectSlot({
  ring,
  windowIndex = 0,
  round = null,
  budgets = {},
  modelMap = {},
  allowConserve = false,
  maxConserveWindows = 1,
  conserveWindowsUsed = 0,
  copilotMonthly = null,
  copilotCadenceRound = 6
} = {}) {
  const list = Array.isArray(ring) ? ring : resolveRing(ring)
  if (!list.length) throw new Error('ring_empty')
  const preferred = list[((windowIndex % list.length) + list.length) % list.length]
  const currentRound = round ?? (Math.floor(windowIndex / list.length) + 1)
  let conserveUsed = Number(conserveWindowsUsed) || 0

  // Resolve virtual `guest` slot (`W5` in `k5-pipeline-ring`):
  //   1. On `copilotCadenceRound` (default Round 6, or multiples of 6), try `copilot` if admitted + monthly budget allows
  //   2. If `allowConserve` is enabled and within `maxConserveWindows`, try `agy`
  //   3. Otherwise try the live roster siblings in ring order, then `$0` `local`/`hermes`
  if (preferred === 'guest') {
    const guestCandidates = guestFallbackCandidates({ list, round: currentRound, allowConserve, copilotCadenceRound })
    for (const candidate of guestCandidates) {
      const pool = poolForSibling(candidate)
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
        sibling: candidate,
        pool,
        model: modelMap[candidate] || modelMap.guest || null,
        substitutedFor: candidate === 'copilot' ? null : 'guest',
        conserve: Boolean(budget.conserve),
        conserveWindowsUsed: conserveUsed + (budget.conserve ? 1 : 0),
        admitted: true,
        reason: `guest_slot_r${currentRound}:${candidate}`
      }
    }
  }

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

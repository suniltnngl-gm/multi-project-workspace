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
  // W3 build needs real workspace write tools; cline runs with --yolo in build windows.
  // hermes stays at W1 so the virtual W5 guest slot falls back to a tool-capable publisher.
  'k5-pipeline-ring': ['hermes', 'direct', 'cline', 'direct-vercel', 'guest']
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
  'opencode-google': 'opencode-console-google',
  'opencode-nvidia': 'opencode-console-nvidia',
  'opencode-openrouter': 'opencode-console-openrouter',
  'opencode-groq': 'opencode-console-groq',
  'opencode-vercel': 'opencode-vercel-ai-gateway',
  agy: 'agy-gemini',
  copilot: 'github-copilot',
  local: 'local-llama-cpp',
  guest: 'github-copilot',
  cline: 'cline-free',
  vibe: 'mistral-vibe',
  codex: 'codex-exec'
})

/** All 6 OpenCode quota pools (in rotation order). */
export const OPENCODE_POOLS = Object.freeze([
  'opencode-tidepool-free',
  'opencode-console-google',
  'opencode-console-nvidia',
  'opencode-console-openrouter',
  'opencode-console-groq',
  'opencode-vercel-ai-gateway'
])

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
  'opencode-console-google': { cap5h: null, limitKnown: true, dailyLimit: 100 },
  'opencode-console-nvidia': { cap5h: null, limitKnown: false },
  'opencode-console-openrouter': { cap5h: null, limitKnown: false },
  'opencode-console-groq': { cap5h: null, limitKnown: false },
  'opencode-vercel-ai-gateway': { cap5h: null, limitKnown: false },
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

/** SWARM-BACKOFF-RING-001: unified all-entity roster with per-role capabilities. */
export const ENTITY_ROSTER = Object.freeze({
  hermes: { pool: 'nous-hermes-free', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  direct: { pool: 'cloudflare-workers-ai', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'direct-vercel': { pool: 'vercel-ai-gateway', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'gemini-api': { pool: 'gemini-api-key', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  cline: { pool: 'cline-free', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  vibe: { pool: 'mistral-vibe', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  codex: { pool: 'codex-exec', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  opencode: { pool: 'opencode-tidepool-free', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'opencode-vercel': { pool: 'vercel-ai-gateway', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'opencode-google': { pool: 'opencode-console-google', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'opencode-nvidia': { pool: 'opencode-console-nvidia', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'opencode-openrouter': { pool: 'opencode-console-openrouter', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  'opencode-groq': { pool: 'opencode-console-groq', roles: ['discover', 'case-solve', 'build', 'review', 'publish'], canEdit: true },
  agy: { pool: 'agy-gemini', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  'agy-argon': { pool: 'agy-argon', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  'agy-claude-gpt': { pool: 'agy-claude-gpt', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  copilot: { pool: 'github-copilot', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  local: { pool: 'local-llama-cpp', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  colab: { pool: 'colab-free', roles: ['discover', 'case-solve', 'review'], canEdit: false },
  kaggle: { pool: 'kaggle-free', roles: ['discover', 'case-solve', 'review'], canEdit: false },
})

export const ALL_ENTITIES = Object.freeze(Object.keys(ENTITY_ROSTER))
export const FILE_EDITING_ENTITIES = Object.freeze(ALL_ENTITIES.filter((e) => ENTITY_ROSTER[e].canEdit))
export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_MAX_MS = 8 * 60_000
export const BACKOFF_CAP_COUNT = 4
export function entityBackoffDelayMs(backoffCount = 0) {
  const count = Number(backoffCount || 0)
  if (!Number.isFinite(count) || count <= 0) return 0
  const delay = BACKOFF_BASE_MS * Math.pow(2, count - 1)
  return Math.min(delay, BACKOFF_MAX_MS)
}
export function createBackoffState() { return {} }
export function recordEntityFailure(backoffState, entity, { error = null, nowMs = Date.now() } = {}) {
  const prev = backoffState[entity] || { backoffCount: 0, lastError: null, lastFailureAtMs: null, nextEligibleAtMs: 0 }
  const count = Number(prev.backoffCount || 0) + 1
  const delay = entityBackoffDelayMs(count)
  backoffState[entity] = { backoffCount: count, lastError: error ?? null, lastFailureAtMs: nowMs, nextEligibleAtMs: nowMs + delay }
  return backoffState[entity]
}
export function recordEntitySuccess(backoffState, entity) {
  backoffState[entity] = { backoffCount: 0, lastError: null, lastFailureAtMs: null, nextEligibleAtMs: 0 }
  return backoffState[entity]
}
export function isEntityInBackoff(backoffState, entity, nowMs = Date.now()) {
  const st = backoffState[entity]
  if (!st) return false
  return Number(st.nextEligibleAtMs || 0) > nowMs
}
export function filterEligibleEntities(backoffState, entities, nowMs = Date.now()) {
  const eligible = []
  const backedOff = []
  for (const entity of entities) {
    if (isEntityInBackoff(backoffState, entity, nowMs)) backedOff.push(entity)
    else eligible.push(entity)
  }
  return { eligible, backedOff }
}
export function allEntitiesInBackoff(backoffState, entities, nowMs = Date.now()) {
  let earliest = null
  let earliestEntity = null
  for (const entity of entities) {
    const st = backoffState[entity]
    if (!st) return { allInBackoff: false }
    const next = Number(st.nextEligibleAtMs || 0)
    if (next <= nowMs) return { allInBackoff: false }
    if (earliest === null || next < earliest) { earliest = next; earliestEntity = entity }
  }
  return { allInBackoff: true, earliestNextEligibleAtMs: earliest, earliestEntity }
}
export function filterEntitiesByJob(entities, job = null) {
  if (!job || job === 'discover' || job === 'case-solve' || job === 'review' || job === 'publish') return [...entities]
  if (job === 'build') return entities.filter((e) => ENTITY_ROSTER[e]?.canEdit === true)
  return [...entities]
}
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
  copilotCadenceRound = 6,
  backoff = {},
  nowMs = null,
  job = null,
} = {}) {
  const list = Array.isArray(ring) ? ring : resolveRing(ring)
  if (!list.length) throw new Error('ring_empty')
  const now = nowMs ?? Date.now()
  const preferred = list[((windowIndex % list.length) + list.length) % list.length]
  const currentRound = round ?? (Math.floor(windowIndex / list.length) + 1)
  let conserveUsed = Number(conserveWindowsUsed) || 0

  // Per-role capability filtering: W3 build restricted to file-editing entities.
  const capable = filterEntitiesByJob(list, job)
  const capableSet = new Set(capable)

  // Fail-closed: every job-capable entity in the ring is in backoff → report earliest nextEligibleAtMs.
  const allBackoff = allEntitiesInBackoff(backoff, capable, now)
  if (allBackoff.allInBackoff) {
    return {
      sibling: null,
      pool: null,
      model: null,
      substitutedFor: null,
      conserve: false,
      conserveWindowsUsed: conserveUsed,
      admitted: false,
      reason: 'all_entities_in_backoff',
      earliestNextEligibleAtMs: allBackoff.earliestNextEligibleAtMs,
      earliestEntity: allBackoff.earliestEntity,
    }
  }

  // Resolve virtual `guest` slot (`W5` in `k5-pipeline-ring`):
  //   1. On `copilotCadenceRound` (default Round 6, or multiples of 6), try `copilot` if admitted + monthly budget allows
  //   2. If `allowConserve` is enabled and within `maxConserveWindows`, try `agy`
  //   3. Otherwise try the live roster siblings in ring order, then `$0` `local`/`hermes`
  if (preferred === 'guest') {
    const guestCandidates = guestFallbackCandidates({ list, round: currentRound, allowConserve, copilotCadenceRound })
    for (const candidate of guestCandidates) {
      if (job === 'build' && ENTITY_ROSTER[candidate]?.canEdit !== true) continue
      if (isEntityInBackoff(backoff, candidate, now)) continue
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
    if (!capableSet.has(sibling)) continue
    if (isEntityInBackoff(backoff, sibling, now)) continue
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

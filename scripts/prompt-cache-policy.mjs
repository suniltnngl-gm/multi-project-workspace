#!/usr/bin/env node
/**
 * Per-pool prompt-cache policy (CACHE-C-314).
 *
 * Providers differ in whether they offer prefix caching, its TTL, and which
 * models are eligible. The relay uses this module for two things:
 *  1. Advisory telemetry: each window report carries a cacheAdvisory so the
 *     measure loop can see which pools/models were cache-eligible.
 *  2. Scheduling: warmReturnWithinTtl tells the overnight loop whether
 *     returning to the same pool after an idle gap still lands inside the
 *     cache window (cheap re-warm) or past it (full-price cold call).
 *
 * Evidence (verified 2026-11-28, Groq docs prompt-caching page):
 *  - groq prompt caching: automatic, 50% cached-input discount, exact prefix
 *    match, sliding TTL = 2 hours without use, ONLY openai/gpt-oss-20b,
 *    gpt-oss-120b, gpt-oss-safeguard-20b.
 *  - all other pools: no published cache contract => cacheUnknown, never
 *    assume a benefit (free pools: cache buys latency only, not cost).
 */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

const GPT_OSS_PATTERN = /gpt-oss-(20b|120b|safeguard-20b)$/

/**
 * pool key -> profile. Keys match the quota-pool names used by recordPoolCall
 * and the sibling tokens in swarm-measure SIBLING_TOKENS. A pool absent here
 * (or with profile.cacheable === false) is treated as cacheUnknown.
 */
export const POOL_CACHE_PROFILES = Object.freeze({
  'console-groq': Object.freeze({
    provider: 'groq',
    cacheable: true,
    ttlMs: TWO_HOURS_MS,
    sliding: true,
    discount: 0.5,
    cacheableModelPattern: GPT_OSS_PATTERN
  }),
  'opencode-console-groq': Object.freeze({
    provider: 'groq',
    cacheable: true,
    ttlMs: TWO_HOURS_MS,
    sliding: true,
    discount: 0.5,
    cacheableModelPattern: GPT_OSS_PATTERN
  }),
  // Cloudflare Workers AI: no published prompt-cache contract (verified 2026-11-28) —
  // explicitly NOT cacheable rather than unknown.
  'cloudflare-workers-ai': Object.freeze({
    provider: 'cloudflare',
    cacheable: false,
    reason: 'pool_no_published_cache_contract'
  })
})
// Pools left out of the map (nous-hermes-free, vercel-ai-gateway, graphn-ai,
// gemini-api-key, opencode-console-{google,nvidia,openrouter}, agy-*, github-copilot,
// mistral-vibe, codex-exec, local-llama-cpp, cline-free) have no published cache
// contract on this deployment: cacheAdvisory reports cacheUnknown=true. Never
// schedule for cache savings on a cacheUnknown pool; measure first (task #313
// harvests opencode tokens.cache; swarm-direct surfaces provider usage).

/**
 * Advisory for one attempt. Returns a plain JSON-able object:
 *  - cacheEligible: true only when the pool publishes a cache contract AND the
 *    model is in its eligible set.
 *  - cacheUnknown: true when the pool has no published contract (never assume).
 *  - warmReturnWithinTtl: when lastAttemptAt is given, whether a return call
 *    now would still land inside the sliding TTL window.
 */
export function cacheAdvisory({ pool, model, lastAttemptAt = null, now = null } = {}) {
  const profile = pool ? POOL_CACHE_PROFILES[pool] : null
  if (!profile || !profile.cacheable) {
    return {
      pool: pool || null,
      model: model || null,
      cacheEligible: false,
      cacheUnknown: true,
      ...(profile && !profile.cacheable && profile.reason ? { reason: profile.reason } : {})
    }
  }
  const modelEligible = Boolean(model) && profile.cacheableModelPattern.test(String(model))
  const advisory = {
    pool,
    model: model || null,
    cacheEligible: modelEligible,
    cacheUnknown: false,
    ttlMs: profile.ttlMs,
    sliding: profile.sliding,
    discount: profile.discount
  }
  if (!modelEligible) advisory.reason = 'model_not_in_cacheable_set'
  if (lastAttemptAt) {
    const lastMs = Date.parse(lastAttemptAt)
    const nowMs = now ? Date.parse(now) : Date.now()
    advisory.lastAttemptAt = lastAttemptAt
    advisory.warmReturnWithinTtl = Number.isFinite(lastMs) && Number.isFinite(nowMs)
      ? (nowMs - lastMs) < profile.ttlMs
      : null
  }
  return advisory
}

import { parseIsoStrict } from './portability.js'

export const DEFAULT_COOLDOWNS_MS = Object.freeze({
  unavailable_503: 5 * 60 * 1000,
  rate_limited: 60 * 1000,
  unavailable: 15 * 60 * 1000
})
export const MAX_COOLDOWN_BACKOFF_MS = 30 * 60 * 1000
const SCOPES = new Set(['model', 'provider', 'gateway', 'quotaPool'])

function cooldownDurationMs(o) {
  if (typeof o.retryAfterMs === 'number' && o.retryAfterMs >= 0) return o.retryAfterMs
  const base = DEFAULT_COOLDOWNS_MS[o.kind]
  if (base === undefined) return 0
  const n = Number.isInteger(o.consecutive) && o.consecutive > 1 ? o.consecutive : 1
  return Math.min(base * 2 ** (n - 1), MAX_COOLDOWN_BACKOFF_MS)
}

/**
 * Timestamped availability observations -> per scope:target state. Latest observation wins;
 * a latest `ok` clears any cooldown. Cooldown = explicit cooldownUntil, else retryAfterMs,
 * else default per kind with exponential backoff by `consecutive`, capped at 30 minutes.
 */
export function assessAvailability(observations = [], nowMs) {
  const warnings = []
  const latest = new Map()
  for (const o of Array.isArray(observations) ? observations : []) {
    const scope = o?.scope
    const target = o?.target === undefined || o?.target === null ? null : String(o.target)
    if (!SCOPES.has(scope) || !target) continue
    const at = parseIsoStrict(o.observedAt)
    if (at === null) {
      warnings.push(`invalid_timestamp:providerObservations.${scope}:${target}.observedAt`)
      continue
    }
    const key = `${scope}:${target}`
    const prev = latest.get(key)
    if (!prev || at >= prev.at) latest.set(key, { o, at, scope, target })
  }
  const entries = new Map()
  for (const [key, { o, at, scope, target }] of latest) {
    let untilMs = null
    if (o.kind !== 'ok') {
      if (o.cooldownUntil !== undefined && o.cooldownUntil !== null) {
        untilMs = parseIsoStrict(o.cooldownUntil)
        if (untilMs === null) warnings.push(`invalid_timestamp:providerObservations.${key}.cooldownUntil`)
      }
      if (untilMs === null) untilMs = at + cooldownDurationMs(o)
    }
    const cooling = untilMs !== null && untilMs > nowMs
    entries.set(key, {
      scope,
      target,
      state: cooling ? 'cooling_down' : 'available',
      cooldownUntil: cooling ? new Date(untilMs).toISOString() : null,
      cooldownUntilMs: cooling ? untilMs : null
    })
  }
  const list = [...entries.values()]
    .sort((a, b) => (a.scope + a.target).localeCompare(b.scope + b.target))
    .map(({ scope, target, state, cooldownUntil }) => ({ scope, target, state, cooldownUntil }))
  return { entries, list, warnings }
}

/** Returns the cooling entry for scope:target, or null when available/unknown. */
export function isCoolingDown(entries, scope, target) {
  if (target === null || target === undefined) return null
  const e = entries.get(`${scope}:${target}`)
  return e && e.state === 'cooling_down' ? e : null
}

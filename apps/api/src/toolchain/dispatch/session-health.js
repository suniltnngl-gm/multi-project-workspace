import { parseIsoStrict } from './portability.js'

export const SESSION_HEALTH_STATES = Object.freeze(['healthy', 'degraded', 'unresumable', 'expired', 'unknown'])
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_HEALTH_OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * Pure session health assessment. Priority: unresumable > expired > degraded > healthy > unknown.
 * Expiry precedence: a valid explicit `expiresAt` decides alone (a future expiresAt beats
 * lastUsedAt + TTL); only without expiresAt is lastUsedAt + sessionTtlMs applied.
 * `health` is a timestamped observation: stale observations revert to unknown.
 * `status: retired` is a hard fact and is not subject to staleness.
 */
export function assessSessionHealth(session, nowMs, {
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  healthMaxAgeMs = DEFAULT_HEALTH_OBSERVATION_MAX_AGE_MS
} = {}) {
  const invalidTimestamps = []
  const status = String(session?.status ?? '')
  const h = session?.health && typeof session.health === 'object' ? session.health : null
  let healthState = null
  let observedAt = null
  if (h) {
    const at = parseIsoStrict(h.observedAt)
    if (at === null) invalidTimestamps.push('health.observedAt')
    else {
      observedAt = new Date(at).toISOString()
      if (nowMs - at <= healthMaxAgeMs) healthState = h.state
    }
  }
  const result = (state, reason) => ({ state, reason, observedAt, invalidTimestamps })

  if (status === 'retired') return result('unresumable', 'status_retired')
  if (healthState === 'unresumable') return result('unresumable', 'health_unresumable')

  let expiresMs = null
  if (session?.expiresAt !== undefined && session?.expiresAt !== null) {
    expiresMs = parseIsoStrict(session.expiresAt)
    if (expiresMs === null) invalidTimestamps.push('expiresAt')
  }
  if (expiresMs !== null) {
    if (expiresMs <= nowMs) return result('expired', 'expires_at_elapsed')
  } else if (session?.lastUsedAt !== undefined && session?.lastUsedAt !== null) {
    const last = parseIsoStrict(session.lastUsedAt)
    if (last === null) invalidTimestamps.push('lastUsedAt')
    else if (last + sessionTtlMs < nowMs) return result('expired', 'ttl_elapsed')
  }

  if (status === 'interrupted') return result('degraded', 'status_interrupted')
  if (healthState === 'degraded') return result('degraded', 'health_degraded')
  if (healthState === 'healthy') return result('healthy', 'health_healthy')
  return result('unknown', 'no_health_signal')
}

export const SESSION_POOL_DISPATCH_SCHEMA_VERSION = 'session-pool-dispatch/v1.0'

const REUSABLE_STATUSES = new Set(['idle', 'active'])
const DISPATCH_MODES = new Set(['fallback', 'round-robin', 'parallel'])
const HEALTH_RANK = { healthy: 0, unknown: 0, low: 1, scarce: 2 }
const LOW_PCT = 25
const SCARCE_PCT = 10
export const DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000

const norm = (v) => (v === undefined || v === null ? null : String(v))

function cacheStateOf(session) {
  return session.cacheState || session.observed?.cacheState || 'unknown'
}

/** Effective quota pool: explicit quotaPool, else provider, else cli, else 'unknown'. */
export function quotaPoolOf(entity, cliFallback = null) {
  return norm(entity?.quotaPool) ?? norm(entity?.provider) ?? norm(entity?.cli) ?? norm(cliFallback) ?? 'unknown'
}

function rolesOf(session) {
  const list = Array.isArray(session.roles) ? session.roles : []
  const all = [...list, session.role].map(norm).filter(Boolean)
  return new Set(all)
}

function modeAllowed(session, mode) {
  return !Array.isArray(session.dispatchModes) || session.dispatchModes.length === 0 || session.dispatchModes.includes(mode)
}

/**
 * Timestamped quota observations -> per-pool health. Observations are point-in-time
 * facts: the latest one per pool wins and anything older than maxAgeMs is stale (ignored).
 */
export function assessQuotaPools(observations = [], nowMs, maxAgeMs = DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS) {
  const latest = new Map()
  for (const o of Array.isArray(observations) ? observations : []) {
    const pool = norm(o?.quotaPool)
    const at = Date.parse(o?.observedAt)
    if (!pool || Number.isNaN(at)) continue
    const prev = latest.get(pool)
    if (!prev || at > prev.at) latest.set(pool, { o, at })
  }
  const out = new Map()
  for (const [pool, { o, at }] of latest) {
    const stale = nowMs - at > maxAgeMs
    let health = 'unknown'
    if (!stale) {
      const pcts = [o.weeklyRemainingPct, o.fiveHourRemainingPct].filter((n) => typeof n === 'number')
      const min = pcts.length ? Math.min(...pcts) : null
      if (norm(o.policy) === 'conserve' || (min !== null && min <= SCARCE_PCT)) health = 'scarce'
      else if (min !== null && min <= LOW_PCT) health = 'low'
      else if (min !== null || o.policy) health = 'healthy'
    }
    out.set(pool, { quotaPool: pool, health, observedAt: new Date(at).toISOString(), stale })
  }
  return out
}

function isCompatible(session, want, mode) {
  if (!REUSABLE_STATUSES.has(String(session.status || 'idle'))) return false
  if (!rolesOf(session).has(want.role)) return false
  if (norm(session.cli) !== want.cli) return false
  if (norm(session.repository) !== want.repository) return false
  if (want.gateway !== null && norm(session.gateway) !== want.gateway) return false
  if (want.provider !== null && norm(session.provider) !== want.provider) return false
  if (want.quotaPool !== null && quotaPoolOf(session) !== want.quotaPool) return false
  if (!modeAllowed(session, mode)) return false
  return norm(session.model) === want.model
}

function lastUsedMs(session) {
  const t = Date.parse(session.lastUsedAt)
  return Number.isNaN(t) ? 0 : t
}

function pickBest(sessions, want, mode, pools) {
  const rank = (s) => HEALTH_RANK[pools.get(quotaPoolOf(s))?.health || 'unknown']
  const scored = sessions
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s && isCompatible(s, want, mode))
    .map(({ s, index }) => ({
      s,
      key: [
        rank(s),
        mode === 'round-robin' ? lastUsedMs(s) : 0,
        cacheStateOf(s) === 'warm_observed' ? 0 : 1,
        mode === 'parallel' && String(s.status) === 'active' ? 1 : 0,
        index
      ]
    }))
  scored.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]
    return 0
  })
  if (!scored.length) return null
  return { session: scored[0].s, alternatives: scored.length - 1, rank: scored[0].key[0] }
}

export function resolveDispatchTarget({
  sessions = [],
  request = {},
  unavailableModels = [],
  fallbackCandidates = [],
  quotaObservations = [],
  quotaObservationMaxAgeMs = DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS,
  now = () => Date.now()
} = {}) {
  const nowMs = typeof now === 'function' ? now() : Date.now()
  const mode = norm(request.dispatchMode) ?? 'fallback'
  const want = {
    role: norm(request.role),
    repository: norm(request.repository),
    cli: norm(request.cli),
    gateway: norm(request.gateway),
    provider: norm(request.provider),
    model: norm(request.model),
    quotaPool: norm(request.quotaPool),
    workItem: norm(request.workItem)
  }
  const decidedAt = new Date(nowMs).toISOString()
  const routingKey = [want.role, want.repository, want.cli, want.gateway, want.provider, want.model, want.quotaPool]
    .map((v) => v ?? '*')
    .join('|')
  const unavailable = new Set(unavailableModels.map(String))
  const pool = [...sessions, ...fallbackCandidates.filter((c) => c && c.sessionId)]
  const pools = assessQuotaPools(quotaObservations, nowMs, quotaObservationMaxAgeMs)
  const primaryPool = want.quotaPool ?? quotaPoolOf(want)
  const reasons = []
  const consideredPools = new Set()

  const describePool = (name) => {
    const a = pools.get(name)
    return { quotaPool: name, health: a?.health || 'unknown', observedAt: a?.observedAt ?? null, stale: a?.stale ?? false }
  }

  const plan = (action, selectedSession, fallbackUsed) => {
    if (selectedSession) consideredPools.add(selectedSession.quotaPool)
    consideredPools.add(primaryPool)
    return {
      schemaVersion: SESSION_POOL_DISPATCH_SCHEMA_VERSION,
      mode: 'plan',
      readOnly: true,
      decidedAt,
      action,
      selectedSession,
      fallbackUsed,
      routingKey,
      dispatchMode: DISPATCH_MODES.has(mode) ? mode : 'fallback',
      quotaAssessment: [...consideredPools].sort().map(describePool),
      cliArtifactBoundary: { cli: want.cli ?? 'unknown', mergeNativeArtifacts: false },
      reasons
    }
  }

  const descriptor = (session, w, model) => {
    const cli = w.cli
    const sessionId = session ? norm(session.sessionId) : null
    return {
      compositeKey: session ? `${cli}:${sessionId ?? ''}` : null,
      sessionId,
      cli,
      role: w.role,
      repository: w.repository,
      gateway: session ? norm(session.gateway) : w.gateway,
      provider: session ? norm(session.provider) : w.provider,
      model,
      quotaPool: session ? quotaPoolOf(session) : (w.quotaPool ?? quotaPoolOf(w)),
      cacheState: session ? cacheStateOf(session) : 'unknown'
    }
  }

  const noteReuse = (hit) => {
    reasons.push(`matched_composite_key:${want.cli}:${norm(hit.session.sessionId)}`)
    if (cacheStateOf(hit.session) === 'warm_observed') reasons.push('preferred_warm_observed')
    const name = quotaPoolOf(hit.session)
    const a = pools.get(name)
    if (a) reasons.push(`quota_pool_${a.health}:${name}@${a.observedAt}`)
    if (hit.rank === 0 && hit.alternatives > 0) reasons.push('quota_pool_healthy_preferred')
    if (hit.rank >= 2) reasons.push(`scarce_pool_reused_no_healthier_alternative:${name}`)
    if (mode !== 'fallback') reasons.push(`dispatch_mode:${mode}`)
  }

  if (!want.role || !want.cli || !want.model) {
    reasons.push('invalid_request:role_cli_model_required')
    return plan('blocked', null, false)
  }
  if (!DISPATCH_MODES.has(mode)) {
    reasons.push(`invalid_request:unknown_dispatch_mode:${mode}`)
    return plan('blocked', null, false)
  }

  if (!unavailable.has(want.model)) {
    const hit = pickBest(pool, want, mode, pools)
    if (hit) {
      for (const s of pool) consideredPools.add(quotaPoolOf(s))
      noteReuse(hit)
      return plan('reuse_session', descriptor(hit.session, want, want.model), false)
    }
    reasons.push('no_compatible_session:role_isolation_and_model_pinning_enforced')
    return plan('create_session', descriptor(null, want, want.model), false)
  }

  reasons.push(`primary_model_unavailable:${want.model}`)
  const prepared = fallbackCandidates
    .map((cand, index) => ({ cand, index, model: norm(cand?.model) }))
    .filter(({ model }) => model && !unavailable.has(model) && model !== want.model)
    .map((c) => {
      const candPool = norm(c.cand.quotaPool) ?? norm(c.cand.provider) ?? primaryPool
      return { ...c, candPool, independent: candPool !== primaryPool, health: HEALTH_RANK[pools.get(candPool)?.health || 'unknown'] }
    })
    .sort((a, b) => Number(!a.independent) - Number(!b.independent) || a.health - b.health || a.index - b.index)

  const top = prepared[0]
  if (!top) {
    reasons.push('no_fallback_candidate_available')
    return plan('blocked', null, false)
  }
  for (const c of prepared) consideredPools.add(c.candPool)
  const { cand, model } = top
  const fbWant = {
    ...want,
    model,
    quotaPool: norm(cand.quotaPool),
    provider: norm(cand.provider) ?? (cand.quotaPool ? null : want.provider),
    gateway: norm(cand.gateway) ?? (cand.quotaPool ? null : want.gateway)
  }
  reasons.push(top.independent ? `fallback_independent_quota_pool:${top.candPool}` : `fallback_shares_quota_pool:${top.candPool}`)
  const hit = pickBest(pool, fbWant, mode, pools)
  if (hit) {
    reasons.push(`fallback_session_reused:${model}`, 'model_not_switched')
    return plan('reuse_session', descriptor(hit.session, fbWant, model), true)
  }
  reasons.push(`fallback_session_created:${model}`, 'model_not_switched')
  const created = descriptor(null, fbWant, model)
  created.quotaPool = top.candPool
  return plan('create_session', created, true)
}

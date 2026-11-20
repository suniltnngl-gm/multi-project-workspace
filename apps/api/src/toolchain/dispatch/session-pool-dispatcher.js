import { parseIsoStrict, normalizeRepository } from './portability.js'
import { assessSessionHealth, DEFAULT_SESSION_TTL_MS, DEFAULT_HEALTH_OBSERVATION_MAX_AGE_MS } from './session-health.js'
import { assessAvailability, isCoolingDown, DEFAULT_COOLDOWNS_MS, MAX_COOLDOWN_BACKOFF_MS } from './provider-availability.js'
import { deriveIdempotencyKey, evaluateInFlight } from './idempotency.js'

export { DEFAULT_SESSION_TTL_MS, DEFAULT_COOLDOWNS_MS, MAX_COOLDOWN_BACKOFF_MS }
export const SESSION_POOL_DISPATCH_SCHEMA_VERSION = 'session-pool-dispatch/v1.0'
export const SESSION_POOL_DISPATCH_SCHEMA_VERSION_V1_1 = 'session-pool-dispatch/v1.1'
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000

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
export function assessQuotaPools(observations = [], nowMs, maxAgeMs = DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS, v11 = false, warnings = null) {
  const latest = new Map()
  for (const o of Array.isArray(observations) ? observations : []) {
    const pool = norm(o?.quotaPool)
    const at = v11 ? (parseIsoStrict(o?.observedAt) ?? Number.NaN) : Date.parse(o?.observedAt)
    if (!pool) continue
    if (Number.isNaN(at)) {
      if (v11 && warnings) warnings.add(`invalid_timestamp:quotaObservations.${pool}.observedAt`)
      continue
    }
    const prev = latest.get(pool)
    if (!prev || at > prev.at) latest.set(pool, { o, at })
  }
  const out = new Map()
  for (const [pool, { o, at }] of latest) {
    const stale = nowMs - at > maxAgeMs
    let health = 'unknown'
    const pcts = [o.weeklyRemainingPct, o.fiveHourRemainingPct].filter((n) => typeof n === 'number')
    const min = pcts.length ? Math.min(...pcts) : null
    let resetAtMs = null
    let resetElapsed = false
    let exhausted = false
    if (v11) {
      exhausted = o.exhausted === true || (min !== null && min <= 0)
      const weeklyOut = typeof o.weeklyRemainingPct === 'number' && o.weeklyRemainingPct <= 0
      const fiveOut = typeof o.fiveHourRemainingPct === 'number' && o.fiveHourRemainingPct <= 0
      const rawReset = weeklyOut ? (o.weeklyResetAt ?? o.resetAt) : fiveOut ? (o.fiveHourResetAt ?? o.resetAt) : o.resetAt
      if (rawReset !== undefined && rawReset !== null) {
        resetAtMs = parseIsoStrict(rawReset)
        if (resetAtMs === null && warnings) warnings.add(`invalid_timestamp:quotaObservations.${pool}.resetAt`)
      }
    }
    if (v11 && exhausted) {
      // A future resetAt keeps the pool exhausted even if the observation is older than maxAge.
      if (resetAtMs !== null) {
        resetElapsed = nowMs >= resetAtMs
        health = resetElapsed ? 'unknown' : 'exhausted'
      } else health = stale ? 'unknown' : 'exhausted'
    } else if (!stale) {
      if (norm(o.policy) === 'conserve' || (min !== null && min <= SCARCE_PCT)) health = 'scarce'
      else if (min !== null && min <= LOW_PCT) health = 'low'
      else if (min !== null || o.policy) health = 'healthy'
    }
    const entry = { quotaPool: pool, health, observedAt: new Date(at).toISOString(), stale }
    if (v11) {
      entry.resetAt = resetAtMs === null ? null : new Date(resetAtMs).toISOString()
      entry.resetAtMs = resetAtMs
      entry.resetElapsed = resetElapsed
    }
    out.set(pool, entry)
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

function resolveV10({
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

// ---------------------------------------------------------------------------
// SP-003 (schema v1.1, explicit opt-in). Pure and read-only: emits lease *intents*
// only; the file-based lease store is deferred to SP-004.
// ---------------------------------------------------------------------------

const V11_STATUSES = new Set(['idle', 'active', 'interrupted', 'retired'])
const POOL_SKIP_KINDS = new Set(['pool_exhausted', 'pool_cooling', 'provider_or_gateway_cooling'])
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

function resolveV11({
  sessions = [],
  request = {},
  unavailableModels = [],
  fallbackCandidates = [],
  quotaObservations = [],
  providerObservations = [],
  leases = [],
  inFlight = [],
  poolUsage = [],
  probe = null,
  quotaObservationMaxAgeMs = DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  healthMaxAgeMs = DEFAULT_HEALTH_OBSERVATION_MAX_AGE_MS,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  maxFallbackDepth = Infinity,
  platform = process.platform,
  excludeCompositeKeys = [],
  now = () => Date.now()
} = {}) {
  const nowMs = typeof now === 'function' ? now() : Date.now()
  const mode = norm(request.dispatchMode) ?? 'fallback'
  const want = {
    role: norm(request.role),
    repository: normalizeRepository(request.repository, platform),
    cli: norm(request.cli),
    gateway: norm(request.gateway),
    provider: norm(request.provider),
    model: norm(request.model),
    quotaPool: norm(request.quotaPool),
    workItem: norm(request.workItem)
  }
  const routingKey = [want.role, want.repository, want.cli, want.gateway, want.provider, want.model, want.quotaPool]
    .map((v) => v ?? '*')
    .join('|')
  const reasons = []
  const warnings = new Set()
  const addReason = (r) => { if (!reasons.includes(r)) reasons.push(r) }
  const unavailable = new Set(unavailableModels.map(String))
  const pool = [...sessions, ...fallbackCandidates.filter((c) => c && c.sessionId)]
  const excludeSet = new Set(excludeCompositeKeys)
  const idempotencyKey = deriveIdempotencyKey({
    workItem: want.workItem, role: want.role, repository: want.repository, attemptScope: request.attemptScope
  })
  const avail = assessAvailability(providerObservations, nowMs)
  avail.warnings.forEach((w) => warnings.add(w))
  const pools = assessQuotaPools(quotaObservations, nowMs, quotaObservationMaxAgeMs, true, warnings)
  const primaryPool = want.quotaPool ?? quotaPoolOf(want)
  const consideredPools = new Set([primaryPool, ...pools.keys()])
  const evaluated = []
  let nextEligibleAtMs = null
  let rotation = null

  const describePool = (name) => {
    const a = pools.get(name)
    const c = isCoolingDown(avail.entries, 'quotaPool', name)
    return {
      quotaPool: name,
      health: a?.health || 'unknown',
      observedAt: a?.observedAt ?? null,
      stale: a?.stale ?? false,
      resetAt: a?.resetAt ?? null,
      cooldownUntil: c?.cooldownUntil ?? null
    }
  }

  const finish = (action, selectedSession, fallbackUsed) => {
    for (const w of warnings) addReason(w)
    if (selectedSession) consideredPools.add(selectedSession.quotaPool)
    return {
      schemaVersion: SESSION_POOL_DISPATCH_SCHEMA_VERSION_V1_1,
      mode: 'plan',
      readOnly: true,
      decidedAt: new Date(nowMs).toISOString(),
      action,
      selectedSession,
      fallbackUsed,
      routingKey,
      dispatchMode: DISPATCH_MODES.has(mode) ? mode : 'fallback',
      idempotencyKey,
      candidatesEvaluated: evaluated,
      availability: avail.list,
      nextEligibleAt: iso(nextEligibleAtMs),
      quotaAssessment: [...consideredPools].sort().map(describePool),
      ...(rotation ? { rotation } : {}),
      cliArtifactBoundary: { cli: want.cli ?? 'unknown', mergeNativeArtifacts: false },
      reasons
    }
  }

  if (!want.role || !want.cli || !want.model) {
    addReason('invalid_request:role_cli_model_required')
    return finish('blocked', null, false)
  }
  if (!DISPATCH_MODES.has(mode)) {
    addReason(`invalid_request:unknown_dispatch_mode:${mode}`)
    return finish('blocked', null, false)
  }

  const flight = evaluateInFlight(inFlight, idempotencyKey, nowMs, { forceRetry: request.forceRetry === true })
  flight.reasons.forEach(addReason)
  if (flight.outcome === 'await') {
    nextEligibleAtMs = flight.nextEligibleAtMs
    return finish('await_in_flight', null, false)
  }
  if (flight.outcome === 'completed') return finish('blocked', null, false)

  // Pool fairness key for round-robin: explicit poolUsage, else max lastUsedAt over the pool's sessions.
  const poolLastUsed = new Map()
  for (const s of pool) {
    const t = parseIsoStrict(s?.lastUsedAt)
    const name = quotaPoolOf(s)
    if (t !== null && t > (poolLastUsed.get(name) ?? 0)) poolLastUsed.set(name, t)
  }
  for (const u of Array.isArray(poolUsage) ? poolUsage : []) {
    const t = parseIsoStrict(u?.lastUsedAt)
    if (norm(u?.quotaPool) && t !== null) poolLastUsed.set(norm(u.quotaPool), t)
    else if (norm(u?.quotaPool)) warnings.add(`invalid_timestamp:poolUsage.${u.quotaPool}.lastUsedAt`)
  }

  const identityMatch = (s, w) =>
    V11_STATUSES.has(String(s.status || 'idle')) &&
    rolesOf(s).has(w.role) &&
    norm(s.cli) === w.cli &&
    normalizeRepository(s.repository, platform) === w.repository &&
    (w.gateway === null || norm(s.gateway) === w.gateway) &&
    (w.provider === null || norm(s.provider) === w.provider) &&
    (w.quotaPool === null || quotaPoolOf(s) === w.quotaPool) &&
    modeAllowed(s, mode) &&
    norm(s.model) === w.model

  const evalSessions = (w) => {
    const rows = []
    const excluded = []
    pool.forEach((s, index) => {
      if (!s || !identityMatch(s, w)) return
      const ck = `${w.cli}:${norm(s.sessionId) ?? ''}`
      if (excludeSet.has(ck)) { addReason(`batch_exclusion:${ck}`); excluded.push({ kind: 'batch_exclusion' }); return }
      const health = assessSessionHealth(s, nowMs, { sessionTtlMs, healthMaxAgeMs })
      health.invalidTimestamps.forEach((f) => warnings.add(`invalid_timestamp:${ck}.${f}`))
      if (health.state === 'unresumable' || health.state === 'expired') {
        addReason(`session_excluded:${ck}:${health.state}`)
        excluded.push({ kind: 'health' })
        return
      }
      const own = leases.filter((l) => l && l.compositeKey === ck)
      const live = own.filter((l) => (parseIsoStrict(l.expiresAt) ?? 0) > nowMs)
      own.filter((l) => !live.includes(l)).forEach(() => addReason(`lease_expired_ignored:${ck}`))
      if (live.length && (mode === 'parallel' || !idempotencyKey || live.some((l) => l.holder !== idempotencyKey))) {
        addReason(`session_leased:${ck}`)
        excluded.push({ kind: 'leased' })
        return
      }
      const qp = quotaPoolOf(s)
      const pa = pools.get(qp)
      if (pa?.health === 'exhausted') { addReason(`pool_exhausted:${qp}`); excluded.push({ kind: 'pool_exhausted', until: pa.resetAtMs }); return }
      const pc = isCoolingDown(avail.entries, 'quotaPool', qp)
      if (pc) { addReason(`cooldown:quotaPool:${qp}@${pc.cooldownUntil}`); excluded.push({ kind: 'pool_cooling', until: pc.cooldownUntilMs }); return }
      const sc = isCoolingDown(avail.entries, 'provider', norm(s.provider)) || isCoolingDown(avail.entries, 'gateway', norm(s.gateway))
      if (sc) { addReason(`cooldown:${sc.scope}:${sc.target}@${sc.cooldownUntil}`); excluded.push({ kind: 'provider_or_gateway_cooling', until: sc.cooldownUntilMs }); return }
      rows.push({ s, index, ck, health, qp, poolHealth: pa?.health || 'unknown' })
    })

    const sessRank = (r) => (r.health.state === 'degraded' || flight.failedCompositeKeys.has(r.ck) ? 1 : 0)
    const warm = (r) => (cacheStateOf(r.s) === 'warm_observed' ? 0 : 1)
    for (const r of rows) {
      r.key = mode === 'round-robin'
        ? [r.poolHealth === 'scarce' ? 1 : 0, poolLastUsed.get(r.qp) ?? 0, sessRank(r), lastUsedMs(r.s), warm(r), r.index]
        : [HEALTH_RANK[r.poolHealth], sessRank(r), warm(r), mode === 'parallel' && String(r.s.status) === 'active' ? 1 : 0, r.index]
    }
    rows.sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]
      return 0
    })
    let hit = null
    for (let i = 0; i < rows.length; i++) {
      if (typeof probe === 'function') {
        const res = probe(rows[i].s)
        if (res && res.exists === false) { addReason(`session_excluded:${rows[i].ck}:probe_missing`); excluded.push({ kind: 'health' }); continue }
      }
      hit = { ...rows[i], alternatives: rows.length - i - 1, sessRank: sessRank(rows[i]) }
      break
    }
    if (mode === 'round-robin' && rows.length) {
      rotation = { strategy: 'pool-lru', poolOrder: [...new Set(rows.map((r) => r.qp))] }
    }
    return { hit, excluded }
  }

  const gate = (c) => {
    if (unavailable.has(c.model)) return { reason: 'model_unavailable_or_cooling', detail: `model_unavailable:${c.model}`, until: null }
    const mc = isCoolingDown(avail.entries, 'model', c.model)
    if (mc) return { reason: 'model_unavailable_or_cooling', detail: `cooldown:model:${c.model}@${mc.cooldownUntil}`, until: mc.cooldownUntilMs }
    const pc = isCoolingDown(avail.entries, 'provider', c.provider) || isCoolingDown(avail.entries, 'gateway', c.gateway)
    if (pc) return { reason: 'provider_or_gateway_cooling', detail: `cooldown:${pc.scope}:${pc.target}@${pc.cooldownUntil}`, until: pc.cooldownUntilMs }
    const pa = pools.get(c.pool)
    if (pa?.health === 'exhausted') return { reason: 'pool_exhausted', detail: `pool_exhausted:${c.pool}`, until: pa.resetAtMs }
    const cc = isCoolingDown(avail.entries, 'quotaPool', c.pool)
    if (cc) return { reason: 'pool_cooling', detail: `cooldown:quotaPool:${c.pool}@${cc.cooldownUntil}`, until: cc.cooldownUntilMs }
    return null
  }

  const skips = []
  const descriptor = (row, w, model, c) => {
    const sessionId = row ? norm(row.s.sessionId) : null
    const compositeKey = row ? row.ck : null
    return {
      compositeKey,
      sessionId,
      cli: w.cli,
      role: w.role,
      repository: w.repository,
      gateway: row ? norm(row.s.gateway) : w.gateway,
      provider: row ? norm(row.s.provider) : w.provider,
      model,
      quotaPool: row ? row.qp : c.pool,
      cacheState: row ? cacheStateOf(row.s) : 'unknown',
      health: row ? (row.sessRank === 1 ? 'degraded' : row.health.state === 'healthy' ? 'healthy' : 'unknown') : 'unknown',
      // Lease intent only. Omitted (null) when there is no idempotencyKey holder or no session yet.
      lease: row && idempotencyKey ? { compositeKey, ttlMs: leaseTtlMs, holder: idempotencyKey } : null
    }
  }

  // returns {action, selectedSession} when selectable, otherwise records a skip and returns null
  const tryCandidate = (c) => {
    const entryBase = { model: c.model, quotaPool: c.pool, independent: c.independent }
    const g = gate(c)
    if (g) {
      addReason(g.detail)
      evaluated.push({ ...entryBase, verdict: 'skipped', reason: g.reason })
      skips.push(g.until)
      return null
    }
    const r = evalSessions(c.w)
    if (r.hit) {
      evaluated.push({ ...entryBase, verdict: 'selected', reason: c.isPrimary ? 'primary_available' : 'fallback_selected' })
      return { action: 'reuse_session', selectedSession: descriptor(r.hit, c.w, c.model, c), hit: r.hit }
    }
    const poolSkips = r.excluded.filter((e) => POOL_SKIP_KINDS.has(e.kind))
    if (poolSkips.length) {
      const untils = poolSkips.map((e) => e.until ?? null)
      evaluated.push({ ...entryBase, verdict: 'skipped', reason: poolSkips[0].kind })
      skips.push(untils.every((u) => u !== null) ? Math.min(...untils) : null)
      return null
    }
    evaluated.push({ ...entryBase, verdict: 'selected', reason: c.isPrimary ? 'primary_available_create' : 'fallback_selected_create' })
    return { action: 'create_session', selectedSession: descriptor(null, c.w, c.model, c), hit: null }
  }

  const primary = {
    model: want.model, provider: want.provider, gateway: want.gateway,
    pool: primaryPool, independent: false, isPrimary: true, w: want
  }
  const first = tryCandidate(primary)
  if (first) {
    if (first.hit) {
      addReason(`matched_composite_key:${want.cli}:${first.hit.ck}`)
      if (cacheStateOf(first.hit.s) === 'warm_observed') addReason('preferred_warm_observed')
      const a = pools.get(first.hit.qp)
      if (a) addReason(`quota_pool_${a.health}:${first.hit.qp}@${a.observedAt}`)
      if (a?.resetElapsed) addReason(`quota_reset_elapsed:${first.hit.qp}@${a.resetAt}`)
      if (first.hit.poolHealth === 'scarce') addReason(`scarce_pool_reused_no_healthier_alternative:${first.hit.qp}`)
      if (first.hit.sessRank === 1) addReason('degraded_session_reused')
      if (first.hit.alternatives > 0 && HEALTH_RANK[first.hit.poolHealth] === 0) addReason('quota_pool_healthy_preferred')
      addReason(`dispatch_mode:${mode}`)
    } else addReason('no_compatible_session:role_isolation_and_model_pinning_enforced')
    return finish(first.action, first.selectedSession, false)
  }
  addReason(`primary_ineligible:${evaluated[0].reason}`)

  const prepared = fallbackCandidates
    .map((cand, index) => ({ cand, index, model: norm(cand?.model) }))
    .filter(({ model }) => model && model !== want.model)
    .map((c) => {
      const candPool = norm(c.cand.quotaPool) ?? norm(c.cand.provider) ?? primaryPool
      const explicit = Boolean(c.cand.quotaPool)
      return {
        ...c,
        pool: candPool,
        independent: candPool !== primaryPool,
        health: HEALTH_RANK[pools.get(candPool)?.health || 'unknown'] ?? 0,
        provider: norm(c.cand.provider) ?? (explicit ? null : want.provider),
        gateway: norm(c.cand.gateway) ?? (explicit ? null : want.gateway),
        isPrimary: false
      }
    })
    .sort((a, b) => Number(!a.independent) - Number(!b.independent) || a.health - b.health || a.index - b.index)

  let chosen = null
  let chosenCand = null
  const limit = Number.isFinite(maxFallbackDepth) ? Math.max(0, maxFallbackDepth) : prepared.length
  prepared.forEach((c, i) => {
    c.w = { ...want, model: c.model, quotaPool: norm(c.cand.quotaPool), provider: c.provider, gateway: c.gateway }
    consideredPools.add(c.pool)
    if (chosen) {
      evaluated.push({ model: c.model, quotaPool: c.pool, independent: c.independent, verdict: 'not_reached', reason: 'earlier_candidate_selected' })
    } else if (i >= limit) {
      evaluated.push({ model: c.model, quotaPool: c.pool, independent: c.independent, verdict: 'not_reached', reason: 'max_fallback_depth' })
    } else {
      chosen = tryCandidate(c)
      if (chosen) chosenCand = c
    }
  })

  if (chosen) {
    addReason(chosenCand.independent ? `fallback_independent_quota_pool:${chosenCand.pool}` : `fallback_shares_quota_pool:${chosenCand.pool}`)
    addReason(chosen.hit ? `fallback_session_reused:${chosenCand.model}` : `fallback_session_created:${chosenCand.model}`)
    addReason('model_not_switched')
    if (chosen.hit?.sessRank === 1) addReason('degraded_session_reused')
    return finish(chosen.action, chosen.selectedSession, true)
  }

  if (skips.length && skips.every((u) => u !== null)) {
    nextEligibleAtMs = Math.min(...skips)
    addReason(`deferred_until:${iso(nextEligibleAtMs)}`)
    return finish('deferred', null, false)
  }
  addReason(prepared.length ? 'no_eligible_candidate' : 'no_fallback_candidate_available')
  return finish('blocked', null, false)
}

function normalizeSchemaVersion(v) {
  if (v === undefined || v === null || v === 'v1.0' || v === SESSION_POOL_DISPATCH_SCHEMA_VERSION) return 'v1.0'
  if (v === 'v1.1' || v === SESSION_POOL_DISPATCH_SCHEMA_VERSION_V1_1) return 'v1.1'
  throw new RangeError(`unsupported schemaVersion: ${v}`)
}

const nonEmpty = (v) => Array.isArray(v) && v.length > 0

export function resolveDispatchTarget(opts = {}) {
  if (normalizeSchemaVersion(opts.schemaVersion) === 'v1.1') return resolveV11(opts)
  const plan = resolveV10(opts)
  if (nonEmpty(opts.providerObservations) || nonEmpty(opts.leases) || nonEmpty(opts.inFlight) || nonEmpty(opts.poolUsage)) {
    plan.reasons.push('sp003_inputs_ignored:schema_v1.0')
  }
  return plan
}

/**
 * Plans requests in order; every reuse selection is excluded for later requests so no two
 * slices in one batch share a session (overflow becomes create_session). Always schema v1.1.
 */
export function planParallelBatch({ requests = [], ...shared } = {}) {
  const exclude = new Set(shared.excludeCompositeKeys || [])
  const plans = []
  for (const request of requests) {
    const plan = resolveDispatchTarget({
      ...shared,
      schemaVersion: 'v1.1',
      request: { ...shared.request, dispatchMode: 'parallel', ...request },
      excludeCompositeKeys: [...exclude]
    })
    plans.push(plan)
    if (plan.action === 'reuse_session' && plan.selectedSession?.compositeKey) exclude.add(plan.selectedSession.compositeKey)
  }
  return plans
}

/**
 * Deterministic CLI exit-code precedence for one plan or a mixed batch:
 * any blocked -> 2 (hard failure outranks transient); else any deferred/await_in_flight -> 3; else 0.
 */
export function exitCodeForPlans(plans) {
  const list = Array.isArray(plans) ? plans : [plans]
  if (list.some((p) => p?.action === 'blocked')) return 2
  if (list.some((p) => p?.action === 'deferred' || p?.action === 'await_in_flight')) return 3
  return 0
}

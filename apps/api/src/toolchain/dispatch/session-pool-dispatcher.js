export const SESSION_POOL_DISPATCH_SCHEMA_VERSION = 'session-pool-dispatch/v1.0'

const REUSABLE_STATUSES = new Set(['idle', 'active'])
const norm = (v) => (v === undefined || v === null ? null : String(v))

function cacheStateOf(session) {
  return session.cacheState || session.observed?.cacheState || 'unknown'
}

function isCompatible(session, want) {
  if (!REUSABLE_STATUSES.has(String(session.status || 'idle'))) return false
  if (norm(session.role) !== want.role) return false
  if (norm(session.cli) !== want.cli) return false
  if (norm(session.repository) !== want.repository) return false
  if (want.gateway !== null && norm(session.gateway) !== want.gateway) return false
  if (want.provider !== null && norm(session.provider) !== want.provider) return false
  return norm(session.model) === want.model
}

function pickBest(sessions, want) {
  const matches = sessions.filter((s) => s && isCompatible(s, want))
  return matches.find((s) => cacheStateOf(s) === 'warm_observed') || matches[0] || null
}

function descriptor(session, want, model) {
  const cli = want.cli
  const sessionId = session ? norm(session.sessionId) : null
  return {
    compositeKey: session ? `${cli}:${sessionId ?? ''}` : null,
    sessionId,
    cli,
    role: want.role,
    repository: want.repository,
    gateway: session ? norm(session.gateway) : want.gateway,
    provider: session ? norm(session.provider) : want.provider,
    model,
    cacheState: session ? cacheStateOf(session) : 'unknown'
  }
}

export function resolveDispatchTarget({
  sessions = [],
  request = {},
  unavailableModels = [],
  fallbackCandidates = [],
  now = () => Date.now()
} = {}) {
  const want = {
    role: norm(request.role),
    repository: norm(request.repository),
    cli: norm(request.cli),
    gateway: norm(request.gateway),
    provider: norm(request.provider),
    model: norm(request.model),
    workItem: norm(request.workItem)
  }
  const decidedAt = new Date(typeof now === 'function' ? now() : Date.now()).toISOString()
  const routingKey = [want.role, want.repository, want.cli, want.gateway, want.provider, want.model]
    .map((v) => v ?? '*')
    .join('|')
  const unavailable = new Set(unavailableModels.map(String))
  const pool = [...sessions, ...fallbackCandidates.filter((c) => c && c.sessionId)]
  const reasons = []

  const plan = (action, selectedSession, fallbackUsed) => ({
    schemaVersion: SESSION_POOL_DISPATCH_SCHEMA_VERSION,
    mode: 'plan',
    readOnly: true,
    decidedAt,
    action,
    selectedSession,
    fallbackUsed,
    routingKey,
    cliArtifactBoundary: { cli: want.cli ?? 'unknown', mergeNativeArtifacts: false },
    reasons
  })

  if (!want.role || !want.cli || !want.model) {
    reasons.push('invalid_request:role_cli_model_required')
    return plan('blocked', null, false)
  }

  if (!unavailable.has(want.model)) {
    const hit = pickBest(pool, want)
    if (hit) {
      reasons.push(`matched_composite_key:${want.cli}:${norm(hit.sessionId)}`)
      if (cacheStateOf(hit) === 'warm_observed') reasons.push('preferred_warm_observed')
      return plan('reuse_session', descriptor(hit, want, want.model), false)
    }
    reasons.push('no_compatible_session:role_isolation_and_model_pinning_enforced')
    return plan('create_session', descriptor(null, want, want.model), false)
  }

  reasons.push(`primary_model_unavailable:${want.model}`)
  for (const cand of fallbackCandidates) {
    const model = norm(cand?.model)
    if (!model || unavailable.has(model) || model === want.model) continue
    const fbWant = {
      ...want,
      model,
      provider: norm(cand.provider) ?? want.provider,
      gateway: norm(cand.gateway) ?? want.gateway
    }
    const hit = pickBest(pool, fbWant)
    if (hit) {
      reasons.push(`fallback_session_reused:${model}`, 'model_not_switched')
      return plan('reuse_session', descriptor(hit, fbWant, model), true)
    }
    reasons.push(`fallback_session_created:${model}`, 'model_not_switched')
    return plan('create_session', descriptor(null, fbWant, model), true)
  }
  reasons.push('no_fallback_candidate_available')
  return plan('blocked', null, false)
}

// Objective: Centralize fail-closed swarm model authorization independently of quota/resource availability.
// Requirements: Explicit model selections are exclusive; local-only is provider constrained; unknown and contradictory constraints fail closed.
function resolveAllowlistedModel(models, spec) {
  const direct = models.find((entry) => entry?.id === spec)
  if (direct) return direct
  const at = spec.indexOf('@')
  if (at <= 0 || at === spec.length - 1) return null
  const baseId = spec.slice(0, at).trim()
  const scope = spec.slice(at + 1).trim()
  const base = models.find((entry) => entry?.id === baseId)
  if (!base || !scope) return null
  return {
    ...base,
    id: `${base.id}@${scope}`,
    baseId: base.id,
    scope,
    ...(base.cli ? { cli: { ...base.cli, model: scope } } : { apiModel: scope })
  }
}

export function createSwarmModelAuthorization({ models = [], requestedModels = null, localOnly = false } = {}) {
  if (typeof localOnly !== 'boolean') {
    throw new Error('--local-only constraint must be a boolean flag.')
  }
  if (requestedModels !== null && !Array.isArray(requestedModels)) {
    throw new Error('Model allowlist must be an array of model IDs.')
  }
  const explicit = requestedModels !== null
  const requested = explicit ? requestedModels : []
  if (explicit && requested.length === 0) {
    throw new Error('Explicit model allowlist is empty; refusing to broaden swarm selection.')
  }
  if (requested.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error('Model allowlist contains an empty or invalid entry.')
  }
  const resolved = []
  const seen = new Set()
  for (const raw of requested) {
    const spec = raw.trim()
    const model = resolveAllowlistedModel(models, spec)
    if (!model || model.callable === false) {
      throw new Error(`Unknown or non-callable model in --models allowlist: ${spec}`)
    }
    if (localOnly && model.provider !== 'local') {
      throw new Error(`Contradictory model constraints: ${spec} is not an approved local provider model.`)
    }
    if (!seen.has(model.id)) { seen.add(model.id); resolved.push(model) }
  }
  const localModels = models.filter((model) => model && model.callable !== false && model.provider === 'local')
  if (localOnly && localModels.length === 0) {
    throw new Error('--local-only requested, but no callable approved local models are registered.')
  }
  const allowed = explicit ? resolved : (localOnly ? localModels : null)
  if ((explicit || localOnly) && (!allowed || allowed.length === 0)) {
    throw new Error('Active model allowlist is empty; refusing to broaden swarm selection.')
  }
  const ids = allowed ? allowed.map((model) => model.id) : null
  return Object.freeze({
    constrained: Boolean(explicit || localOnly),
    explicit,
    localOnly,
    allowedModelIds: ids ? Object.freeze([...new Set(ids)]) : null,
    allowedModels: allowed ? Object.freeze([...allowed]) : null,
    allows(model) {
      if (!model) return false
      if (ids && !ids.includes(model.id)) return false
      if (localOnly && model.provider !== 'local') return false
      return true
    }
  })
}

export function assertSwarmAgentAuthorization(agents = [], authorization) {
  if (!authorization?.constrained) return true
  const allowedIds = new Set(authorization.allowedModelIds ?? [])
  const violations = []
  for (const agent of agents) {
    const allowed = allowedIds.has(agent?.model)
      && (!authorization.localOnly || agent?.provider === 'local')
    if (!allowed) {
      violations.push(`${agent?.role ?? 'agent'}:${agent?.name ?? 'unknown'}=${agent?.model ?? 'missing'}`)
    }
  }
  if (violations.length) throw new Error(`Swarm model authorization failed; out-of-allowlist role(s): ${violations.join(', ')}`)
  return true
}

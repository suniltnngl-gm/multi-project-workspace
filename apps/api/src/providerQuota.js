// Objective: Turn the flat model roster and quota ledger into provider-level headroom and a deterministic multi-agent dispatch plan.
// Requirements: Never call a model; group models that share a provider quota domain; treat billing category as ordering metadata, never as permission; keep serverless/Ollama slots separate unless they are the same provider; prefer the healthiest, freest model in every plan.
// Decisions: Grouping is pure and data-driven because vendor names and quotas live in the registry; a blocked provider is still reported so the parent can wait instead of probing every backend; the plan is advisory and quota checks remain authoritative at assign time.
// Relevant Files: apps/api/src/providerQuota.js, apps/api/src/modelRegistry.js, apps/api/src/modelBudget.js, apps/api/src/agentBus.js, apps/api/src/routes/models.js
// Important Context: User file. The zero-token half of provider-aware routing.

import { isConsoleGoogleScope } from './modelBudget.js'
import {
  agyQuotaPoolForScope,
  isProOnlyGeminiModel,
  resolveBillingCategoryForScope
} from './modelRegistry.js'

export const BILLING_RANK = new Map([
  ['free', 0],
  ['subscription', 1],
  ['payg', 2]
])

// Each serverless slot and Ollama endpoint may be a different account, so the
// provider name alone is not enough to merge them. Named backends (local,
// colab, kaggle, opencode, ...) share their provider quota domain, while
// Antigravity (`agy`) models map into 3 shared weekly quota pools.
export function modelProviderKey(model) {
  if (!model || typeof model.provider !== 'string' || !model.provider.trim()) return ''
  const provider = model.provider.trim()
  if (provider === 'agy') {
    const scope = model.scope || quotaScopeForModel(model)
    if (scope) {
      const pool = agyQuotaPoolForScope(scope)
      return pool ? `agy:${pool}` : `agy:${scope}`
    }
  }
  if (provider === 'opencode') {
    const scope = model.scope || quotaScopeForModel(model)
    if (isConsoleGoogleScope(scope)) return 'opencode:console-google'
  }
  if (provider === 'gemini-api') {
    return 'gemini-api:gcp-project'
  }
  if (provider === 'gemini-api-paid') {
    return 'gemini-api-paid:gcp-project'
  }
  if (model.scope) {
    return `${provider}:${model.scope}`
  }
  if ((provider === 'serverless' || provider === 'ollama') && model.id) {
    return `${provider}:${model.id}`
  }
  return provider
}

export function quotaScopeForModel(model) {
  if (!model) return undefined
  const scope = model.cli?.model || model.apiModel
  return typeof scope === 'string' && scope.trim() ? scope.trim() : undefined
}

export function resolveAgentModel(models = [], modelSpec, backendSpec = '', options = {}) {
  if (!modelSpec || typeof modelSpec !== 'string') return undefined
  const trimmedModel = modelSpec.trim()
  if (!trimmedModel) return undefined
  const trimmedBackend = typeof backendSpec === 'string' ? backendSpec.trim() : ''
  const byId = new Map(
    (Array.isArray(models) ? models : [])
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry])
  )

  let base
  let scope = ''
  if (byId.has(trimmedModel)) {
    base = byId.get(trimmedModel)
    if (trimmedBackend && trimmedBackend !== base.backend) {
      scope = trimmedBackend
    }
  } else if (trimmedModel.includes('@')) {
    const atIndex = trimmedModel.indexOf('@')
    const baseId = trimmedModel.slice(0, atIndex).trim()
    scope = trimmedModel.slice(atIndex + 1).trim()
    base = byId.get(baseId)
  }

  if (!base) return undefined
  const billingSource = options?.billingCategories ?? base.billingOverrides
  const effectiveScope = scope || quotaScopeForModel(base) || ''
  const resolvedBilling = billingSource
    ? resolveBillingCategoryForScope(billingSource, base.id, effectiveScope, base.billingCategory)
    : base.billingCategory

  if (!scope) {
    if (resolvedBilling && resolvedBilling !== base.billingCategory) {
      return { ...base, billingCategory: resolvedBilling }
    }
    return base
  }
  return {
    ...base,
    id: `${base.id}@${scope}`,
    baseId: base.id,
    scope,
    ...(resolvedBilling ? { billingCategory: resolvedBilling } : {}),
    ...(base.cli ? { cli: { ...base.cli, model: scope } } : { apiModel: scope })
  }
}

export function groupModelsByProvider(models = []) {
  const groups = new Map()
  for (const model of models) {
    const key = modelProviderKey(model)
    if (!key) continue
    let group = groups.get(key)
    if (!group) {
      group = {
        provider: model.provider,
        groupKey: key,
        models: []
      }
      groups.set(key, group)
    }
    group.models.push(model)
  }
  return [...groups.values()]
}

export function billingRank(model) {
  if (!model?.billingCategory) return 0
  return BILLING_RANK.has(model.billingCategory)
    ? BILLING_RANK.get(model.billingCategory)
    : 3
}

function normalizeResourceMap(resourceStatus) {
  if (!resourceStatus || typeof resourceStatus.then === 'function') return null
  if (typeof resourceStatus === 'function') {
    return { lookup: resourceStatus }
  }
  if (resourceStatus instanceof Map) {
    return { map: resourceStatus }
  }
  if (Array.isArray(resourceStatus)) {
    const map = new Map()
    for (const entry of resourceStatus) {
      if (entry && typeof entry.id === 'string') {
        map.set(entry.id, entry)
      }
    }
    return { map }
  }
  if (typeof resourceStatus === 'object') {
    if (Array.isArray(resourceStatus.models)) {
      const map = new Map()
      for (const entry of resourceStatus.models) {
        if (entry && typeof entry.id === 'string') {
          map.set(entry.id, {
            ...entry,
            ...(entry.retryAfter === undefined && Number.isFinite(resourceStatus.retryAfter)
              ? { retryAfter: resourceStatus.retryAfter }
              : {})
          })
        }
      }
      return { map }
    }
    const map = new Map()
    for (const [id, entry] of Object.entries(resourceStatus)) {
      if (entry && typeof entry === 'object') {
        map.set(id, entry)
      }
    }
    return { map }
  }
  return null
}

function resolveResourceEntry(resourceMap, model) {
  if (!resourceMap || !model) return null
  if (typeof resourceMap.lookup === 'function') {
    return resourceMap.lookup(model) ?? null
  }
  if (!resourceMap.map) return null
  return (model.id ? resourceMap.map.get(model.id) : null)
    ?? (model.baseId ? resourceMap.map.get(model.baseId) : null)
    ?? null
}

function isResourceBlocked(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.available === false) return true
  if (Array.isArray(entry.busyReasons) && entry.busyReasons.length > 0) return true
  return entry.state === 'busy' || entry.state === 'unavailable'
}

function ratioFor(modelBudget, model) {
  const targetId = model?.baseId ?? model?.id
  const scope = quotaScopeForModel(model)
  if (modelBudget && typeof modelBudget.headroom === 'function') {
    const result = modelBudget.headroom(targetId, scope)
    const ratio = Number.isFinite(result?.ratio) ? result.ratio : (result?.ok === false ? 0 : 1)
    const sessionWindow = result?.sessionWindow ?? result?.budget?.sessionWindow
    const harvestableSession = Boolean(result?.harvestableSession || result?.budget?.harvestableSession)
    return {
      ok: result?.ok !== false,
      ratio,
      pacedHeadroom: Number.isFinite(result?.pacedHeadroom) ? result.pacedHeadroom : ratio,
      ...(result?.pacing ? { pacing: result.pacing } : {}),
      ...(sessionWindow ? { sessionWindow } : {}),
      harvestableSession,
      configured: Boolean(result?.configured || !model?.remote),
      observedRequests: Number(result?.observedRequests ?? 0),
      retryAfter: result?.retryAfter,
      budget: result?.budget
    }
  }
  if (modelBudget && typeof modelBudget.check === 'function') {
    const result = modelBudget.check(targetId, scope)
    const ratio = result?.ok === false ? 0 : 1
    return {
      ok: result?.ok !== false,
      ratio,
      pacedHeadroom: ratio,
      harvestableSession: false,
      configured: !model?.remote,
      observedRequests: 0,
      retryAfter: result?.retryAfter,
      budget: result?.budget
    }
  }
  return {
    ok: true,
    ratio: 1,
    pacedHeadroom: 1,
    harvestableSession: false,
    configured: !model?.remote,
    observedRequests: 0
  }
}

function describeModel(model, modelBudget, resourceMap = null) {
  const quota = ratioFor(modelBudget, model)
  const scope = quotaScopeForModel(model)
  const res = resolveResourceEntry(resourceMap, model)
  const resourceBlocked = isResourceBlocked(res)
  const retryAfterValues = [quota.retryAfter, res?.retryAfter].filter(
    (value) => Number.isFinite(value) && value > 0
  )
  const retryAfter = retryAfterValues.length > 0 ? Math.max(...retryAfterValues) : undefined
  const ok = quota.ok && !resourceBlocked
  const headroom = resourceBlocked ? 0 : quota.ratio
  const pacedHeadroom = resourceBlocked ? 0 : (quota.pacedHeadroom ?? headroom)
  const agyPool = model.provider === 'agy' && scope ? agyQuotaPoolForScope(scope) : null
  const escalationOnly = Boolean(model.escalationOnly || model.provider === 'gemini-api-paid')
  const utilizationTier = escalationOnly
    ? 2
    : (model.provider === 'agy' && (agyPool === 'claude-gpt' || agyPool === 'gemini-4-argon') ? 1 : 0)
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    backend: model.backend,
    billingCategory: model.billingCategory,
    ...(scope ? { scope } : {}),
    ...(agyPool ? { agyPool } : {}),
    ...(escalationOnly ? { escalationOnly: true } : {}),
    autoSelect: model.autoSelect ?? true,
    ...(model.execution ? { execution: model.execution } : {}),
    priority: model.priority,
    remote: model.remote === true,
    configured: Boolean(quota.configured || !model.remote),
    observedRequests: Number(quota.observedRequests ?? 0),
    ok,
    headroom,
    pacedHeadroom,
    aheadOfPace: Boolean(quota.pacing?.aheadOfPace),
    harvestableSession: Boolean(quota.harvestableSession),
    ...(quota.sessionWindow ? { sessionWindow: quota.sessionWindow } : {}),
    utilizationTier,
    ...(resourceBlocked
      ? {
        resourceBlocked: true,
        busyReasons: Array.isArray(res.busyReasons) ? res.busyReasons : [],
        reason: res.busyReasons?.[0] || res.error || 'Local resource gate is busy or unavailable.'
      }
      : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {})
  }
}

function compareModels(a, b) {
  if (a.ok !== b.ok) return a.ok ? -1 : 1
  const billing = billingRank(a) - billingRank(b)
  if (billing !== 0) return billing
  if (a.headroom !== b.headroom) return b.headroom - a.headroom
  return (b.priority ?? 0) - (a.priority ?? 0)
}

export function compareRosterCandidates(a, b) {
  if (a.ok !== b.ok) return a.ok ? -1 : 1
  const billing = billingRank(a) - billingRank(b)
  if (billing !== 0) return billing

  const aAuto = a.autoSelect !== false && a.execution !== 'batch'
  const bAuto = b.autoSelect !== false && b.execution !== 'batch'
  if (aAuto !== bAuto) return aAuto ? -1 : 1

  const aConfigured = Boolean(a.configured)
  const bConfigured = Boolean(b.configured)
  if (aConfigured !== bConfigured) return aConfigured ? -1 : 1

  const aRemote = a.remote === true && a.limitKind !== 'resource'
  const bRemote = b.remote === true && b.limitKind !== 'resource'
  if (aRemote !== bRemote) return aRemote ? -1 : 1

  if (Boolean(a.aheadOfPace) !== Boolean(b.aheadOfPace)) {
    return a.aheadOfPace ? 1 : -1
  }

  // Workers prefer renewable Tier 0 pools (`agy@gemini`, local, opencode,
  // colab, kaggle) even when a scarce Tier 1 weekly pool has fresher headroom;
  // Tier 1 stays available for the reviewer or pass-2 fan-out.
  const aTier = a.utilizationTier ?? 0
  const bTier = b.utilizationTier ?? 0
  if (aTier !== bTier) return aTier - bTier

  // Within the same tier, prefer pools with a renewable 5-hour session buffer
  // (`harvestableSession`) over weekly-only buckets.
  if (Boolean(a.harvestableSession) !== Boolean(b.harvestableSession)) {
    return a.harvestableSession ? -1 : 1
  }

  const aEffectiveHeadroom = a.pacedHeadroom ?? a.headroom
  const bEffectiveHeadroom = b.pacedHeadroom ?? b.headroom
  if (Math.abs(aEffectiveHeadroom - bEffectiveHeadroom) > 0.05) {
    return bEffectiveHeadroom - aEffectiveHeadroom
  }

  const aObserved = Number(a.observedRequests ?? 0)
  const bObserved = Number(b.observedRequests ?? 0)
  if (aObserved !== bObserved) return aObserved - bObserved

  if (a.headroom !== b.headroom) return b.headroom - a.headroom

  return (b.priority ?? 0) - (a.priority ?? 0)
}

/**
 * Return one entry per provider quota domain with the preferred model, the
 * best normalized headroom, and the earliest wait when the provider is
 * blocked. No limiter values are derived here; modelBudget owns the ledger.
 */
export function providerSnapshots({ models = [], modelBudget, resourceStatus } = {}) {
  const resourceMap = normalizeResourceMap(resourceStatus)
  return groupModelsByProvider(models).map((group) => {
    const entries = group.models.map((model) => describeModel(model, modelBudget, resourceMap))
    const ranked = [...entries].sort(compareModels)
    const preferred = ranked[0]
    const available = entries.filter((entry) => entry.ok)
    const waits = entries
      .filter((entry) => !entry.ok && Number.isFinite(entry.retryAfter))
      .map((entry) => entry.retryAfter)
    return {
      provider: group.provider,
      groupKey: group.groupKey,
      billingCategories: [...new Set(entries.map((entry) => entry.billingCategory).filter(Boolean))],
      billingCategory: preferred?.billingCategory,
      ok: available.length > 0,
      headroom: available.length > 0
        ? Math.max(...available.map((entry) => entry.headroom))
        : 0,
      ...(available.length === 0 && waits.length > 0
        ? { retryAfter: Math.min(...waits) }
        : {}),
      modelCount: entries.length,
      availableCount: available.length,
      preferredModel: preferred?.id,
      models: ranked
    }
  })
}

/**
 * Build a zero-token plan for a set of agent specs. Each agent keeps the model
 * it was created with (prompt caches are per model), so the plan reports which
 * provider that pin will spend and whether it is currently safe to assign.
 * `parallelLimit` is the number of active assignments allowed per provider.
 */
export function planAgentDispatch({
  models = [],
  modelBudget,
  agents = [],
  parallelLimit = 1,
  activeAssignments = [],
  resourceStatus
} = {}) {
  const resourceMap = normalizeResourceMap(resourceStatus)
  const activeByAgent = new Map()
  for (const assignment of activeAssignments) {
    const agentId = assignment.toAgentId ?? assignment.to_agent_id
    if (!agentId) continue
    activeByAgent.set(agentId, (activeByAgent.get(agentId) ?? 0) + 1)
  }

  const planned = agents.map((agent) => {
    const model = resolveAgentModel(models, agent.model, agent.backend)
    if (!model) {
      return {
        name: agent.name,
        role: agent.role,
        model: agent.model,
        resolved: false,
        ok: true,
        reason: 'Model is not in the local registry; quota is unknown to the control plane.'
      }
    }
    const groupKey = modelProviderKey(model)
    const described = describeModel(model, modelBudget, resourceMap)
    return {
      name: agent.name,
      role: agent.role,
      model: agent.model,
      provider: model.provider,
      groupKey,
      ...(model.limitKind ? { limitKind: model.limitKind } : {}),
      ...(described.scope ? { scope: described.scope } : {}),
      resolved: true,
      ok: described.ok,
      headroom: described.headroom,
      ...(described.resourceBlocked
        ? {
          resourceBlocked: true,
          busyReasons: described.busyReasons,
          reason: described.reason
        }
        : {}),
      ...(described.retryAfter !== undefined ? { retryAfter: described.retryAfter } : {}),
      activeAssignments: activeByAgent.get(agent.id) ?? 0
    }
  })

  const groups = new Map()
  for (const entry of planned) {
    if (!entry.groupKey) continue
    let group = groups.get(entry.groupKey)
    if (!group) {
      group = {
        provider: entry.provider,
        groupKey: entry.groupKey,
        agents: [],
        activeAssignments: 0
      }
      groups.set(entry.groupKey, group)
    }
    group.agents.push(entry.name)
    group.activeAssignments += entry.activeAssignments
  }

  const providers = [...groups.values()].map((group) => {
    const entries = planned.filter((entry) => entry.groupKey === group.groupKey)
    const blocked = entries.find((entry) => entry.ok === false)
    const atLimit = group.activeAssignments >= parallelLimit
    return {
      provider: group.provider,
      groupKey: group.groupKey,
      agents: group.agents,
      activeAssignments: group.activeAssignments,
      parallelLimit,
      ok: !blocked && !atLimit,
      ...(blocked
        ? {
          reason: blocked.resourceBlocked
            ? (blocked.reason || 'local resource gate is busy or unavailable')
            : 'provider quota is exhausted or cooling down',
          ...(blocked.retryAfter !== undefined ? { retryAfter: blocked.retryAfter } : {})
        }
        : atLimit
          ? { reason: `provider already has ${parallelLimit} active assignment(s)` }
          : {}),
      headroom: Math.max(...entries.map((entry) => entry.headroom ?? 0))
    }
  })

  return {
    ok: providers.every((provider) => provider.ok) &&
      planned.every((entry) => entry.ok),
    parallelLimit,
    agents: planned,
    providers
  }
}

function toRosterCandidate(candidate, modelBudget, resourceMap = null) {
  const described = describeModel(candidate, modelBudget, resourceMap)
  return {
    ...described,
    modelSpec: candidate.id,
    groupKey: modelProviderKey(candidate),
    ...(candidate.limitKind ? { limitKind: candidate.limitKind } : {})
  }
}

function toAgentEntry(role, name, candidate) {
  return {
    role,
    name,
    model: candidate.modelSpec ?? candidate.id,
    ...(candidate.backend ? { backend: candidate.backend } : {}),
    provider: candidate.provider,
    groupKey: candidate.groupKey,
    ...(candidate.limitKind ? { limitKind: candidate.limitKind } : {}),
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    ...(candidate.billingCategory ? { billingCategory: candidate.billingCategory } : {}),
    ok: candidate.ok !== false,
    headroom: Number.isFinite(candidate.headroom) ? candidate.headroom : 1
  }
}

/**
 * Distribute swarm workers across distinct quota domains so parallel turns
 * do not collide on a single provider slot or quota bucket. The coordinator
 * (`parent`) runs deterministically with zero LLM calls.
 */
export function buildSwarmRoster({
  models = [],
  modelBudget,
  resourceStatus,
  workerCount = 2,
  includeReviewer = true,
  preferredModels = [],
  opencodeModels = [],
  agyModels = [],
  geminiApiModels = [],
  geminiApiPaidModels = [],
  allowPaidEscalation = false
} = {}) {
  const resourceMap = normalizeResourceMap(resourceStatus)
  const count = Math.max(1, Math.min(6, Math.floor(Number(workerCount) || 2)))
  const rawPool = []
  const seenBaseScope = new Set()

  const addRawCandidate = (candidate) => {
    if (!candidate) return
    const scope = quotaScopeForModel(candidate) ?? ''
    if (candidate.provider === 'gemini-api' && isProOnlyGeminiModel(scope)) return
    const baseId = candidate.baseId ?? candidate.id
    const key = `${baseId}\0${scope}`
    if (seenBaseScope.has(key)) return
    seenBaseScope.add(key)
    rawPool.push(candidate)
  }

  for (const scope of Array.isArray(opencodeModels) ? opencodeModels : []) {
    if (typeof scope !== 'string' || !scope.trim()) continue
    const trimmed = scope.trim()
    addRawCandidate(resolveAgentModel(models, trimmed.includes('@') ? trimmed : `opencode@${trimmed}`))
  }

  for (const scope of Array.isArray(agyModels) ? agyModels : []) {
    if (typeof scope !== 'string' || !scope.trim()) continue
    const trimmed = scope.trim()
    addRawCandidate(resolveAgentModel(models, trimmed.includes('@') ? trimmed : `agy@${trimmed}`))
  }

  for (const scope of Array.isArray(geminiApiModels) ? geminiApiModels : []) {
    if (typeof scope !== 'string' || !scope.trim()) continue
    const trimmed = scope.trim()
    if (isProOnlyGeminiModel(trimmed)) continue
    addRawCandidate(resolveAgentModel(models, trimmed.includes('@') ? trimmed : `gemini-api@${trimmed}`))
  }

  for (const scope of Array.isArray(geminiApiPaidModels) ? geminiApiPaidModels : []) {
    if (typeof scope !== 'string' || !scope.trim()) continue
    const trimmed = scope.trim()
    addRawCandidate(resolveAgentModel(models, trimmed.includes('@') ? trimmed : `gemini-api-paid@${trimmed}`))
  }

  for (const model of Array.isArray(models) ? models : []) {
    if (!model || model.callable === false) continue
    if ((model.escalationOnly || model.provider === 'gemini-api-paid') && !allowPaidEscalation) continue
    if ((model.escalationOnly || model.provider === 'gemini-api-paid') && Array.isArray(model.cli?.models)) {
      for (const scope of model.cli.models) {
        if (typeof scope !== 'string' || !scope.trim()) continue
        const trimmed = scope.trim()
        addRawCandidate(resolveAgentModel(models, trimmed.includes('@') ? trimmed : `${model.id}@${trimmed}`))
      }
    }
    addRawCandidate(model)
  }

  const rankedPool = rawPool
    .map((candidate) => toRosterCandidate(candidate, modelBudget, resourceMap))
    .sort(compareRosterCandidates)

  const preferredPool = []
  for (const spec of Array.isArray(preferredModels) ? preferredModels : []) {
    if (typeof spec !== 'string' || !spec.trim()) continue
    const trimmed = spec.trim()
    const resolved = resolveAgentModel(models, trimmed)
    if (resolved) {
      preferredPool.push(toRosterCandidate(resolved, modelBudget, resourceMap))
    } else {
      preferredPool.push({
        id: trimmed,
        modelSpec: trimmed,
        label: trimmed,
        provider: 'custom',
        groupKey: `custom:${trimmed}`,
        billingCategory: 'free',
        ok: true,
        headroom: 1
      })
    }
  }
  for (const scope of Array.isArray(geminiApiPaidModels) ? geminiApiPaidModels : []) {
    if (typeof scope !== 'string' || !scope.trim()) continue
    const trimmed = scope.trim()
    const resolved = resolveAgentModel(models, trimmed.includes('@') ? trimmed : `gemini-api-paid@${trimmed}`)
    if (resolved) {
      preferredPool.push(toRosterCandidate(resolved, modelBudget, resourceMap))
    }
  }

  const selectionPool = []
  const seenSpecs = new Set()
  for (const entry of [...preferredPool, ...rankedPool]) {
    if (seenSpecs.has(entry.modelSpec)) continue
    seenSpecs.add(entry.modelSpec)
    selectionPool.push(entry)
  }

  const pickedWorkers = []
  const usedDomains = new Set()
  const usedWorkerSpecs = new Set()

  // Pass 1: distinct quota domains with headroom.
  for (const entry of selectionPool) {
    if (pickedWorkers.length >= count) break
    if (!entry.ok || usedDomains.has(entry.groupKey)) continue
    pickedWorkers.push(entry)
    usedDomains.add(entry.groupKey)
    usedWorkerSpecs.add(entry.modelSpec)
  }

  // Pass 2: remaining healthy models even if a domain is shared.
  for (const entry of selectionPool) {
    if (pickedWorkers.length >= count) break
    if (!entry.ok || usedWorkerSpecs.has(entry.modelSpec)) continue
    pickedWorkers.push(entry)
    usedDomains.add(entry.groupKey)
    usedWorkerSpecs.add(entry.modelSpec)
  }

  // Pass 3: cycle healthy models, then any candidate when capacity is tight.
  const healthyPool = selectionPool.filter((entry) => entry.ok)
  const fallbackPool = healthyPool.length > 0 ? healthyPool : selectionPool
  let cycleIndex = 0
  while (pickedWorkers.length < count && fallbackPool.length > 0) {
    const entry = fallbackPool[cycleIndex % fallbackPool.length]
    pickedWorkers.push(entry)
    usedDomains.add(entry.groupKey)
    cycleIndex += 1
  }

  const workers = pickedWorkers.map((candidate, index) =>
    toAgentEntry('worker', `worker-${index + 1}`, candidate)
  )

  let reviewer = null
  if (includeReviewer !== false && selectionPool.length > 0) {
    const reviewerCandidate = selectionPool.find(
      (entry) => entry.ok
        && !usedDomains.has(entry.groupKey)
        && entry.utilizationTier === 1
        && !entry.aheadOfPace
        && entry.harvestableSession
    )
      ?? selectionPool.find(
        (entry) => entry.ok
          && !usedDomains.has(entry.groupKey)
          && entry.utilizationTier === 1
          && !entry.aheadOfPace
      )
      ?? rankedPool.find((entry) => entry.ok && !usedDomains.has(entry.groupKey))
      ?? selectionPool.find((entry) => entry.ok && !usedDomains.has(entry.groupKey))
      ?? rankedPool.find((entry) => entry.ok)
      ?? selectionPool[0]
    reviewer = toAgentEntry('reviewer', 'reviewer', reviewerCandidate)
  }

  const parentCandidate = rankedPool.find((entry) => entry.id === 'local-0.5b')
    ?? rankedPool.find((entry) => entry.id === 'local-1.5b')
    ?? rankedPool[0]
    ?? selectionPool[0]
    ?? {
      id: 'deterministic',
      modelSpec: 'deterministic',
      provider: 'local',
      groupKey: 'local',
      limitKind: 'resource',
      billingCategory: 'free',
      ok: true,
      headroom: 1
    }
  const parent = toAgentEntry('parent', 'parent', parentCandidate)

  return {
    parent,
    reviewer,
    workers,
    agents: [parent, ...(reviewer ? [reviewer] : []), ...workers]
  }
}

const KNOWN_MODEL_TPM_LIMITS = Object.freeze({
  'console-groq/openai/gpt-oss-120b': 8000,
  'console-groq/openai/gpt-oss-20b': 8000,
  'openai/gpt-oss-120b': 8000,
  'openai/gpt-oss-20b': 8000,
  'console-groq/meta-llama/llama-4-scout-17b-16e-instruct': 30000,
  'meta-llama/llama-4-scout-17b-16e-instruct': 30000
})

export function estimatePromptTokensForMessages(messages = []) {
  let totalChars = 0
  for (const message of messages) {
    if (typeof message?.content === 'string') {
      totalChars += message.content.length
    }
  }
  return totalChars > 0 ? Math.ceil(totalChars / 3.5) : 0
}

export function knownModelTpmLimit(model) {
  if (!model) return null
  if (Array.isArray(model.limits)) {
    const tpm = model.limits.find((limit) => limit?.unit === 'tokens' && limit?.window === 'minute' && Number.isFinite(limit.limit))
    if (tpm) return tpm.limit
  }
  const candidates = [model.cli?.model, model.id].filter((v) => typeof v === 'string' && v.trim())
  for (const key of candidates) {
    const normalized = key.trim().toLowerCase()
    if (Object.hasOwn(KNOWN_MODEL_TPM_LIMITS, normalized)) {
      return KNOWN_MODEL_TPM_LIMITS[normalized]
    }
  }
  return null
}

export function fitsPromptTpmLimit(model, estimatedPromptTokens, { headroomRatio = 1.15 } = {}) {
  if (!Number.isFinite(estimatedPromptTokens) || estimatedPromptTokens <= 0) return true
  const tpmLimit = knownModelTpmLimit(model)
  if (!Number.isFinite(tpmLimit) || tpmLimit <= 0) return true
  return estimatedPromptTokens * headroomRatio <= tpmLimit
}

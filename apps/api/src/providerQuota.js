// Objective: Turn the flat model roster and quota ledger into provider-level headroom and a deterministic multi-agent dispatch plan.
// Requirements: Never call a model; group models that share a provider quota domain; treat billing category as ordering metadata, never as permission; keep serverless/Ollama slots separate unless they are the same provider; prefer the healthiest, freest model in every plan.
// Decisions: Grouping is pure and data-driven because vendor names and quotas live in the registry; a blocked provider is still reported so the parent can wait instead of probing every backend; the plan is advisory and quota checks remain authoritative at assign time.
// Relevant Files: apps/api/src/providerQuota.js, apps/api/src/modelRegistry.js, apps/api/src/modelBudget.js, apps/api/src/agentBus.js, apps/api/src/routes/models.js
// Important Context: User file. The zero-token half of provider-aware routing.

const BILLING_RANK = new Map([
  ['free', 0],
  ['subscription', 1],
  ['payg', 2]
])

// Each serverless slot and Ollama endpoint may be a different account, so the
// provider name alone is not enough to merge them. Named backends (local,
// colab, kaggle, opencode, ...) share their provider quota domain.
export function modelProviderKey(model) {
  if (!model || typeof model.provider !== 'string' || !model.provider.trim()) return ''
  const provider = model.provider.trim()
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

function billingRank(model) {
  return BILLING_RANK.has(model.billingCategory)
    ? BILLING_RANK.get(model.billingCategory)
    : 3
}

function ratioFor(modelBudget, model) {
  if (modelBudget && typeof modelBudget.headroom === 'function') {
    const result = modelBudget.headroom(model.id, quotaScopeForModel(model))
    return {
      ok: result?.ok !== false,
      ratio: Number.isFinite(result?.ratio) ? result.ratio : (result?.ok === false ? 0 : 1),
      retryAfter: result?.retryAfter,
      budget: result?.budget
    }
  }
  if (modelBudget && typeof modelBudget.check === 'function') {
    const result = modelBudget.check(model.id, quotaScopeForModel(model))
    return {
      ok: result?.ok !== false,
      ratio: result?.ok === false ? 0 : 1,
      retryAfter: result?.retryAfter,
      budget: result?.budget
    }
  }
  return { ok: true, ratio: 1 }
}

function describeModel(model, modelBudget) {
  const quota = ratioFor(modelBudget, model)
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    backend: model.backend,
    billingCategory: model.billingCategory,
    ...(quotaScopeForModel(model) ? { scope: quotaScopeForModel(model) } : {}),
    autoSelect: model.autoSelect ?? true,
    priority: model.priority,
    remote: model.remote === true,
    ok: quota.ok,
    headroom: quota.ratio,
    ...(quota.retryAfter !== undefined ? { retryAfter: quota.retryAfter } : {})
  }
}

function compareModels(a, b) {
  if (a.ok !== b.ok) return a.ok ? -1 : 1
  const billing = billingRank(a) - billingRank(b)
  if (billing !== 0) return billing
  if (a.headroom !== b.headroom) return b.headroom - a.headroom
  return (b.priority ?? 0) - (a.priority ?? 0)
}

/**
 * Return one entry per provider quota domain with the preferred model, the
 * best normalized headroom, and the earliest wait when the provider is
 * blocked. No limiter values are derived here; modelBudget owns the ledger.
 */
export function providerSnapshots({ models = [], modelBudget } = {}) {
  return groupModelsByProvider(models).map((group) => {
    const entries = group.models.map((model) => describeModel(model, modelBudget))
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
  activeAssignments = []
} = {}) {
  const byId = new Map(models.map((model) => [model.id, model]))
  const activeByAgent = new Map()
  for (const assignment of activeAssignments) {
    const agentId = assignment.toAgentId ?? assignment.to_agent_id
    if (!agentId) continue
    activeByAgent.set(agentId, (activeByAgent.get(agentId) ?? 0) + 1)
  }

  const planned = agents.map((agent) => {
    const model = byId.get(agent.model)
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
    const quota = ratioFor(modelBudget, model)
    return {
      name: agent.name,
      role: agent.role,
      model: agent.model,
      provider: model.provider,
      groupKey,
      ...(quotaScopeForModel(model) ? { scope: quotaScopeForModel(model) } : {}),
      resolved: true,
      ok: quota.ok,
      headroom: quota.ratio,
      ...(quota.retryAfter !== undefined ? { retryAfter: quota.retryAfter } : {}),
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
          reason: 'provider quota is exhausted or cooling down',
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

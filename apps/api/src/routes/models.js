// Objective: Own the model roster routes: the callable model list with budgets, the OpenCode roster, and local AI status.
// Requirements: Budgets attach without replacing model status; roster discovery is cached and never runs the CLI in tests.
// Decisions: The OpenCode roster cache resolves lazily inside this group because only the opencode route consumes it; withBudget stays here for the same reason.
// Relevant Files: apps/api/src/routes/models.js, apps/api/src/modelRegistry.js, apps/api/src/opencodeDiscovery.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/models, /api/models/opencode, and /api/local-ai/status.
// Work State: Completed: Extracted from app.js as task #45; offline roster fields added as task #43; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { publicModelDefinition } from '../modelRegistry.js'
import {
  createAgyRosterCacheFromEnv,
  createOpenCodeRosterCacheFromEnv,
  groupOpenCodeModelsByProvider
} from '../opencodeDiscovery.js'
import { providerSnapshots } from '../providerQuota.js'

export function createModelsRouter({
  models,
  modelMetrics,
  modelBudget,
  scheduler,
  opencodeRosterCache,
  agyRosterCache
}) {
  const router = Router()

  function withBudget(status, model = models.find((entry) => entry.id === status.id)) {
    const budget = modelBudget.snapshot(status.id, model?.cli?.model)
    return budget ? { ...status, budget } : status
  }

  router.get('/api/models', (_request, response) => {
    response.json(models.map((model) => withBudget({
      ...publicModelDefinition(model),
      ...(modelMetrics.snapshot(model.id) || {})
    }, model)))
  })

  // Provider headroom groups models that share a quota domain. The response is
  // derived from the same ledger as /api/models and never calls a provider.
  router.get('/api/models/providers', (_request, response) => {
    const providers = providerSnapshots({ models, modelBudget })
    response.json({
      ok: providers.every((provider) => provider.ok),
      providers
    })
  })

  // CLI rosters are discovered from the local CLIs on demand and cached;
  // tests inject caches so the real CLIs never run in the suite.
  let resolvedOpenCodeRosterCache = null
  const getOpenCodeRosterCache = () => {
    if (opencodeRosterCache) return opencodeRosterCache
    if (resolvedOpenCodeRosterCache === null) {
      resolvedOpenCodeRosterCache = createOpenCodeRosterCacheFromEnv()
    }
    return resolvedOpenCodeRosterCache
  }

  let resolvedAgyRosterCache = null
  const getAgyRosterCache = () => {
    if (agyRosterCache) return agyRosterCache
    if (resolvedAgyRosterCache === null) {
      resolvedAgyRosterCache = createAgyRosterCacheFromEnv()
    }
    return resolvedAgyRosterCache
  }

  async function respondWithCliRoster(request, response, {
    slotId,
    missingMessage,
    readErrorMessage,
    getCache,
    extraFields
  }) {
    const slot = models.find((model) => model.id === slotId)
    if (!slot) {
      return response.status(404).json({ error: missingMessage })
    }
    const refresh = ['1', 'true', 'yes'].includes(String(request.query.refresh ?? '').toLowerCase())
    let roster
    try {
      roster = await getCache().get({ refresh })
    } catch {
      return response.status(500).json({ error: readErrorMessage })
    }
    const model = slot.cli?.model ?? null
    return response.json({
      model,
      inRoster: roster.ok ? roster.models.includes(model) : null,
      availableModels: roster.models,
      count: roster.models.length,
      fetchedAt: roster.fetchedAt,
      stale: roster.stale === true,
      source: roster.source ?? 'cli',
      ...(extraFields ? extraFields(model, roster) : {}),
      ...(roster.discoveryError ? { discoveryError: roster.discoveryError } : {}),
      ...(roster.ok ? {} : { error: roster.error })
    })
  }

  router.get('/api/models/opencode', (request, response) => respondWithCliRoster(request, response, {
    slotId: 'opencode',
    missingMessage: 'The OpenCode backend is not registered.',
    readErrorMessage: 'Could not read the OpenCode model roster.',
    getCache: getOpenCodeRosterCache,
    extraFields: (model, roster) => ({
      activeProvider: typeof model === 'string' && model.includes('/') ? model.split('/')[0] : null,
      providers: groupOpenCodeModelsByProvider(roster.models)
    })
  }))

  router.get('/api/models/agy', (request, response) => respondWithCliRoster(request, response, {
    slotId: 'agy',
    missingMessage: 'The Antigravity backend is not registered.',
    readErrorMessage: 'Could not read the Antigravity model roster.',
    getCache: getAgyRosterCache
  }))

  router.get('/api/local-ai/status', async (_request, response) => {
    try {
      const status = await scheduler.status()
      return response.json({
        ...status,
        models: status.models.map((status) => withBudget(status))
      })
    } catch (error) {
      console.error('Local AI status failed:', error)
      return response.json({
        state: 'unavailable',
        error: 'Local AI status is unavailable.'
      })
    }
  })

  return router
}

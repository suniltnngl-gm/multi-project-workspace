const HEALTH_TIMEOUT_MS = 5000
const RETRY_AFTER_SECONDS = 5

export function getModelBusyReasons(model, metrics, cpuLoadLimit, { maxDiskBusyPercent }) {
  const reasons = []

  if (!Number.isFinite(metrics.loadAverage)) {
    reasons.push('CPU load is unavailable')
  } else if (metrics.loadAverage >= cpuLoadLimit) {
    reasons.push(`CPU load ${metrics.loadAverage.toFixed(2)} is at/above ${cpuLoadLimit}`)
  }

  if (!Number.isFinite(metrics.availableMemoryMb)) {
    reasons.push('available memory is unavailable')
  } else if (metrics.availableMemoryMb < model.minAvailableMemoryMb) {
    reasons.push(
      `available memory ${Math.floor(metrics.availableMemoryMb)} MB is below ${model.minAvailableMemoryMb} MB`
    )
  }

  if (!Number.isFinite(metrics.diskBusyPercent)) {
    reasons.push('disk activity is unavailable')
  } else if (metrics.diskBusyPercent > maxDiskBusyPercent) {
    reasons.push(
      `disk busy time ${Math.round(metrics.diskBusyPercent)}% is above ${maxDiskBusyPercent}%`
    )
  }

  return reasons
}

function modelStatus(model, extra = {}) {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    execution: model.execution,
    backend: model.backend,
    callable: model.callable,
    autoSelect: model.autoSelect ?? true,
    priority: model.priority,
    ...(model.billingCategory ? { billingCategory: model.billingCategory } : {}),
    ...(model.minAvailableMemoryMb !== undefined
      ? { minAvailableMemoryMb: model.minAvailableMemoryMb }
      : {}),
    ...(model.notes ? { notes: model.notes } : {}),
    ...extra
  }
}

function isCallable(model) {
  return model.callable ?? model.execution === 'live'
}

export function createModelScheduler({
  models,
  getResourceMetrics,
  getCpuLoadLimit,
  fetchImpl = fetch,
  probeModel,
  apiKey = '',
  minAvailableMemoryMb,
  minCpuLoad,
  maxCpuLoad,
  maxDiskBusyPercent,
  turnCooldownMs,
  getModelMetrics,
  getModelBudget
}) {
  const callableModels = models.filter(isCallable)
  const states = new Map(callableModels.map((model) => [model.id, { inFlight: false }]))
  let nextGenerationAt = 0

  function headersFor(model) {
    // Never send the local llama.cpp key to an external endpoint; remote
    // models must configure their own COLAB_AI_API_KEY/KAGGLE_AI_API_KEY.
    const key = model.apiKey || (model.remote ? '' : apiKey)
    return key ? { Authorization: `Bearer ${key}` } : {}
  }

  function limitsFor(cpuLoadLimit) {
    return {
      cpuLoadLimit,
      minCpuLoad,
      maxCpuLoad,
      minAvailableMemoryMb,
      maxDiskBusyPercent
    }
  }

  async function checkHealth(model) {
    if (probeModel) {
      const result = await probeModel(model)
      if (result === true) return { ok: true }
      if (result === false) return { ok: false }
      return result
    }

    // llama.cpp exposes /health, while generic OpenAI-compatible servers may
    // only expose /v1/models. Accept either so tunnels can be used as-is.
    for (const path of ['/health', '/v1/models']) {
      try {
        const response = await fetchImpl(`${model.url}${path}`, {
          headers: headersFor(model),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
        })
        if (response.ok) return { ok: true }
      } catch {
        // Try the next probe.
      }
    }
    return { ok: false }
  }

  async function evaluate() {
    let metrics
    let metricsError
    try {
      metrics = await getResourceMetrics()
    } catch (error) {
      metricsError = error
    }

    const cpuLoadLimit = metrics ? getCpuLoadLimit(metrics.loadAverage) : undefined
    const now = Date.now()
    const coolingDown = now < nextGenerationAt

    const statuses = await Promise.all(models.map(async (model) => {
      if (!isCallable(model)) {
        return modelStatus(model, { state: model.execution, available: false })
      }
      if (metricsError && !model.remote) {
        return modelStatus(model, {
          state: 'unavailable',
          available: false,
          error: 'Local AI resource monitoring is unavailable.'
        })
      }
      if (states.get(model.id).inFlight) {
        return modelStatus(model, {
          state: 'busy',
          available: false,
          busyReasons: ['A local model request is already in progress.']
        })
      }
      if (coolingDown) {
        return modelStatus(model, {
          state: 'busy',
          available: false,
          busyReasons: ['Cooling down between local model turns.']
        })
      }

      // Remote models do not consume this machine's CPU, memory, or disk, so
      // only the shared turn cooldown and per-model in-flight state apply.
      const busyReasons = model.remote
        ? []
        : getModelBusyReasons(model, metrics, cpuLoadLimit, { maxDiskBusyPercent })
      if (busyReasons.length > 0) {
        return modelStatus(model, { state: 'busy', available: false, busyReasons })
      }
      const health = await checkHealth(model)
      if (!health.ok) {
        return modelStatus(model, {
          state: 'unavailable',
          available: false,
          error: health.error || `The endpoint for ${model.label} is unavailable.`
        })
      }
      return modelStatus(model, {
        state: 'ready',
        available: true,
        ...(health.sessionState ? { sessionState: health.sessionState } : {})
      })
    }))

    const result = {
      models: statuses.map((status) => {
        const metrics = getModelMetrics?.(status.id)
        return metrics ? { ...status, ...metrics } : status
      })
    }
    if (metrics) {
      result.metrics = metrics
      result.limits = limitsFor(cpuLoadLimit)
    }

    if (statuses.some((status) => status.state === 'ready')) {
      result.state = 'ready'
      return result
    }
    if (metricsError) {
      result.state = 'unavailable'
      result.error = 'Local AI resource monitoring is unavailable.'
      return result
    }
    if (coolingDown) {
      result.state = 'busy'
      result.busyReasons = ['Cooling down between local model turns.']
      result.retryAfter = Math.max(1, Math.ceil((nextGenerationAt - now) / 1000))
      return result
    }

    const busyStatuses = statuses.filter((status) => status.state === 'busy')
    if (busyStatuses.length > 0) {
      // Report the least-demanding model's reasons so the message names the
      // limit that has to clear first, not every model-specific threshold.
      const fallback = [...busyStatuses]
        .sort((a, b) => a.minAvailableMemoryMb - b.minAvailableMemoryMb)[0]
      result.state = 'busy'
      result.busyReasons = fallback.busyReasons
      result.retryAfter = RETRY_AFTER_SECONDS
      return result
    }

    result.state = 'unavailable'
    result.error = statuses.find((status) => status.state === 'unavailable')?.error
      || 'No local model is available.'
    return result
  }

  function budgetFor(status) {
    if (typeof getModelBudget !== 'function') return undefined
    try {
      return getModelBudget(status)
    } catch (error) {
      console.error(`Could not read the AI budget for ${status.id}: ${error.message}`)
      return undefined
    }
  }

  function budgetHeadroom(result) {
    if (!result) return { ok: true, ratio: 1 }
    if (result.ok === false) return { ok: false, ratio: 0 }
    const limiters = result.budget?.limiters ?? []
    const scored = limiters.filter(
      (limiter) => Number.isFinite(limiter.limit) && limiter.limit > 0
    )
    return {
      ok: true,
      ratio: scored.length === 0
        ? 1
        : Math.min(...scored.map((limiter) => limiter.remaining / limiter.limit))
    }
  }

  async function select(requestedModelId) {
    let requested
    if (requestedModelId !== undefined) {
      requested = models.find((model) => model.id === requestedModelId)
      if (!requested) {
        return { error: { status: 400, body: { error: `Unknown model: ${requestedModelId}.` } } }
      }
      if (!isCallable(requested)) {
        return {
          error: {
            status: 400,
            body: {
              error: `${requested.label} runs as ${requested.execution} and cannot be called.`
            }
          }
        }
      }
    }

    const evaluation = await evaluate()
    const requestedStatus = requested
      ? evaluation.models.find((status) => status.id === requested.id)
      : undefined

    if (requestedStatus && requestedStatus.state !== 'ready') {
      return {
        error: {
          status: 503,
          body: {
            ...evaluation,
            state: requestedStatus.state,
            error: requestedStatus.error || 'The requested local model is not ready.',
            busyReasons: requestedStatus.busyReasons,
            ...(requestedStatus.state === 'busy'
              ? { retryAfter: evaluation.retryAfter ?? RETRY_AFTER_SECONDS }
              : {})
          }
        }
      }
    }

    if (evaluation.state !== 'ready') {
      return {
        error: {
          status: 503,
          body: {
            ...evaluation,
            error: evaluation.error || 'Local AI is paused while the machine is busy.'
          }
        }
      }
    }

    const candidates = evaluation.models
      .filter((status) => {
        if (status.state !== 'ready') return false
        return requested ? status.id === requested.id : status.autoSelect
      })
      .map((status) => ({
        status,
        quota: budgetHeadroom(budgetFor(status))
      }))
      .sort((a, b) => {
        // A model with provider headroom wins over one that is cooling down or
        // exhausted. This is the main quota-saving path for automatic routing:
        // a free provider with room is tried before a constrained one is
        // touched, instead of selecting it and returning 429.
        if (a.quota.ok !== b.quota.ok) return a.quota.ok ? -1 : 1

        const failuresA = Number.isFinite(a.status.failures) ? a.status.failures : 0
        const failuresB = Number.isFinite(b.status.failures) ? b.status.failures : 0
        if (failuresA !== failuresB) return failuresA - failuresB

        if (a.quota.ratio !== b.quota.ratio) return b.quota.ratio - a.quota.ratio

        const durationA = Number.isFinite(a.status.lastDurationMs) ? a.status.lastDurationMs : Number.MAX_SAFE_INTEGER
        const durationB = Number.isFinite(b.status.lastDurationMs) ? b.status.lastDurationMs : Number.MAX_SAFE_INTEGER
        if (durationA !== durationB) return durationA - durationB

        return b.status.priority - a.status.priority
      })
    const chosen = (candidates.find((candidate) => (
      candidate.quota.ok && !states.get(candidate.status.id).inFlight
    )) ?? candidates.find((candidate) => !states.get(candidate.status.id).inFlight))?.status
    if (!chosen) {
      if (!requested) {
        const busyStatuses = evaluation.models.filter((status) => status.state === 'busy')
        if (busyStatuses.length === 0) {
          return {
            error: {
              status: 503,
              body: {
                ...evaluation,
                state: 'unavailable',
                error: 'No model is available for automatic selection.',
                models: evaluation.models
              }
            }
          }
        }
      }
      return {
        error: {
          status: 503,
          body: {
            state: 'busy',
            error: requested
              ? `${requested.label} is already handling a request.`
              : 'All local models are already handling requests.',
            busyReasons: ['A local model request is already in progress.'],
            retryAfter: RETRY_AFTER_SECONDS,
            models: evaluation.models
          }
        }
      }
    }

    const model = models.find((candidate) => candidate.id === chosen.id)
    const modelState = states.get(model.id)
    modelState.inFlight = true

    return {
      model,
      release: ({ inferenceStarted = false } = {}) => {
        modelState.inFlight = false
        if (inferenceStarted) {
          nextGenerationAt = Date.now() + turnCooldownMs
        }
      }
    }
  }

  return {
    status: evaluate,
    select
  }
}

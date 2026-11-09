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
    priority: model.priority,
    ...(model.minAvailableMemoryMb !== undefined
      ? { minAvailableMemoryMb: model.minAvailableMemoryMb }
      : {}),
    ...(model.notes ? { notes: model.notes } : {}),
    ...extra
  }
}

export function createModelScheduler({
  models,
  getResourceMetrics,
  getCpuLoadLimit,
  fetchImpl = fetch,
  apiKey = '',
  minAvailableMemoryMb,
  minCpuLoad,
  maxCpuLoad,
  maxDiskBusyPercent,
  turnCooldownMs
}) {
  const liveModels = models.filter((model) => model.execution === 'live')
  const states = new Map(liveModels.map((model) => [model.id, { inFlight: false }]))
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  let nextGenerationAt = 0

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
    try {
      const response = await fetchImpl(`${model.url}/health`, {
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      })
      return response.ok
    } catch {
      return false
    }
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
      if (model.execution !== 'live') {
        return modelStatus(model, { state: model.execution, available: false })
      }
      if (metricsError) {
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

      const busyReasons = getModelBusyReasons(model, metrics, cpuLoadLimit, {
        maxDiskBusyPercent
      })
      if (busyReasons.length > 0) {
        return modelStatus(model, { state: 'busy', available: false, busyReasons })
      }
      if (!(await checkHealth(model))) {
        return modelStatus(model, {
          state: 'unavailable',
          available: false,
          error: `Configured endpoint for ${model.label} is unavailable.`
        })
      }
      return modelStatus(model, { state: 'ready', available: true })
    }))

    const result = { models: statuses }
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

  async function select(requestedModelId) {
    let requested
    if (requestedModelId !== undefined) {
      requested = models.find((model) => model.id === requestedModelId)
      if (!requested) {
        return { error: { status: 400, body: { error: `Unknown model: ${requestedModelId}.` } } }
      }
      if (requested.execution !== 'live') {
        return {
          error: {
            status: 400,
            body: {
              error: `${requested.label} runs as ${requested.execution} and cannot be called live.`
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
      .filter((status) => status.state === 'ready' && (!requested || status.id === requested.id))
      .sort((a, b) => b.priority - a.priority)
    const chosen = candidates.find((status) => !states.get(status.id).inFlight)
    if (!chosen) {
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

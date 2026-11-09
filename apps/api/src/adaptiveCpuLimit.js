const OBSERVATION_INTERVAL_MS = 5000
const OVERLOAD_DURATION_MS = 10000
const RECOVERY_DURATION_MS = 30000
const LOAD_HYSTERESIS = 0.15
const LOAD_DECREASE_STEP = 0.1
const LOAD_RECOVERY_STEP = 0.05

export function createAdaptiveCpuLimit({
  minLoad,
  maxLoad,
  getTime = () => performance.now()
}) {
  if (!Number.isFinite(minLoad) || minLoad < 0) {
    throw new Error('Minimum CPU load limit must be a non-negative number.')
  }
  if (!Number.isFinite(maxLoad) || maxLoad < minLoad) {
    throw new Error('Maximum CPU load limit must be at least the minimum limit.')
  }

  let currentLimit = maxLoad
  let lastObservationAt
  let overloadSince
  let recoverySince

  return function observeCpuLoad(loadAverage) {
    const now = getTime()
    if (!Number.isFinite(loadAverage)) return currentLimit
    if (lastObservationAt !== undefined && now - lastObservationAt < OBSERVATION_INTERVAL_MS) {
      return currentLimit
    }
    lastObservationAt = now

    if (loadAverage >= currentLimit) {
      recoverySince = undefined
      overloadSince ??= now
      if (now - overloadSince >= OVERLOAD_DURATION_MS) {
        currentLimit = Math.max(minLoad, Math.round((currentLimit - LOAD_DECREASE_STEP) * 100) / 100)
        overloadSince = now
      }
    } else if (loadAverage < currentLimit - LOAD_HYSTERESIS) {
      overloadSince = undefined
      recoverySince ??= now
      if (now - recoverySince >= RECOVERY_DURATION_MS) {
        currentLimit = Math.min(maxLoad, Math.round((currentLimit + LOAD_RECOVERY_STEP) * 100) / 100)
        recoverySince = now
      }
    } else {
      overloadSince = undefined
      recoverySince = undefined
    }

    return currentLimit
  }
}

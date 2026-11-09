/**
 * Objective: Implement and maintain apps/api/src/modelMetrics.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/api/src/modelMetrics.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
/**
 * Ephemeral per-model usage statistics surfaced in the API status responses.
 * They describe the current API process; nothing here is persisted.
 */
export function createModelMetrics({ now = Date.now } = {}) {
  const stats = new Map()

  function entry(id) {
    let value = stats.get(id)
    if (!value) {
      value = { requests: 0, failures: 0 }
      stats.set(id, value)
    }
    return value
  }

  function recordStart(id) {
    entry(id).requests += 1
  }

  function recordSuccess(id, { durationMs } = {}) {
    const value = entry(id)
    value.lastUsedAt = now()
    if (Number.isFinite(durationMs)) value.lastDurationMs = durationMs
    delete value.lastError
    delete value.lastErrorAt
  }

  function recordError(id, error, { durationMs } = {}) {
    const value = entry(id)
    value.failures += 1
    value.lastError = error?.message || String(error)
    value.lastErrorAt = now()
    if (Number.isFinite(durationMs)) value.lastDurationMs = durationMs
  }

  function snapshot(id) {
    const value = stats.get(id)
    return value ? { ...value } : undefined
  }

  return { recordStart, recordSuccess, recordError, snapshot }
}

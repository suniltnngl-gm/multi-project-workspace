/**
 * Daily request guardrails for quota-backed remote models. Counters reset at
 * UTC midnight and are persisted through an optional repository so an API
 * restart does not forget the quota already spent today.
 */
function readLimit(env, key) {
  const value = env[key]
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number.`)
  }
  return Math.floor(parsed)
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10)
}

function msUntilNextDay(now) {
  const date = new Date(now)
  const next = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1
  )
  return Math.max(0, next - now)
}

export function createModelBudget({ env = process.env, now = Date.now, repository } = {}) {
  const limits = new Map()
  for (const [id, key] of [
    ['colab-3b', 'COLAB_AI_MAX_REQUESTS_PER_DAY'],
    ['kaggle-3b', 'KAGGLE_AI_MAX_REQUESTS_PER_DAY']
  ]) {
    const limit = readLimit(env, key)
    if (limit !== null) limits.set(id, limit)
  }

  const counters = new Map()

  function state(id) {
    const day = dayKey(now())
    let value = counters.get(id)
    if (!value || value.day !== day) {
      let used = 0
      try {
        used = repository?.getBudget?.(id, day) ?? 0
      } catch (error) {
        console.error(`Could not read the AI budget for ${id}: ${error.message}`)
      }
      value = { day, used }
      counters.set(id, value)
    }
    return value
  }

  function snapshot(id) {
    const limit = limits.get(id)
    if (limit === undefined) return undefined
    const value = state(id)
    return {
      limit,
      used: value.used,
      remaining: Math.max(0, limit - value.used),
      day: value.day,
      resetsInSeconds: Math.ceil(msUntilNextDay(now()) / 1000)
    }
  }

  function check(id) {
    const budget = snapshot(id)
    if (!budget) return { ok: true }
    if (budget.used < budget.limit) return { ok: true, budget }
    return { ok: false, budget, retryAfter: budget.resetsInSeconds }
  }

  function record(id) {
    if (!limits.has(id)) return
    const value = state(id)
    value.used += 1
    try {
      const stored = repository?.incrementBudget?.(id, value.day)
      if (Number.isFinite(stored)) value.used = stored
    } catch (error) {
      console.error(`Could not persist the AI budget for ${id}: ${error.message}`)
    }
  }

  function prune(repositoryDay) {
    try {
      repository?.pruneBudgetBefore?.(repositoryDay)
    } catch (error) {
      console.error(`Could not prune the AI budget: ${error.message}`)
    }
  }

  // Only the current UTC day matters; older rows are safe to remove.
  prune(dayKey(now()))

  return { check, record, snapshot, prune }
}

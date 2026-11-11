/**
 * Provider-agnostic quota accounting.
 *
 * A model can carry several limiters at once (for example per-minute requests
 * plus a daily token pool). A limiter describes shape only:
 *   - unit:   requests | tokens | compute_seconds
 *   - window: minute | hour | session | day | week | month | none
 *   - reset:  rolling (in-memory sliding window)
 *             fixed   (persisted bucket aligned to a clock boundary)
 *             pool    (persisted depleting bucket, no automatic reset)
 *
 * Values come from AI_QUOTA_PROFILES or the legacy *_MAX_REQUESTS_PER_DAY
 * variables. No vendor table lives in source, and HTTP 429 stays authoritative.
 *
 * Observation layers a separate ledger on top for models whose limits are not
 * configured: every request counts into an observed-requests day bucket, and a
 * 429 with a retry delay records a marker plus a cooldown. The smallest
 * used-at-failure seen today becomes a learned cap that tightens only and
 * never overwrites configured profiles; token usage is never guessed, so
 * recordUsage stays gated on configured metered limits.
 */
const MINUTE = 60000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const RETENTION_MS = 400 * DAY
const WINDOW_MS = { minute: MINUTE, hour: HOUR, day: DAY, week: WEEK }
const UNIT_NAMES = new Set(['requests', 'tokens', 'compute_seconds'])
const WINDOW_NAMES = new Set(['minute', 'hour', 'session', 'day', 'week', 'month', 'none'])
const RESET_NAMES = new Set(['rolling', 'fixed', 'pool'])
// Observation ledger policies live in the same ai_quota rows but under their
// own names, so learned behavior can never collide with configured profiles.
const OBSERVED_REQUESTS_POLICY = 'observed-requests'
const OBSERVED_429_POLICY = 'observed-429'
const OBSERVED_COOLDOWN_POLICY = 'observed-cooldown'
// The observed ledger buckets on UTC day boundaries; the learned cap is
// applied as its own limiter shape when a cap exists.
const OBSERVED_DAY = {
  policy: 'observed-day',
  unit: 'requests',
  limit: Infinity,
  window: 'day',
  reset: 'fixed',
  timezone: 'UTC',
  windowMs: DAY,
  usage: 'total'
}
const zoneFormats = new Map()
const LEGACY_LIMITS = [
  ['serverless', 'SERVERLESS_AI_MAX_REQUESTS_PER_DAY'],
  ['colab-3b', 'COLAB_AI_MAX_REQUESTS_PER_DAY'],
  ['kaggle-3b', 'KAGGLE_AI_MAX_REQUESTS_PER_DAY'],
  ['opencode', 'OPENCODE_AI_MAX_REQUESTS_PER_DAY'],
  ['ollama', 'OLLAMA_AI_MAX_REQUESTS_PER_DAY']
]

function readLimit(env, key) {
  const value = env[key]
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number.`)
  }
  return Math.floor(parsed)
}

function readCount(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10)
}

function partsInZone(ms, timeZone) {
  let format = zoneFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    zoneFormats.set(timeZone, format)
  }
  const parts = {}
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

function zoneOffset(ms, timeZone) {
  const at = Math.floor(ms / 1000) * 1000
  const parts = partsInZone(at, timeZone)
  return Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  ) - at
}

// Convert a wall-clock date in a time zone to an epoch. Two passes settle the
// offset across a daylight-saving transition.
function zonedEpoch(year, month, day, timeZone) {
  const guess = Date.UTC(year, month - 1, day)
  const first = guess - zoneOffset(guess, timeZone)
  return guess - zoneOffset(first, timeZone)
}

function startOfFixedWindow(at, limit) {
  if (limit.window === 'hour') {
    const offset = zoneOffset(at, limit.timezone)
    return Math.floor((at + offset) / HOUR) * HOUR - offset
  }
  const parts = partsInZone(at, limit.timezone)
  if (limit.window === 'month') {
    return zonedEpoch(parts.year, parts.month, 1, limit.timezone)
  }
  if (limit.window === 'day') {
    return zonedEpoch(parts.year, parts.month, parts.day, limit.timezone)
  }
  // Weeks start on Monday in the configured time zone.
  const localDate = Date.UTC(parts.year, parts.month - 1, parts.day)
  const dayOfWeek = new Date(localDate).getUTCDay()
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const monday = new Date(localDate - daysSinceMonday * DAY)
  return zonedEpoch(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    limit.timezone
  )
}

function nextFixedBoundary(bucket, limit) {
  if (limit.window === 'session') return bucket + limit.windowMs
  if (limit.window === 'hour') return bucket + HOUR
  const parts = partsInZone(bucket, limit.timezone)
  if (limit.window === 'month') {
    return zonedEpoch(parts.year, parts.month + 1, 1, limit.timezone)
  }
  if (limit.window === 'day') {
    return zonedEpoch(parts.year, parts.month, parts.day + 1, limit.timezone)
  }
  return zonedEpoch(parts.year, parts.month, parts.day + 7, limit.timezone)
}

function normalizeLimits(id, raw) {
  if (!Array.isArray(raw)) {
    throw new Error(`The quota profile for ${id} must be an array of limiters.`)
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Quota limiter ${index} for ${id} must be an object.`)
    }
    const unit = entry.unit ?? 'requests'
    if (!UNIT_NAMES.has(unit)) {
      throw new Error(`Quota limiter ${index} for ${id} has an unknown unit.`)
    }
    const reset = entry.reset ?? 'fixed'
    if (!RESET_NAMES.has(reset)) {
      throw new Error(`Quota limiter ${index} for ${id} has an unknown reset mode.`)
    }
    const window = entry.window ?? (reset === 'pool' ? 'none' : 'day')
    if (!WINDOW_NAMES.has(window)) {
      throw new Error(`Quota limiter ${index} for ${id} has an unknown window.`)
    }
    if (reset === 'rolling' && !['minute', 'hour'].includes(window)) {
      throw new Error(
        `Quota limiter ${index} for ${id} cannot roll a ${window} window; use a fixed reset.`
      )
    }
    if (window === 'none' && reset !== 'pool') {
      throw new Error(
        `Quota limiter ${index} for ${id} needs a window unless it is a pool.`
      )
    }
    const limit = readCount(entry.limit)
    if (limit === null) {
      throw new Error(`Quota limiter ${index} for ${id} needs a non-negative numeric limit.`)
    }
    const timezone = entry.timezone ?? 'UTC'
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
      throw new Error(`Quota limiter ${index} for ${id} has an unknown time zone "${timezone}".`)
    }
    let windowMs
    if (window === 'session') {
      windowMs = Number(entry.windowMs ?? Number(entry.hours) * HOUR)
      if (!Number.isFinite(windowMs) || windowMs <= 0) {
        throw new Error(
          `Quota limiter ${index} for ${id} needs windowMs or hours for a session window.`
        )
      }
    } else if (WINDOW_MS[window]) {
      windowMs = WINDOW_MS[window]
    }
    return {
      policy: String(entry.id ?? entry.policy ?? `${index}:${unit}:${window}:${reset}`),
      unit,
      limit,
      window,
      reset,
      timezone,
      windowMs,
      usage: entry.usage ?? 'total'
    }
  })
}

function parseProfileJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AI_QUOTA_PROFILES must be valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI_QUOTA_PROFILES must be a JSON object keyed by model id.')
  }
  const result = new Map()
  for (const [id, limits] of Object.entries(parsed)) {
    result.set(id, normalizeLimits(id, limits))
  }
  return result
}

/**
 * Normalize the active quota profiles from an explicit registry profile map,
 * AI_QUOTA_PROFILES, and the legacy daily shorthand. Returns a Map keyed by
 * model id; callers can use it for diagnostics without creating a budget.
 */
export function resolveQuotaProfiles({ env = process.env, profiles } = {}) {
  let result
  if (profiles instanceof Map) {
    result = new Map()
    for (const [id, limits] of profiles) {
      result.set(id, normalizeLimits(id, limits))
    }
  } else if (profiles && typeof profiles === 'object') {
    result = new Map()
    for (const [id, limits] of Object.entries(profiles)) {
      result.set(id, normalizeLimits(id, limits))
    }
  } else {
    result = new Map()
  }

  if (env.AI_QUOTA_PROFILES) {
    for (const [id, limits] of parseProfileJson(env.AI_QUOTA_PROFILES)) {
      if (!result.has(id)) result.set(id, limits)
    }
  }

  for (const [id, key] of LEGACY_LIMITS) {
    if (result.has(id)) continue
    const limit = readLimit(env, key)
    if (limit !== null) {
      result.set(id, [{
        policy: '0:requests:day:fixed',
        unit: 'requests',
        limit,
        window: 'day',
        reset: 'fixed',
        timezone: 'UTC',
        windowMs: DAY,
        usage: 'total'
      }])
    }
  }

  return result
}

export function createModelBudget({
  env = process.env,
  now = Date.now,
  repository,
  profiles
} = {}) {
  const configs = resolveQuotaProfiles({ env, profiles })
  const rolling = new Map()
  const memoryBuckets = new Map()
  const usageSeen = new Map()
  const cooldowns = new Map()

  function memoryKey(id, policy, bucket) {
    return `${id}|${policy}|${bucket}`
  }

  function readBucket(id, policy, bucket) {
    try {
      if (typeof repository?.getQuota === 'function') {
        return repository.getQuota(id, policy, bucket) ?? 0
      }
    } catch (error) {
      console.error(`Could not read the AI quota for ${id}: ${error.message}`)
    }
    return memoryBuckets.get(memoryKey(id, policy, bucket)) ?? 0
  }

  function addBucket(id, policy, bucket, amount) {
    try {
      if (typeof repository?.addQuota === 'function') {
        return repository.addQuota(id, policy, bucket, amount)
      }
    } catch (error) {
      console.error(`Could not persist the AI quota for ${id}: ${error.message}`)
    }
    const key = memoryKey(id, policy, bucket)
    const used = (memoryBuckets.get(key) ?? 0) + amount
    memoryBuckets.set(key, used)
    return used
  }

  function latestBucket(id, policy) {
    try {
      if (typeof repository?.getLatestQuota === 'function') {
        const row = repository.getLatestQuota(id, policy)
        return row ? Number(row.bucket) : null
      }
    } catch (error) {
      console.error(`Could not read the latest AI quota for ${id}: ${error.message}`)
    }
    let best = null
    const prefix = `${id}|${policy}|`
    for (const key of memoryBuckets.keys()) {
      if (!key.startsWith(prefix)) continue
      const bucket = Number(key.slice(prefix.length))
      if (Number.isFinite(bucket) && (best === null || bucket > best)) best = bucket
    }
    return best
  }

  function listBuckets(id, policy) {
    try {
      if (typeof repository?.listQuota === 'function') {
        return repository.listQuota(id, policy)
      }
    } catch (error) {
      console.error(`Could not list the AI quota for ${id}: ${error.message}`)
    }
    const rows = []
    const prefix = `${id}|${policy}|`
    for (const [key, used] of memoryBuckets) {
      if (!key.startsWith(prefix)) continue
      const bucket = Number(key.slice(prefix.length))
      if (Number.isFinite(bucket)) rows.push({ bucket, used })
    }
    return rows
  }

  function listBucketsByPolicy(policy) {
    try {
      if (typeof repository?.listQuotaByPolicy === 'function') {
        return repository.listQuotaByPolicy(policy)
      }
    } catch (error) {
      console.error(`Could not list the AI quota for ${policy}: ${error.message}`)
    }
    const rows = []
    const marker = `|${policy}|`
    for (const [key, used] of memoryBuckets) {
      const at = key.indexOf(marker)
      if (at === -1) continue
      const model = key.slice(0, at)
      const bucket = Number(key.slice(at + marker.length))
      if (model && Number.isFinite(bucket)) rows.push({ model, bucket, used })
    }
    return rows
  }

  // Learned cap: the smallest observed request count at which a 429 struck
  // today. Markers from earlier days never apply, so a new day starts fresh.
  function observedCap(id, at) {
    const dayStart = startOfFixedWindow(at, OBSERVED_DAY)
    const dayEnd = nextFixedBoundary(dayStart, OBSERVED_DAY)
    let cap = null
    for (const row of listBuckets(id, OBSERVED_429_POLICY)) {
      const bucket = Number(row.bucket)
      if (!Number.isFinite(bucket) || bucket < dayStart || bucket >= dayEnd) continue
      const usedAtFailure = Number(row.used)
      if (!Number.isFinite(usedAtFailure)) continue
      if (cap === null || usedAtFailure < cap) cap = usedAtFailure
    }
    return cap
  }

  function rollingEvents(id, limit, at) {
    const key = `${id}|${limit.policy}`
    let events = rolling.get(key)
    if (!events) {
      events = []
      rolling.set(key, events)
    }
    const cutoff = at - limit.windowMs
    while (events.length > 0 && events[0].at <= cutoff) events.shift()
    return events
  }

  function bucketFor(id, limit, at) {
    if (limit.reset === 'pool') return 0
    if (limit.reset === 'rolling') return null
    if (limit.window === 'session') {
      const latest = latestBucket(id, limit.policy)
      if (latest !== null && at < latest + limit.windowMs) return latest
      return at
    }
    return startOfFixedWindow(at, limit)
  }

  function usedFor(id, limit, at) {
    if (limit.reset === 'rolling') {
      return rollingEvents(id, limit, at).reduce((sum, event) => sum + event.amount, 0)
    }
    return readBucket(id, limit.policy, bucketFor(id, limit, at))
  }

  function addAmount(id, limit, amount, at) {
    if (!Number.isFinite(amount) || amount <= 0) return
    if (limit.reset === 'rolling') {
      rollingEvents(id, limit, at).push({ at, amount })
      return
    }
    addBucket(id, limit.policy, bucketFor(id, limit, at), amount)
  }

  // A request needs room for one more; tokens and compute only need headroom.
  function withinLimit(used, limit) {
    return limit.unit === 'requests'
      ? used + 1 <= limit.limit
      : used < limit.limit
  }

  function rollingRetryAt(id, limit, at) {
    const events = rollingEvents(id, limit, at)
    let used = events.reduce((sum, event) => sum + event.amount, 0)
    if (withinLimit(used, limit)) return at
    for (const event of events) {
      used -= event.amount
      if (withinLimit(used, limit)) return event.at + limit.windowMs
    }
    return null
  }

  function retryAtFor(id, limit, at) {
    if (limit.reset === 'rolling') return rollingRetryAt(id, limit, at)
    if (limit.reset === 'pool') return null
    return nextFixedBoundary(bucketFor(id, limit, at), limit)
  }

  function resetSecondsFor(id, limit, at, used) {
    if (withinLimit(used, limit)) return 0
    const retryAt = retryAtFor(id, limit, at)
    if (retryAt === null) return null
    return Math.max(0, Math.ceil((retryAt - at) / 1000))
  }

  function snapshot(id) {
    const limits = configs.get(id)
    const at = now()
    const dayBucket = startOfFixedWindow(at, OBSERVED_DAY)
    const observedRequests = readBucket(id, OBSERVED_REQUESTS_POLICY, dayBucket)
    const cap = observedCap(id, at)
    const hasObserved = observedRequests > 0 || cap !== null
    if ((!limits || limits.length === 0) && !hasObserved) return undefined
    const cooldownUntil = cooldowns.get(id) ?? 0
    const limiters = (limits ?? []).map((limit) => {
      const used = usedFor(id, limit, at)
      const bucket = limit.reset === 'rolling' || limit.reset === 'pool'
        ? null
        : bucketFor(id, limit, at)
      return {
        policy: limit.policy,
        unit: limit.unit,
        window: limit.window,
        reset: limit.reset,
        limit: limit.limit,
        used,
        remaining: Math.max(0, limit.limit - used),
        ok: withinLimit(used, limit),
        resetsInSeconds: resetSecondsFor(id, limit, at, used),
        bucket,
        ...(limit.unit !== 'requests' && usageSeen.has(id)
          ? { usageSupported: usageSeen.get(id) }
          : {})
      }
    })
    if (cap !== null) {
      // The learned limiter gates after configured ones: once today's
      // observed requests reach the learned cap, the model waits for the
      // next UTC day boundary.
      const used = observedRequests
      const ok = used + 1 <= cap
      limiters.push({
        policy: OBSERVED_DAY.policy,
        unit: 'requests',
        window: 'day',
        reset: 'fixed',
        limit: cap,
        used,
        remaining: Math.max(0, cap - used),
        ok,
        resetsInSeconds: ok
          ? 0
          : Math.max(1, Math.ceil((nextFixedBoundary(dayBucket, OBSERVED_DAY) - at) / 1000)),
        bucket: dayBucket,
        observed: true
      })
    }
    const cooldownSeconds = cooldownUntil > at
      ? Math.max(1, Math.ceil((cooldownUntil - at) / 1000))
      : 0
    if (limiters.length === 0) {
      // Unprofiled model with observed usage but no learned cap yet: report
      // the ledger without inventing a primary limiter.
      return {
        ok: cooldownSeconds === 0,
        limiters,
        observed: { requests: observedRequests },
        ...(cooldownSeconds > 0 ? { cooldownSeconds, retryAfter: cooldownSeconds } : {})
      }
    }
    const primary = [...limiters].sort((a, b) => {
      const ratioA = a.limit === 0 ? -1 : a.remaining / a.limit
      const ratioB = b.limit === 0 ? -1 : b.remaining / b.limit
      return ratioA - ratioB
    })[0]
    const blocked = limiters.filter((limiter) => !limiter.ok)
    const waits = blocked.map((limiter) => limiter.resetsInSeconds)
    const retryAfter = cooldownSeconds > 0
      ? cooldownSeconds
      : (waits.length === 0
        ? 0
        : (waits.some((value) => value === null)
          ? null
          : Math.max(...waits)))
    const ok = blocked.length === 0 && cooldownSeconds === 0

    return {
      ok,
      unit: primary.unit,
      window: primary.window,
      reset: primary.reset,
      limit: primary.limit,
      used: primary.used,
      remaining: primary.remaining,
      resetsInSeconds: primary.resetsInSeconds,
      ...(primary.window === 'day' && primary.bucket !== null
        ? { day: dayKey(primary.bucket) }
        : {}),
      ...(cooldownSeconds > 0 ? { cooldownSeconds } : {}),
      ...(!ok && retryAfter !== 0 ? { retryAfter } : {}),
      limiters,
      ...(hasObserved
        ? {
          observed: {
            requests: observedRequests,
            ...(cap !== null ? { cap } : {})
          }
        }
        : {})
    }
  }

  function check(id) {
    const budget = snapshot(id)
    if (!budget) return { ok: true }
    if (budget.ok) return { ok: true, budget }
    return { ok: false, budget, retryAfter: budget.retryAfter }
  }

  function record(id, amount = 1) {
    const at = now()
    const count = Number(amount)
    if (!Number.isFinite(count) || count <= 0) return
    const limits = configs.get(id)
    for (const limit of limits ?? []) {
      if (limit.unit === 'requests') addAmount(id, limit, count, at)
    }
    // Observation counts every real request, profiled or not.
    addBucket(id, OBSERVED_REQUESTS_POLICY, startOfFixedWindow(at, OBSERVED_DAY), count)
  }

  function recordUsage(id, usage) {
    const limits = configs.get(id)
    const metered = limits?.filter((limit) => limit.unit !== 'requests') ?? []
    if (metered.length === 0) return

    const at = now()
    const prompt = Number(usage?.promptTokens ?? usage?.prompt_tokens)
    const completion = Number(usage?.completionTokens ?? usage?.completion_tokens)
    const total = Number(usage?.totalTokens ?? usage?.total_tokens)
    const haveTokens = Number.isFinite(total)
      || (Number.isFinite(prompt) && Number.isFinite(completion))
    const compute = Number(usage?.computeSeconds ?? usage?.compute_seconds)
    const haveCompute = Number.isFinite(compute)

    for (const limit of metered) {
      if (limit.unit === 'tokens') {
        if (!haveTokens) {
          usageSeen.set(id, false)
          continue
        }
        let amount
        if (limit.usage === 'input') amount = prompt
        else if (limit.usage === 'output') amount = completion
        else amount = Number.isFinite(total) ? total : prompt + completion
        if (Number.isFinite(amount) && amount > 0) {
          usageSeen.set(id, true)
          addAmount(id, limit, amount, at)
        } else {
          usageSeen.set(id, false)
        }
        continue
      }
      if (limit.unit === 'compute_seconds') {
        if (!haveCompute || compute <= 0) {
          usageSeen.set(id, false)
          continue
        }
        usageSeen.set(id, true)
        addAmount(id, limit, compute, at)
      }
    }
  }

  function cooldown(id, seconds) {
    const value = Number(seconds)
    if (!Number.isFinite(value) || value <= 0) return
    cooldowns.set(id, now() + value * 1000)
  }

  // Learn from a live 429 without touching configured profiles: a marker
  // (bucket = when it struck, used = observed requests so far today) feeds
  // the learned cap, and a cooldown row survives restarts.
  function observe429(id, { retryAfter } = {}) {
    const seconds = Math.ceil(Number(retryAfter))
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const at = now()
    const requests = readBucket(
      id,
      OBSERVED_REQUESTS_POLICY,
      startOfFixedWindow(at, OBSERVED_DAY)
    )
    addBucket(id, OBSERVED_429_POLICY, at, requests)
    const until = at + seconds * 1000
    addBucket(id, OBSERVED_COOLDOWN_POLICY, until, seconds)
    cooldowns.set(id, Math.max(cooldowns.get(id) ?? 0, until))
  }

  function restoreObservedCooldowns() {
    const at = now()
    for (const row of listBucketsByPolicy(OBSERVED_COOLDOWN_POLICY)) {
      const until = Number(row.bucket)
      if (!Number.isFinite(until) || until <= at) continue
      const id = String(row.model)
      cooldowns.set(id, Math.max(cooldowns.get(id) ?? 0, until))
    }
  }

  function prune() {
    try {
      repository?.pruneQuotaBefore?.(now() - RETENTION_MS)
    } catch (error) {
      console.error(`Could not prune the AI quota: ${error.message}`)
    }
  }

  prune()
  restoreObservedCooldowns()

  return { check, record, recordUsage, cooldown, observe429, snapshot, prune }
}

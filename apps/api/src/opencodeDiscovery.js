// Objective: Discover available OpenCode models through the opencode CLI.
// Requirements: Run one bounded subprocess, never infer, and fail soft so the API stays up when the CLI is unavailable.
// Decisions: opencode models prints one model id per line; results resolve to an ok/models/error object instead of throwing, and a TTL cache with in-flight dedup keeps startup and requests cheap.
// Relevant Files: apps/api/src/opencodeDiscovery.js, apps/api/src/index.js, apps/api/src/app.js, apps/api/test/opencodeDiscovery.test.js
// Important Context: User file. Discovery lists models only; it never runs inference and never silently switches the configured model.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { execFile } from 'node:child_process'

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15000
const DEFAULT_ROSTER_TTL_MS = 600000
const MAX_ROSTER_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * List the model ids the local opencode CLI can reach. The subprocess is
 * bounded by a timeout and the result always resolves: a missing or failing
 * CLI reports ok:false instead of taking the API down with it.
 */
export function discoverOpenCodeModels({
  execFileImpl = execFile,
  command = 'opencode',
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      command,
      ['models'],
      { timeout: timeoutMs, maxBuffer: MAX_ROSTER_BUFFER_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, models: [], error: error.message })
          return
        }
        const models = [...new Set(
          String(stdout ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        )].sort()
        resolve({ ok: true, models, error: null })
      }
    )
  })
}

/**
 * Cache a discovery result for a TTL. Concurrent callers share one in-flight
 * discovery, a failure is cached for the same TTL so a broken CLI is not
 * hammered on every request, and { refresh: true } forces a fresh run.
 */
export function createOpenCodeRosterCache({
  discover,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  ttlMs = DEFAULT_ROSTER_TTL_MS,
  now = Date.now
} = {}) {
  const runDiscovery = discover ?? (() => discoverOpenCodeModels({ timeoutMs }))
  let cached = null
  let inFlight = null

  function get({ refresh = false } = {}) {
    if (inFlight) return inFlight
    if (!refresh && cached !== null && now() - cached.fetchedAt < ttlMs) {
      return cached
    }
    inFlight = (async () => {
      try {
        const result = await runDiscovery()
        cached = { ...result, fetchedAt: now() }
        return cached
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return { get }
}

function readNonNegativeNumber(env, key, fallback) {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number.`)
  }
  return parsed
}

/**
 * Build the roster cache from workspace environment settings.
 * OPENCODE_AI_DISCOVERY_TIMEOUT_MS bounds the CLI subprocess and
 * OPENCODE_AI_DISCOVERY_TTL_MS controls how long a result stays fresh.
 */
export function createOpenCodeRosterCacheFromEnv(env = process.env) {
  return createOpenCodeRosterCache({
    timeoutMs: readNonNegativeNumber(env, 'OPENCODE_AI_DISCOVERY_TIMEOUT_MS', DEFAULT_DISCOVERY_TIMEOUT_MS),
    ttlMs: readNonNegativeNumber(env, 'OPENCODE_AI_DISCOVERY_TTL_MS', DEFAULT_ROSTER_TTL_MS)
  })
}

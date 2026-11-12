// Objective: Discover available OpenCode models through the opencode CLI.
// Requirements: Run one bounded subprocess, never infer, and fail soft so the API stays up when the CLI is unavailable; keep the last good roster on disk so status still works offline.
// Decisions: opencode models prints one model id per line; results resolve to an ok/models/error object instead of throwing, and a TTL cache with in-flight dedup keeps startup and requests cheap; a successful roster persists to an optional cache file, and a failed discovery falls back to the last good roster marked stale instead of dropping the roster entirely.
// Relevant Files: apps/api/src/opencodeDiscovery.js, apps/api/src/index.js, apps/api/src/app.js, apps/api/test/opencodeDiscovery.test.js
// Important Context: User file. Discovery lists models only; it never runs inference and never silently switches the configured model.
// Work State: Completed: Implemented; offline roster persistence added as task #43; Active: None; Blocked: None; Next Move: Maintain as needed.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15000
const DEFAULT_ROSTER_TTL_MS = 600000
const MAX_ROSTER_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_ROSTER_CACHE_FILE = fileURLToPath(
  new URL('../data/opencode-roster-cache.json', import.meta.url)
)

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
 *
 * With a cacheFile, a successful roster is written on disk and reloaded on
 * the next process start. If discovery fails, the last good roster is served
 * with stale:true + discoveryError instead of turning into an error result,
 * so the roster endpoint keeps answering while the CLI is offline. The disk
 * file is optional so tests and embedders keep the pure in-memory cache.
 */
export function createOpenCodeRosterCache({
  discover,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  ttlMs = DEFAULT_ROSTER_TTL_MS,
  now = Date.now,
  cacheFile = null
} = {}) {
  const runDiscovery = discover ?? (() => discoverOpenCodeModels({ timeoutMs }))
  let cached = null
  let inFlight = null
  let lastAttemptAt = null

  function readDiskCache() {
    if (!cacheFile) return null
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (!parsed || !Array.isArray(parsed.models) || !Number.isFinite(parsed.fetchedAt)) return null
      return {
        ok: true,
        models: parsed.models.filter((model) => typeof model === 'string'),
        error: null,
        fetchedAt: parsed.fetchedAt,
        source: 'cache',
        stale: false
      }
    } catch {
      return null
    }
  }

  async function writeDiskCache(result) {
    if (!cacheFile || !result.ok) return
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(
        cacheFile,
        JSON.stringify({ models: result.models, fetchedAt: result.fetchedAt }),
        'utf8'
      )
    } catch {
      // Persistence is best-effort; a read-only data dir must not break status.
    }
  }

  function get({ refresh = false } = {}) {
    if (inFlight) return inFlight
    if (!refresh && cached !== null) {
      const fresh = now() - cached.fetchedAt < ttlMs
      // A stale fallback retries discovery at most once per TTL, so an
      // offline CLI is probed at the normal cadence instead of per request.
      const retryDue = cached.stale !== true || lastAttemptAt === null || now() - lastAttemptAt >= ttlMs
      if (fresh || !retryDue) return cached
    }
    if (!refresh && cached === null) {
      const disk = readDiskCache()
      if (disk) {
        cached = disk
        lastAttemptAt = disk.fetchedAt
        if (now() - disk.fetchedAt < ttlMs) return disk
      }
    }
    inFlight = (async () => {
      lastAttemptAt = now()
      try {
        const result = await runDiscovery()
        if (result.ok) {
          cached = { ...result, fetchedAt: now(), source: 'cli', stale: false }
          await writeDiskCache(cached)
          return cached
        }
        const fallback = cached?.ok ? cached : readDiskCache()
        if (fallback) {
          cached = {
            ...fallback,
            ok: true,
            error: null,
            stale: true,
            source: 'cache',
            discoveryError: result.error
          }
          return cached
        }
        cached = { ...result, fetchedAt: now(), source: 'cli', stale: false }
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
 * OPENCODE_AI_DISCOVERY_TIMEOUT_MS bounds the CLI subprocess,
 * OPENCODE_AI_DISCOVERY_TTL_MS controls freshness, and
 * OPENCODE_AI_ROSTER_CACHE_FILE sets the offline cache path (an empty value
 * disables persistence).
 */
export function createOpenCodeRosterCacheFromEnv(env = process.env) {
  const cacheFile = env.OPENCODE_AI_ROSTER_CACHE_FILE === undefined
    ? DEFAULT_ROSTER_CACHE_FILE
    : env.OPENCODE_AI_ROSTER_CACHE_FILE || null
  return createOpenCodeRosterCache({
    timeoutMs: readNonNegativeNumber(env, 'OPENCODE_AI_DISCOVERY_TIMEOUT_MS', DEFAULT_DISCOVERY_TIMEOUT_MS),
    ttlMs: readNonNegativeNumber(env, 'OPENCODE_AI_DISCOVERY_TTL_MS', DEFAULT_ROSTER_TTL_MS),
    cacheFile
  })
}

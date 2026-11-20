import { parseIsoStrict } from './portability.js'

export const DEFAULT_GATE_CONFIG = Object.freeze({
  maxConcurrentProcesses: 2,
  minFreeMemoryMb: 1536,
  maxLoadAvgRatio: 0.85,
  retryAfterMs: 15000
})

const ENV_NAMES = {
  maxConcurrentProcesses: 'DISPATCH_MAX_CONCURRENT',
  minFreeMemoryMb: 'DISPATCH_MIN_FREE_MEMORY_MB',
  maxLoadAvgRatio: 'DISPATCH_MAX_LOAD_RATIO',
  retryAfterMs: 'DISPATCH_RETRY_AFTER_MS'
}

/** Invalid values throw (same stance as app.js LOCAL_AI_* validation). */
export function resolveGateConfig({ env = {}, overrides = {} } = {}) {
  const config = { ...DEFAULT_GATE_CONFIG }
  for (const [key, envName] of Object.entries(ENV_NAMES)) {
    const raw = overrides[key] ?? env[envName]
    if (raw === undefined || raw === null || raw === '') continue
    const n = Number(raw)
    const bad =
      !Number.isFinite(n) ||
      (key === 'maxConcurrentProcesses' && (!Number.isInteger(n) || n < 1)) ||
      (key === 'minFreeMemoryMb' && n < 0) ||
      (key === 'maxLoadAvgRatio' && n <= 0) ||
      (key === 'retryAfterMs' && n < 0)
    if (bad) throw new RangeError(`Invalid ${envName ?? key}: ${raw}`)
    config[key] = n
  }
  return config
}

/**
 * Pure admission advice (no I/O). The slot files enforce; this only advises.
 * Fixed check order: busy -> low memory -> high load. `reasons` lists ONLY failing/deferral reasons
 * (empty when admitted); informational conditions such as an unavailable load reading go to `notes`.
 */
export function evaluateResourceGate({ activeProcesses = 0, activeSlotExpiries = [], telemetry = {}, config = DEFAULT_GATE_CONFIG, nowMs }) {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config }
  const reasons = []
  const notes = []
  let nextMs = null

  if (activeProcesses >= cfg.maxConcurrentProcesses) {
    reasons.push('resource_gate_busy')
    const live = activeSlotExpiries.filter((e) => Number.isFinite(e))
    nextMs = live.length ? Math.min(...live) : nowMs + cfg.retryAfterMs
  }
  if (!Number.isFinite(telemetry.freeMemoryMb) || telemetry.freeMemoryMb < cfg.minFreeMemoryMb) {
    reasons.push('resource_gate_low_memory')
  }
  const cpus = Number(telemetry.cpuCount) || 0
  const load = Number(telemetry.loadAvg1)
  const zeros = Array.isArray(telemetry.loadAvg) && telemetry.loadAvg.every((v) => v === 0)
  let loadUnavailable = false
  if (telemetry.platform === 'win32' || (zeros && cpus > 0) || !Number.isFinite(load)) {
    loadUnavailable = true
    notes.push('load_unavailable')
  } else if (load / Math.max(1, cpus) > cfg.maxLoadAvgRatio) {
    reasons.push('resource_gate_high_load')
  }

  const deferred = reasons.length > 0
  if (deferred && nextMs === null) nextMs = nowMs + cfg.retryAfterMs
  return {
    verdict: deferred ? 'deferred' : 'admitted',
    reasons,
    primaryReason: reasons[0] ?? null,
    nextEligibleAt: deferred ? new Date(nextMs).toISOString() : null,
    notes,
    telemetry: {
      freeMemoryMb: Number.isFinite(telemetry.freeMemoryMb) ? Math.round(telemetry.freeMemoryMb) : null,
      loadAvg1: Number.isFinite(load) ? load : null,
      cpuCount: cpus,
      platform: telemetry.platform ?? null,
      memorySource: telemetry.memorySource ?? null,
      loadUnavailable
    },
    limits: { ...cfg }
  }
}

export { parseIsoStrict }

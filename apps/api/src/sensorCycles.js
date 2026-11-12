// Objective: Orchestrate atomic improvement cycles and an opt-in periodic scheduler around the deterministic sensor scan.
// Requirements: Persist each cycle's run, findings, and optional promotions in one transaction; never let cycles overlap; stop cleanly on shutdown; leave periodic runs off by default.
// Decisions: Detection reads the workspace outside SQLite, but persistence is one store transaction so a failed cycle cannot leave a partial run or half-created tasks; the scheduler uses recursive timeouts and unrefs its timer so the API can exit normally; auto-promotion is an explicit severity policy, never implicit.
// Relevant Files: apps/api/src/sensorCycles.js, apps/api/src/workspaceSensors.js, apps/api/src/db/sensors.js, apps/api/src/routes/sensors.js, apps/api/src/index.js
// Important Context: User file. Improvement cycles are zero-token; auto-promotion creates ordinary tasks through the same promotion path as the API and CLI.
import { SENSORS, scanWorkspaceSensors } from './workspaceSensors.js'

export const AUTO_PROMOTE_POLICIES = Object.freeze(['off', 'high', 'medium', 'all'])
export const CYCLE_TRIGGER_KINDS = Object.freeze(['manual', 'api', 'cli', 'scheduled'])
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])

function readNumber(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}.`)
  }
  return value
}

function readBoolean(env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new Error(`${key} must be a boolean (true/false).`)
}

function readChoice(env, key, fallback, choices) {
  const value = (env[key] ?? fallback).trim().toLowerCase()
  if (!choices.includes(value)) {
    throw new Error(`${key} must be one of: ${choices.join(', ')}.`)
  }
  return value
}

function readProject(env) {
  return (env.SENSOR_CYCLE_PROJECT ?? 'workspace').trim() || 'workspace'
}

export function resolveCycleConfig({ env = process.env } = {}) {
  const intervalMs = readNumber(
    env,
    'SENSOR_CYCLE_INTERVAL_MS',
    0,
    { max: 7 * 24 * 60 * 60 * 1000 }
  )
  if (intervalMs > 0 && intervalMs < 1000) {
    throw new Error('SENSOR_CYCLE_INTERVAL_MS must be 0 or at least 1000.')
  }
  return {
    intervalMs,
    autoPromote: readChoice(env, 'SENSOR_CYCLE_AUTO_PROMOTE', 'off', AUTO_PROMOTE_POLICIES),
    runOnStart: readBoolean(env, 'SENSOR_CYCLE_RUN_ON_START', false),
    project: readProject(env),
    taskType: readChoice(env, 'SENSOR_CYCLE_TASK_TYPE', 'chore', [...TASK_TYPES])
  }
}

export function autoPromoteSeverities(policy = 'off') {
  const normalized = String(policy ?? 'off').trim().toLowerCase()
  if (!AUTO_PROMOTE_POLICIES.includes(normalized)) {
    throw new Error(`Auto-promote policy must be one of: ${AUTO_PROMOTE_POLICIES.join(', ')}.`)
  }
  if (normalized === 'off') return []
  if (normalized === 'high') return ['high']
  if (normalized === 'medium') return ['high', 'medium']
  return ['low', 'medium', 'high']
}

const EMPTY_COUNTS = Object.freeze({
  created: 0,
  updated: 0,
  unchanged: 0,
  resolved: 0,
  reopened: 0
})

export function runSensorCycle({
  database,
  models = [],
  modelBudget,
  now = Date.now(),
  env = process.env,
  pathExists,
  sensors = SENSORS,
  triggerKind = 'manual',
  autoPromote,
  promoteProject,
  promoteTaskType
} = {}) {
  if (!database) throw new Error('runSensorCycle requires a database.')
  if (!CYCLE_TRIGGER_KINDS.includes(triggerKind)) {
    throw new Error(`triggerKind must be one of: ${CYCLE_TRIGGER_KINDS.join(', ')}.`)
  }
  const effectivePolicy = autoPromote
    ?? readChoice(env, 'SENSOR_CYCLE_AUTO_PROMOTE', 'off', AUTO_PROMOTE_POLICIES)
  const project = promoteProject ?? readProject(env)
  const taskType = promoteTaskType
    ?? readChoice(env, 'SENSOR_CYCLE_TASK_TYPE', 'chore', [...TASK_TYPES])
  try {
    const scan = scanWorkspaceSensors({
      database,
      models,
      modelBudget,
      now,
      env,
      ...(pathExists ? { pathExists } : {}),
      sensors
    })
    const applied = database.applySensorCycle({
      findings: scan.findings,
      sensors: sensors.length,
      triggerKind,
      promoteSeverities: autoPromoteSeverities(effectivePolicy),
      promoteProject: project,
      promoteTaskType: taskType,
      error: scan.errors.length > 0
        ? scan.errors.map((entry) => `${entry.sensorId}: ${entry.error}`).join('\n')
        : null,
      at: now
    })
    return {
      ...applied,
      findings: scan.findings,
      errors: scan.errors,
      summary: database.getSensorSummary(),
      failed: false
    }
  } catch (error) {
    // The persistence transaction rolls back its run row, so record one failed
    // audit row outside it. Detection itself stays read-only.
    const run = database.createSensorRun({ sensors: sensors.length, triggerKind })
    const failed = database.failSensorRun(run.id, error.message)
    return {
      run: failed,
      counts: { ...EMPTY_COUNTS },
      promotions: [],
      findings: [],
      errors: [{ sensorId: 'cycle', error: error.message }],
      summary: database.getSensorSummary(),
      failed: true,
      error: error.message
    }
  }
}

/**
 * Opt-in periodic cycle scheduler. `runCycle` receives `{ triggerKind }` and is
 * awaited; overlapping ticks are skipped instead of queued, so a slow cycle
 * never piles up work.
 */
export function createSensorCycleScheduler({
  runCycle,
  intervalMs = 0,
  runOnStart = false,
  logger = console,
  now = Date.now
} = {}) {
  if (typeof runCycle !== 'function') {
    throw new Error('createSensorCycleScheduler requires a runCycle function.')
  }
  const interval = Number(intervalMs)
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('intervalMs must be a non-negative number.')
  }

  let timer = null
  let stopped = true
  let running = false
  const state = {
    runs: 0,
    failures: 0,
    skipped: 0,
    lastRunAt: null,
    lastError: null,
    lastResult: null
  }

  function schedule() {
    if (stopped || interval <= 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      execute('scheduled')
    }, interval)
    timer.unref?.()
  }

  async function execute(triggerKind = 'scheduled') {
    if (running) {
      state.skipped += 1
      return { skipped: true, reason: 'A sensor cycle is already running.' }
    }
    running = true
    try {
      const result = await runCycle({ triggerKind })
      state.runs += 1
      state.lastRunAt = now()
      state.lastResult = result
      if (result?.failed) {
        state.failures += 1
        state.lastError = result.error ?? 'Sensor cycle failed.'
        logger.error(`Sensor cycle failed: ${state.lastError}`)
      }
      return result
    } catch (error) {
      state.failures += 1
      state.lastRunAt = now()
      state.lastError = error.message
      logger.error(`Sensor cycle failed: ${error.message}`)
      return { failed: true, error: error.message }
    } finally {
      running = false
      schedule()
    }
  }

  function getStatus() {
    return {
      started: !stopped,
      running,
      intervalMs: interval,
      ...state
    }
  }

  return {
    start() {
      if (!stopped) return getStatus()
      stopped = false
      if (runOnStart) execute('scheduled')
      else schedule()
      return getStatus()
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return getStatus()
    },
    runNow() {
      return execute('manual')
    },
    getStatus
  }
}

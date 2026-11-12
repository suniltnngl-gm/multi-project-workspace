import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './database.js'
import { createModelBudget } from './modelBudget.js'
import { createModelRegistry, modelQuotaProfiles } from './modelRegistry.js'
import { createOpenCodeRosterCacheFromEnv } from './opencodeDiscovery.js'
import {
  createSensorCycleScheduler,
  resolveCycleConfig,
  runSensorCycle
} from './sensorCycles.js'

// The repository the API serves from is registered as the primary
// repository row so tracked rows always associate with a real repository.
function resolveRepositoryRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return resolve(process.cwd())
  }
}

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const database = createDatabase(undefined, { rootDir: resolveRepositoryRoot() })
const opencodeRosterCache = createOpenCodeRosterCacheFromEnv()
const models = createModelRegistry()
const modelBudget = createModelBudget({
  repository: database,
  profiles: modelQuotaProfiles(models)
})
const app = createApp(database, { opencodeRosterCache, models, modelBudget })
const cycleConfig = resolveCycleConfig()
const sensorCycles = createSensorCycleScheduler({
  intervalMs: cycleConfig.intervalMs,
  runOnStart: cycleConfig.runOnStart,
  runCycle: ({ triggerKind }) => runSensorCycle({
    database,
    models,
    modelBudget,
    triggerKind
  })
})

const server = app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`)
  // Best-effort warm-up so the first roster request sees a fresh result; a
  // missing or failing CLI only marks the roster unavailable.
  opencodeRosterCache.get()
  sensorCycles.start()
  if (cycleConfig.intervalMs > 0) {
    console.log(
      `Sensor cycles enabled every ${cycleConfig.intervalMs}ms ` +
      `(auto-promote: ${cycleConfig.autoPromote}).`
    )
  }
})

function shutdown() {
  sensorCycles.stop()
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

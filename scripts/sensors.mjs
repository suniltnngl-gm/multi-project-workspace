#!/usr/bin/env node
// Objective: Run deterministic workspace sensors and manage their findings without spending model quota.
// Requirements: Support scan, list, show, runs, catalog, acknowledge, dismiss, resolve, reopen, and promote; work without the API running; print JSON on request.
// Decisions: The CLI imports the same registry, snapshot builder, and persistence layer as the API so both surfaces cannot drift; scans create an audit run exactly like POST /api/sensors/scan; list defaults to actionable findings only.
// Relevant Files: scripts/sensors.mjs, apps/api/src/workspaceSensors.js, apps/api/src/db/sensors.js, apps/api/src/modelRegistry.js, apps/api/src/modelBudget.js
// Important Context: User file. Zero-token control-plane tool; no provider is contacted.
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { createModelRegistry, modelQuotaProfiles } from '../apps/api/src/modelRegistry.js'
import { createModelBudget } from '../apps/api/src/modelBudget.js'
import { scanWorkspaceSensors, SENSOR_CATALOG } from '../apps/api/src/workspaceSensors.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set([
  'scan', 'list', 'show', 'runs', 'catalog',
  'ack', 'dismiss', 'resolve', 'reopen', 'promote'
])
const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'scan'

loadWorkspaceEnv()

function flag(name) {
  const index = arguments_.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = arguments_[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} requires a value.`)
    process.exitCode = 2
    return undefined
  }
  return value
}

function ensureFlag(name) {
  const value = flag(name)
  if (value === undefined && process.exitCode !== 2) {
    console.error(`--${name} is required.`)
    process.exitCode = 2
  }
  return value
}

const json = arguments_.includes('--json')
const databaseFlag = flag('database')
const note = flag('note') ?? ''
const databasePath = resolve(
  databaseFlag || process.env.DATABASE_PATH || `${ROOT_DIR}/apps/api/data/workspace.sqlite`
)

function usage() {
  console.error(
    'Usage: sensors.mjs <scan|list|show|runs|catalog|ack|dismiss|resolve|reopen|promote> [options]\n' +
    '  list [--state STATE] [--severity LEVEL] [--sensor ID] [--limit N] [--all]\n' +
    '  show <id> [--events N]\n' +
    '  runs [--limit N]\n' +
    '  ack|dismiss|resolve|reopen <id> [--note TEXT]\n' +
    '  promote <id> [--title TEXT] [--description TEXT] [--priority P] [--project NAME] [--task-type T]\n' +
    '  --database PATH  --json'
  )
}

function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  return Number(value)
}

function printFinding(finding) {
  const entity = finding.entity?.id ? ` [${finding.entity.type}:${finding.entity.id}]` : ''
  console.log(`#${finding.id} ${finding.severity.toUpperCase()} ${finding.state} ${finding.sensorId}${entity}`)
  console.log(`  ${finding.title}`)
  if (finding.summary) console.log(`  ${finding.summary}`)
  console.log(`  seen ${finding.occurrences}x, last ${finding.lastSeenAt}`)
}

function emit(value) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return true
  }
  return false
}

function main() {
  if (!COMMANDS.has(command)) {
    usage()
    process.exitCode = 2
    return
  }
  const positionals = arguments_.slice(1).filter((value, index, list) => {
    if (value.startsWith('--')) return false
    const previous = list[index - 1]
    return previous === undefined || !previous.startsWith('--')
  })
  const id = command === 'scan' || command === 'list' || command === 'runs' || command === 'catalog'
    ? null
    : parseId(positionals[0])
  if (command !== 'scan' && command !== 'list' && command !== 'runs' && command !== 'catalog' && id === null) {
    console.error(`${command} requires a numeric finding id.`)
    process.exitCode = 2
    return
  }

  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    if (command === 'catalog') {
      if (!emit({ sensors: SENSOR_CATALOG })) {
        for (const sensor of SENSOR_CATALOG) {
          console.log(`${sensor.id}  [${sensor.category}/${sensor.defaultSeverity}]  ${sensor.title}`)
          console.log(`  ${sensor.description}`)
        }
      }
      return
    }

    if (command === 'scan') {
      const models = createModelRegistry()
      const modelBudget = createModelBudget({
        repository: database,
        profiles: modelQuotaProfiles(models)
      })
      const run = database.createSensorRun({ sensors: SENSOR_CATALOG.length })
      const result = scanWorkspaceSensors({ database, models, modelBudget })
      const counts = database.applySensorScan(result.findings, { scanId: run.id })
      const finished = database.finishSensorRun(run.id, {
        status: result.errors.length > 0 ? 'failed' : 'completed',
        sensors: SENSOR_CATALOG.length,
        detected: result.findings.length,
        ...counts,
        error: result.errors.length > 0
          ? result.errors.map((entry) => `${entry.sensorId}: ${entry.error}`).join('\n').slice(0, 2000)
          : null
      })
      const summary = database.getSensorSummary()
      if (!emit({ run: finished, counts, errors: result.errors, summary })) {
        console.log(
          `Scan #${finished.id}: ${finished.detected} detected, ${counts.created} created, ` +
          `${counts.updated} updated, ${counts.resolved} resolved, ${counts.reopened} reopened, ` +
          `${counts.unchanged} unchanged.`
        )
        console.log(
          `Active findings: ${summary.active} (high ${summary.bySeverity.high}, ` +
          `medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low}).`
        )
        if (result.errors.length > 0) {
          for (const error of result.errors) console.error(`${error.sensorId}: ${error.error}`)
        }
      }
      return
    }

    if (command === 'list') {
      const state = flag('state')
      const severity = flag('severity')
      const sensor = flag('sensor')
      const limitValue = flag('limit')
      const limit = limitValue === undefined ? 100 : Number(limitValue)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        console.error('--limit must be an integer between 1 and 500.')
        process.exitCode = 2
        return
      }
      let findings = database.listSensorFindings({ state, severity, sensorId: sensor, limit })
      if (state === undefined && !arguments_.includes('--all')) {
        findings = findings.filter((finding) => ['open', 'acknowledged'].includes(finding.state)).slice(0, limit)
      }
      if (!emit(findings)) {
        for (const finding of findings) printFinding(finding)
        console.error(`Total: ${findings.length}`)
      }
      return
    }

    if (command === 'show') {
      const eventLimit = Number(flag('events') ?? 50)
      const finding = database.getSensorFindingDetail(id, { eventLimit })
      if (!finding) {
        console.error(`Sensor finding ${id} not found.`)
        process.exitCode = 1
        return
      }
      if (!emit(finding)) {
        printFinding(finding)
        if (finding.details && Object.keys(finding.details).length > 0) {
          console.log(`  details: ${JSON.stringify(finding.details)}`)
        }
        for (const event of finding.events) {
          console.log(`  ${event.createdAt} ${event.action}${event.note ? `: ${event.note}` : ''}`)
        }
      }
      return
    }

    if (command === 'runs') {
      const limit = Number(flag('limit') ?? 20)
      const runs = database.listSensorRuns({ limit })
      if (!emit(runs)) {
        for (const run of runs) {
          console.log(
            `#${run.id} ${run.status} started ${run.startedAt}` +
            ` detected ${run.detected}: ${run.created} created, ${run.updated} updated, ` +
            `${run.resolved} resolved, ${run.reopened} reopened`
          )
        }
      }
      return
    }

    if (command === 'promote') {
      const result = database.promoteSensorFinding(id, {
        title: flag('title'),
        description: flag('description'),
        project: flag('project'),
        priority: flag('priority'),
        taskType: flag('task-type')
      })
      if (result?.error) {
        console.error(result.error.body.error)
        process.exitCode = 1
        return
      }
      if (!emit(result)) {
        console.log(`Promoted finding #${id} to task #${result.task.id}: ${result.task.title}`)
        console.log(`Finding is now ${result.finding.state}.`)
      }
      return
    }

    const method = {
      ack: 'acknowledgeSensorFinding',
      dismiss: 'dismissSensorFinding',
      resolve: 'resolveSensorFinding',
      reopen: 'reopenSensorFinding'
    }[command]
    const result = database[method](id, { note })
    if (result?.error) {
      console.error(result.error.body.error)
      process.exitCode = 1
      return
    }
    if (!emit(result.finding)) printFinding(result.finding)
  } finally {
    database.close()
  }
}

main()

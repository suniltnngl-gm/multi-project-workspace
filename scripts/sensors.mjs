#!/usr/bin/env node
// Objective: Run deterministic workspace sensors and manage their findings without spending model quota.
// Requirements: Support scan, cycle, suggestions, list, show, runs, catalog, acknowledge, dismiss, resolve, reopen, and promote; work without the API running; print JSON on request.
// Decisions: The CLI imports the same registry, snapshot builder, cycle runner, and persistence layer as the API so both surfaces cannot drift; scans and cycles create audit runs exactly like their HTTP equivalents; list defaults to actionable findings only.
// Relevant Files: scripts/sensors.mjs, apps/api/src/workspaceSensors.js, apps/api/src/sensorCycles.js, apps/api/src/db/sensors.js, apps/api/src/modelRegistry.js, apps/api/src/modelBudget.js
// Important Context: User file. Zero-token control-plane tool; no provider is contacted.
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { createModelRegistry, modelQuotaProfiles } from '../apps/api/src/modelRegistry.js'
import { createModelBudget } from '../apps/api/src/modelBudget.js'
import { AUTO_PROMOTE_POLICIES, runSensorCycle } from '../apps/api/src/sensorCycles.js'
import { SENSOR_CATALOG, SENSOR_IDEAS } from '../apps/api/src/workspaceSensors.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set([
  'scan', 'list', 'show', 'runs', 'catalog', 'suggestions', 'cycle',
  'ack', 'dismiss', 'resolve', 'reopen', 'promote'
])
const AUTO_PROMOTE_SET = new Set(AUTO_PROMOTE_POLICIES)
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])
const IDEA_CATALOG = SENSOR_IDEAS.map((idea) => ({
  id: idea.id,
  title: idea.title,
  description: idea.description,
  category: idea.category,
  defaultSeverity: idea.severity ?? 'low'
}))
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
    'Usage: sensors.mjs <scan|list|show|runs|catalog|suggestions|cycle|ack|dismiss|resolve|reopen|promote> [options]\n' +
    '  list [--state STATE] [--severity LEVEL] [--sensor ID] [--limit N] [--all]\n' +
    '  show <id> [--events N]\n' +
    '  runs [--limit N]\n' +
    '  suggestions [--state STATE] [--limit N] [--all]\n' +
    '  cycle [--auto-promote off|high|medium|all] [--project NAME] [--task-type T]\n' +
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
  const needsId = !['scan', 'list', 'runs', 'catalog', 'suggestions', 'cycle'].includes(command)
  const id = needsId ? parseId(positionals[0]) : null
  if (needsId && id === null) {
    console.error(`${command} requires a numeric finding id.`)
    process.exitCode = 2
    return
  }

  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    if (command === 'catalog') {
      if (!emit({ sensors: SENSOR_CATALOG, ideas: IDEA_CATALOG })) {
        for (const sensor of SENSOR_CATALOG) {
          console.log(`${sensor.id}  [${sensor.category}/${sensor.defaultSeverity}]  ${sensor.title}`)
          console.log(`  ${sensor.description}`)
        }
        console.log('\nCandidate sensor ideas (suggested by the meta detector when evidence applies):')
        for (const idea of IDEA_CATALOG) {
          console.log(`${idea.id}  [${idea.category}/${idea.defaultSeverity}]  ${idea.title}`)
          console.log(`  ${idea.description}`)
        }
      }
      return
    }

    if (command === 'scan' || command === 'cycle') {
      const models = createModelRegistry()
      const modelBudget = createModelBudget({
        repository: database,
        profiles: modelQuotaProfiles(models)
      })
      const autoPromote = command === 'cycle' ? flag('auto-promote') : 'off'
      const project = flag('project')
      const taskType = flag('task-type')
      if (autoPromote !== undefined && !AUTO_PROMOTE_SET.has(autoPromote)) {
        console.error(`--auto-promote must be one of: ${AUTO_PROMOTE_POLICIES.join(', ')}.`)
        process.exitCode = 2
        return
      }
      if (project !== undefined && !project.trim()) {
        console.error('--project must not be empty.')
        process.exitCode = 2
        return
      }
      if (taskType !== undefined && !TASK_TYPES.has(taskType)) {
        console.error(`--task-type must be one of: ${[...TASK_TYPES].join(', ')}.`)
        process.exitCode = 2
        return
      }
      let result
      try {
        result = runSensorCycle({
          database,
          models,
          modelBudget,
          triggerKind: 'cli',
          autoPromote,
          promoteProject: project,
          promoteTaskType: taskType
        })
      } catch (error) {
        console.error(error.message)
        process.exitCode = 2
        return
      }
      if (result.failed) {
        console.error(`Sensor ${command} failed: ${result.error}`)
        process.exitCode = 1
        return
      }
      const { run, counts, summary, errors, promotions } = result
      if (!emit({
        run,
        counts,
        promotions,
        errors,
        summary,
        findings: result.findings
      })) {
        console.log(
          `${command === 'cycle' ? 'Cycle' : 'Scan'} #${run.id} (${run.triggerKind}): ` +
          `${run.detected} detected, ${counts.created} created, ` +
          `${counts.updated} updated, ${counts.resolved} resolved, ` +
          `${counts.reopened} reopened, ${counts.unchanged} unchanged, ` +
          `${run.promoted} promoted.`
        )
        for (const promotion of promotions) {
          console.log(`  promoted #${promotion.finding.id} -> task #${promotion.task.id}: ${promotion.task.title}`)
        }
        console.log(
          `Active findings: ${summary.active} (high ${summary.bySeverity.high}, ` +
          `medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low}).`
        )
        if (errors.length > 0) {
          for (const error of errors) console.error(`${error.sensorId}: ${error.error}`)
        }
      }
      return
    }

    if (command === 'suggestions') {
      const state = flag('state')
      const limitValue = flag('limit')
      const limit = limitValue === undefined ? 100 : Number(limitValue)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        console.error('--limit must be an integer between 1 and 500.')
        process.exitCode = 2
        return
      }
      let suggestions = database.listSensorFindings({
        state,
        sensorId: 'meta.sensor_suggestion',
        limit
      })
      if (state === undefined && !arguments_.includes('--all')) {
        suggestions = suggestions.filter(
          (finding) => ['open', 'acknowledged'].includes(finding.state)
        )
      }
      if (!emit({ suggestions, ideas: IDEA_CATALOG })) {
        for (const finding of suggestions) printFinding(finding)
        console.error(`Suggestions: ${suggestions.length}`)
        console.error(
          `Candidate ideas: ${IDEA_CATALOG.map((idea) => idea.id).join(', ')}`
        )
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

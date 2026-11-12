// Objective: Expose deterministic workspace sensors over the local API: catalog, scans, atomic improvement cycles, suggestions, findings, lifecycle decisions, run audit, and promotion into tasks.
// Requirements: Every read is token-free for the local board; scans and cycles spend no model quota; lifecycle errors map to 404/409 verbatim; promotion is only valid from an open finding; cycle input is validated before any detection runs.
// Decisions: The route group owns request validation only and delegates detection to workspaceSensors, orchestration to sensorCycles, and persistence to the sensors store, so the CLI and the API share one rule set; both scan and cycle create the run and findings inside one store transaction.
// Relevant Files: apps/api/src/routes/sensors.js, apps/api/src/workspaceSensors.js, apps/api/src/sensorCycles.js, apps/api/src/db/sensors.js, apps/api/src/app.js
// Important Context: User file. Findings are persisted separately from model-generated task proposals.
import { Router } from 'express'
import {
  SENSOR_CATALOG,
  SENSOR_IDEAS,
  resolveSensorConfig
} from '../workspaceSensors.js'
import { AUTO_PROMOTE_POLICIES, runSensorCycle } from '../sensorCycles.js'
import { SENSOR_SEVERITIES, SENSOR_STATES } from '../db/sensors.js'

const SENSOR_STATE_SET = new Set(SENSOR_STATES)
const SENSOR_SEVERITY_SET = new Set(SENSOR_SEVERITIES)
const AUTO_PROMOTE_SET = new Set(AUTO_PROMOTE_POLICIES)
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])
const IDEA_CATALOG = Object.freeze(SENSOR_IDEAS.map((idea) => ({
  id: idea.id,
  title: idea.title,
  description: idea.description,
  category: idea.category,
  defaultSeverity: idea.severity ?? 'low'
})))

function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const limit = Number(value)
  return limit <= max ? limit : null
}

function sendTransition(response, result) {
  if (result?.error) {
    return response.status(result.error.status).json(result.error.body)
  }
  return response.json(result.finding)
}

function readNote(body) {
  if (body?.note === undefined) return ''
  return typeof body.note === 'string' ? body.note : null
}

export function createSensorsRouter({ database, models = [], modelBudget, env = process.env } = {}) {
  const router = Router()

  router.get('/api/sensors/catalog', (_request, response) => {
    response.json({
      sensors: SENSOR_CATALOG,
      ideas: IDEA_CATALOG,
      thresholds: (({ staleTaskHours, staleRunHours, metadataStaleHours, sampleLimit }) => ({
        staleTaskHours,
        staleRunHours,
        metadataStaleHours,
        sampleLimit
      }))(resolveSensorConfig({ env })),
      states: SENSOR_STATES,
      severities: SENSOR_SEVERITIES,
      autoPromotePolicies: AUTO_PROMOTE_POLICIES
    })
  })

  router.post('/api/sensors/scan', (_request, response) => {
    const result = runSensorCycle({
      database,
      models,
      modelBudget,
      env,
      triggerKind: 'api',
      autoPromote: 'off'
    })
    if (result.failed) {
      return response.status(500).json({
        error: `Sensor scan failed: ${result.error}`,
        run: result.run,
        errors: result.errors
      })
    }
    return response.json({
      run: result.run,
      findings: result.findings,
      errors: result.errors,
      counts: result.counts,
      summary: result.summary
    })
  })

  router.post('/api/sensors/cycles', (request, response) => {
    const body = request.body ?? {}
    for (const field of ['auto_promote', 'project', 'task_type']) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return response.status(400).json({ error: `${field} must be a string.` })
      }
    }
    if (body.auto_promote !== undefined && !AUTO_PROMOTE_SET.has(body.auto_promote)) {
      return response.status(400).json({
        error: `auto_promote must be one of: ${AUTO_PROMOTE_POLICIES.join(', ')}.`
      })
    }
    if (body.task_type !== undefined && !TASK_TYPES.has(body.task_type)) {
      return response.status(400).json({
        error: `task_type must be one of: ${[...TASK_TYPES].join(', ')}.`
      })
    }
    if (body.project !== undefined && !body.project.trim()) {
      return response.status(400).json({ error: 'project must not be empty.' })
    }
    const result = runSensorCycle({
      database,
      models,
      modelBudget,
      env,
      triggerKind: 'api',
      autoPromote: body.auto_promote,
      promoteProject: body.project,
      promoteTaskType: body.task_type
    })
    if (result.failed) {
      return response.status(500).json({
        error: `Sensor cycle failed: ${result.error}`,
        run: result.run,
        errors: result.errors
      })
    }
    return response.json({
      run: result.run,
      findings: result.findings,
      errors: result.errors,
      counts: result.counts,
      promotions: result.promotions,
      summary: result.summary
    })
  })

  router.get('/api/sensors/suggestions', (request, response) => {
    let state
    if (request.query.state !== undefined) {
      if (typeof request.query.state !== 'string' || !SENSOR_STATE_SET.has(request.query.state)) {
        return response.status(400).json({ error: `State must be one of: ${SENSOR_STATES.join(', ')}.` })
      }
      state = request.query.state
    }
    const limit = parseLimit(request.query.limit, 100, 500)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 500.' })
    }
    let suggestions = database.listSensorFindings({
      state,
      sensorId: 'meta.sensor_suggestion',
      limit
    })
    if (state === undefined) {
      suggestions = suggestions.filter(
        (finding) => ['open', 'acknowledged'].includes(finding.state)
      )
    }
    return response.json({ suggestions, ideas: IDEA_CATALOG })
  })

  router.get('/api/sensors/summary', (_request, response) => {
    response.json(database.getSensorSummary())
  })

  router.get('/api/sensors/runs', (request, response) => {
    const limit = parseLimit(request.query.limit, 20, 200)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 200.' })
    }
    return response.json(database.listSensorRuns({ limit }))
  })

  router.get('/api/sensors/runs/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Sensor run ID is invalid.' })
    const run = database.getSensorRun(id)
    if (!run) return response.status(404).json({ error: 'Sensor run not found.' })
    return response.json(run)
  })

  router.get('/api/sensors/findings', (request, response) => {
    const options = {}
    if (request.query.state !== undefined) {
      if (typeof request.query.state !== 'string' || !SENSOR_STATE_SET.has(request.query.state)) {
        return response.status(400).json({ error: `State must be one of: ${SENSOR_STATES.join(', ')}.` })
      }
      options.state = request.query.state
    }
    if (request.query.severity !== undefined) {
      if (typeof request.query.severity !== 'string' || !SENSOR_SEVERITY_SET.has(request.query.severity)) {
        return response.status(400).json({ error: `Severity must be one of: ${SENSOR_SEVERITIES.join(', ')}.` })
      }
      options.severity = request.query.severity
    }
    if (request.query.sensor_id !== undefined) {
      if (typeof request.query.sensor_id !== 'string' || !request.query.sensor_id.trim()) {
        return response.status(400).json({ error: 'Sensor ID filter must be a non-empty string.' })
      }
      options.sensorId = request.query.sensor_id.trim()
    }
    const limit = parseLimit(request.query.limit, 100, 500)
    if (limit === null) {
      return response.status(400).json({ error: 'Limit must be a positive integer of at most 500.' })
    }
    options.limit = limit
    return response.json(database.listSensorFindings(options))
  })

  router.get('/api/sensors/findings/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Sensor finding ID is invalid.' })
    const eventLimit = parseLimit(request.query.event_limit, 50, 200)
    if (eventLimit === null) {
      return response.status(400).json({ error: 'Event limit must be a positive integer of at most 200.' })
    }
    const finding = database.getSensorFindingDetail(id, { eventLimit })
    if (!finding) return response.status(404).json({ error: 'Sensor finding not found.' })
    return response.json(finding)
  })

  for (const [segment, method] of [
    ['ack', 'acknowledgeSensorFinding'],
    ['dismiss', 'dismissSensorFinding'],
    ['resolve', 'resolveSensorFinding'],
    ['reopen', 'reopenSensorFinding']
  ]) {
    router.post(`/api/sensors/findings/:id/${segment}`, (request, response) => {
      const id = parseId(request.params.id)
      if (id === null) return response.status(400).json({ error: 'Sensor finding ID is invalid.' })
      const note = readNote(request.body)
      if (note === null) return response.status(400).json({ error: 'Note must be a string.' })
      return sendTransition(response, database[method](id, { note }))
    })
  }

  router.post('/api/sensors/findings/:id/promote', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Sensor finding ID is invalid.' })
    const body = request.body ?? {}
    for (const field of ['title', 'description', 'project', 'priority', 'task_type']) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return response.status(400).json({ error: `${field} must be a string.` })
      }
    }
    if (body.priority !== undefined && !TASK_PRIORITIES.has(body.priority)) {
      return response.status(400).json({
        error: `Priority must be one of: ${[...TASK_PRIORITIES].join(', ')}.`
      })
    }
    if (body.task_type !== undefined && !TASK_TYPES.has(body.task_type)) {
      return response.status(400).json({
        error: `Task type must be one of: ${[...TASK_TYPES].join(', ')}.`
      })
    }
    if (body.title !== undefined && !body.title.trim()) {
      return response.status(400).json({ error: 'Title must not be empty.' })
    }
    const result = database.promoteSensorFinding(id, {
      title: body.title,
      description: body.description,
      project: body.project,
      priority: body.priority,
      taskType: body.task_type
    })
    if (result?.error) {
      return response.status(result.error.status).json(result.error.body)
    }
    return response.status(201).json(result)
  })

  return router
}

// Objective: Expose deterministic workspace sensors over the local API: catalog, scans, findings, lifecycle decisions, run audit, and promotion into tasks.
// Requirements: Every read is token-free for the local board; scans spend no model quota; lifecycle errors map to 404/409 verbatim; promotion is only valid from an open finding.
// Decisions: The route group owns request validation only and delegates detection to workspaceSensors and persistence to the sensors store, so the CLI and the API share one rule set; the scan route creates the run row first so a crash still leaves an audit trail.
// Relevant Files: apps/api/src/routes/sensors.js, apps/api/src/workspaceSensors.js, apps/api/src/db/sensors.js, apps/api/src/app.js
// Important Context: User file. Findings are persisted separately from model-generated task proposals.
import { Router } from 'express'
import { SENSOR_CATALOG, scanWorkspaceSensors, resolveSensorConfig } from '../workspaceSensors.js'
import { SENSOR_SEVERITIES, SENSOR_STATES } from '../db/sensors.js'

const SENSOR_STATE_SET = new Set(SENSOR_STATES)
const SENSOR_SEVERITY_SET = new Set(SENSOR_SEVERITIES)
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])

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
      thresholds: (({ staleTaskHours, staleRunHours, sampleLimit }) => ({
        staleTaskHours,
        staleRunHours,
        sampleLimit
      }))(resolveSensorConfig({ env })),
      states: SENSOR_STATES,
      severities: SENSOR_SEVERITIES
    })
  })

  router.post('/api/sensors/scan', (_request, response) => {
    const run = database.createSensorRun({ sensors: SENSOR_CATALOG.length })
    try {
      const result = scanWorkspaceSensors({ database, models, modelBudget, env })
      const counts = database.applySensorScan(result.findings, {
        scanId: run.id
      })
      const finished = database.finishSensorRun(run.id, {
        status: result.errors.length > 0 ? 'failed' : 'completed',
        sensors: SENSOR_CATALOG.length,
        detected: result.findings.length,
        ...counts,
        error: result.errors.length > 0
          ? result.errors.map((entry) => `${entry.sensorId}: ${entry.error}`).join('\n').slice(0, 2000)
          : null
      })
      return response.json({
        run: finished,
        findings: result.findings,
        errors: result.errors,
        counts,
        summary: database.getSensorSummary()
      })
    } catch (error) {
      const failed = database.failSensorRun(run.id, error.message)
      return response.status(500).json({
        error: `Sensor scan failed: ${error.message}`,
        run: failed
      })
    }
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

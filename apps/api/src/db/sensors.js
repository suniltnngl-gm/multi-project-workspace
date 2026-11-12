// Objective: Persist deterministic sensor findings, their lifecycle events, and scan-run audits.
// Requirements: Upsert by stable key, keep dismissed findings muted, auto-resolve active findings that disappear, reopen a resolved finding that reappears, and record every state change with an event.
// Decisions: The store owns lifecycle rules so the routes and CLI cannot drift; state transitions are explicit transactions with conflict errors; scans resolve only open/acknowledged findings, because a dismissed finding is an intentional mute and a resolved one has already been closed.
// Relevant Files: apps/api/src/db/sensors.js, apps/api/src/workspaceSensors.js, apps/api/src/routes/sensors.js, apps/api/src/db/migrations.js, apps/api/src/database.js
// Important Context: User file. Findings are separate from model-generated task proposals.
export const SENSOR_STATES = Object.freeze(['open', 'acknowledged', 'dismissed', 'resolved'])
export const SENSOR_SEVERITIES = Object.freeze(['low', 'medium', 'high'])
const SENSOR_STATE_SET = new Set(SENSOR_STATES)
const SENSOR_SEVERITY_SET = new Set(SENSOR_SEVERITIES)

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function toFinding(row) {
  if (!row) return null
  return {
    id: row.id,
    key: row.key,
    sensorId: row.sensor_id,
    state: row.state,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    entity: { type: row.entity_type, id: row.entity_id },
    details: parseJson(row.details, {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.last_scan_id !== null ? { lastScanId: row.last_scan_id } : {}),
    occurrences: row.occurrences,
    ...(row.ack_at !== null ? { acknowledgedAt: row.ack_at } : {}),
    ...(row.dismissed_at !== null ? { dismissedAt: row.dismissed_at } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toFindingEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    findingId: row.finding_id,
    action: row.action,
    ...(row.field !== null ? { field: row.field } : {}),
    ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
    ...(row.new_value !== null ? { newValue: row.new_value } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at
  }
}

function toRun(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    sensors: row.sensors,
    detected: row.detected,
    created: row.created,
    updated: row.updated,
    resolved: row.resolved,
    reopened: row.reopened,
    unchanged: row.unchanged,
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {})
  }
}

export function createSensorsStore(connection, { tasks, now = Date.now } = {}) {
  if (!connection) throw new Error('createSensorsStore requires a connection.')
  if (!tasks) throw new Error('createSensorsStore requires the tasks store for promotion.')

  const listFindingsStatement = connection.prepare(`
    SELECT * FROM sensor_findings
    ORDER BY
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      last_seen_at DESC,
      id DESC
  `)
  const listFindingsByStateStatement = connection.prepare(`
    SELECT * FROM sensor_findings WHERE state = ?
    ORDER BY
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      last_seen_at DESC,
      id DESC
  `)
  const getFindingStatement = connection.prepare('SELECT * FROM sensor_findings WHERE id = ?')
  const getFindingByKeyStatement = connection.prepare('SELECT * FROM sensor_findings WHERE key = ?')
  const listFindingEventsStatement = connection.prepare(`
    SELECT * FROM sensor_finding_events
    WHERE finding_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const insertFindingEventStatement = connection.prepare(`
    INSERT INTO sensor_finding_events (finding_id, action, field, old_value, new_value, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFindingStatement = connection.prepare(`
    INSERT INTO sensor_findings (
      key, sensor_id, state, severity, title, summary, entity_type, entity_id,
      details, first_seen_at, last_seen_at, last_scan_id, occurrences,
      created_at, updated_at
    ) VALUES (
      @key, @sensorId, 'open', @severity, @title, @summary, @entityType, @entityId,
      @details, @now, @now, @scanId, 1, @now, @now
    )
  `)
  const updateFindingStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = @state, severity = @severity, title = @title, summary = @summary,
        entity_type = @entityType, entity_id = @entityId, details = @details,
        last_seen_at = @now, last_scan_id = @scanId, occurrences = occurrences + 1,
        ack_at = @ackAt, dismissed_at = @dismissedAt, resolved_at = @resolvedAt,
        note = @note, updated_at = @now
    WHERE id = @id
  `)
  const resolveFindingStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = 'resolved', resolved_at = ?, last_scan_id = ?, updated_at = ?
    WHERE id = ?
  `)
  const acknowledgeFindingStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = 'acknowledged', ack_at = ?, note = ?, updated_at = ?
    WHERE id = ?
  `)
  const dismissFindingStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = 'dismissed', dismissed_at = ?, note = ?, updated_at = ?
    WHERE id = ?
  `)
  const resolveManuallyStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = 'resolved', resolved_at = ?, note = ?, updated_at = ?
    WHERE id = ?
  `)
  const reopenFindingStatement = connection.prepare(`
    UPDATE sensor_findings
    SET state = 'open', ack_at = NULL, dismissed_at = NULL, resolved_at = NULL,
        note = '', updated_at = ?
    WHERE id = ?
  `)
  const countByStateStatement = connection.prepare(
    'SELECT state, COUNT(*) AS count FROM sensor_findings GROUP BY state'
  )
  const countActiveBySeverityStatement = connection.prepare(`
    SELECT severity, COUNT(*) AS count FROM sensor_findings
    WHERE state IN ('open', 'acknowledged')
    GROUP BY severity
  `)

  const insertRunStatement = connection.prepare(`
    INSERT INTO sensor_runs (status, sensors, started_at)
    VALUES ('running', ?, ?)
  `)
  const finishRunStatement = connection.prepare(`
    UPDATE sensor_runs
    SET status = @status, sensors = @sensors, detected = @detected, created = @created,
        updated = @updated, resolved = @resolved, reopened = @reopened,
        unchanged = @unchanged, error = @error, finished_at = @finishedAt
    WHERE id = @id
  `)
  const failRunStatement = connection.prepare(`
    UPDATE sensor_runs
    SET status = 'failed', error = ?, finished_at = ?
    WHERE id = ?
  `)
  const getRunStatement = connection.prepare('SELECT * FROM sensor_runs WHERE id = ?')
  const listRunsStatement = connection.prepare(`
    SELECT * FROM sensor_runs ORDER BY started_at DESC, id DESC LIMIT ?
  `)

  function recordEvent(findingId, action, {
    field = null,
    oldValue = null,
    newValue = null,
    note = '',
    at = now()
  } = {}) {
    insertFindingEventStatement.run(
      findingId, action, field, oldValue, newValue, note, at
    )
  }

  const applyScan = connection.transaction((findings, { scanId = null, at = now() } = {}) => {
    const detected = new Map()
    for (const entry of findings ?? []) {
      const key = text(entry?.key, 500)
      if (!key) continue
      detected.set(key, entry)
    }

    const existingRows = listFindingsStatement.all()
    const existingByKey = new Map(existingRows.map((row) => [row.key, row]))
    const counts = { created: 0, updated: 0, unchanged: 0, resolved: 0, reopened: 0 }

    // A finding that is no longer detected closes only while it is actionable.
    // Dismissed rows stay muted and resolved rows stay closed.
    for (const row of existingRows) {
      if (!['open', 'acknowledged'].includes(row.state)) continue
      if (detected.has(row.key)) continue
      resolveFindingStatement.run(at, scanId, at, row.id)
      recordEvent(row.id, 'resolved', {
        field: 'state',
        oldValue: row.state,
        newValue: 'resolved',
        note: 'Not detected by scan.',
        at
      })
      counts.resolved += 1
    }

    for (const entry of detected.values()) {
      const key = text(entry.key, 500)
      const severity = SENSOR_SEVERITY_SET.has(entry.severity) ? entry.severity : 'medium'
      const title = text(entry.title, 300) || 'Sensor finding'
      const summary = text(entry.summary, 2000)
      const entityType = text(entry.entity?.type, 100)
      const entityId = text(entry.entity?.id, 500)
      const details = JSON.stringify(entry.details ?? {})
      const existing = existingByKey.get(key)

      if (!existing) {
        const result = insertFindingStatement.run({
          key,
          sensorId: text(entry.sensorId, 200) || 'unknown',
          severity,
          title,
          summary,
          entityType,
          entityId,
          details,
          scanId,
          now: at
        })
        recordEvent(Number(result.lastInsertRowid), 'created', {
          field: 'state',
          newValue: 'open',
          at
        })
        counts.created += 1
        continue
      }

      const changed = []
      if (existing.severity !== severity) changed.push('severity')
      if (existing.title !== title) changed.push('title')
      if (existing.summary !== summary) changed.push('summary')
      if (existing.entity_type !== entityType) changed.push('entity_type')
      if (existing.entity_id !== entityId) changed.push('entity_id')
      if (existing.details !== details) changed.push('details')

      if (existing.state === 'resolved') {
        updateFindingStatement.run({
          id: existing.id,
          state: 'open',
          severity,
          title,
          summary,
          entityType,
          entityId,
          details,
          scanId,
          ackAt: null,
          dismissedAt: null,
          resolvedAt: null,
          note: '',
          now: at
        })
        recordEvent(existing.id, 'reopened', {
          field: 'state',
          oldValue: 'resolved',
          newValue: 'open',
          at
        })
        counts.reopened += 1
        continue
      }

      updateFindingStatement.run({
        id: existing.id,
        state: existing.state,
        severity,
        title,
        summary,
        entityType,
        entityId,
        details,
        scanId,
        ackAt: existing.ack_at,
        dismissedAt: existing.dismissed_at,
        resolvedAt: existing.resolved_at,
        note: existing.note,
        now: at
      })
      if (changed.length > 0) {
        recordEvent(existing.id, 'updated', {
          field: changed.join(',').slice(0, 200),
          oldValue: existing.state,
          newValue: existing.state,
          at
        })
        counts.updated += 1
      } else {
        counts.unchanged += 1
      }
    }

    return counts
  })

  const transition = connection.transaction((id, action, { note = '', at = now() } = {}) => {
    const row = getFindingStatement.get(id)
    if (!row) return { error: { status: 404, body: { error: 'Sensor finding not found.' } } }
    const cleanNote = text(note, 2000)
    let nextState
    let statement
    let eventAction
    if (action === 'acknowledge') {
      if (row.state !== 'open') {
        return { error: { status: 409, body: { error: `Only open findings can be acknowledged (currently ${row.state}).` } } }
      }
      nextState = 'acknowledged'
      eventAction = 'acknowledged'
      statement = () => acknowledgeFindingStatement.run(at, cleanNote, at, id)
    } else if (action === 'dismiss') {
      if (!['open', 'acknowledged'].includes(row.state)) {
        return { error: { status: 409, body: { error: `Only open or acknowledged findings can be dismissed (currently ${row.state}).` } } }
      }
      nextState = 'dismissed'
      eventAction = 'dismissed'
      statement = () => dismissFindingStatement.run(at, cleanNote, at, id)
    } else if (action === 'resolve') {
      if (!['open', 'acknowledged'].includes(row.state)) {
        return { error: { status: 409, body: { error: `Only open or acknowledged findings can be resolved (currently ${row.state}).` } } }
      }
      nextState = 'resolved'
      eventAction = 'resolved'
      statement = () => resolveManuallyStatement.run(at, cleanNote, at, id)
    } else if (action === 'reopen') {
      if (!['dismissed', 'resolved'].includes(row.state)) {
        return { error: { status: 409, body: { error: `Only dismissed or resolved findings can be reopened (currently ${row.state}).` } } }
      }
      nextState = 'open'
      eventAction = 'reopened'
      statement = () => reopenFindingStatement.run(at, id)
    } else {
      return { error: { status: 400, body: { error: `Unknown finding action: ${action}.` } } }
    }

    statement()
    recordEvent(id, eventAction, {
      field: 'state',
      oldValue: row.state,
      newValue: nextState,
      note: cleanNote,
      at
    })
    return { finding: toFinding(getFindingStatement.get(id)) }
  })

  const promote = connection.transaction((id, {
    title,
    description,
    priority,
    project,
    taskType,
    at = now()
  } = {}) => {
    const row = getFindingStatement.get(id)
    if (!row) return { error: { status: 404, body: { error: 'Sensor finding not found.' } } }
    if (row.state !== 'open') {
      return { error: { status: 409, body: { error: `Only open findings can be promoted (currently ${row.state}).` } } }
    }
    const severityPriority = row.severity === 'high' ? 'high' : row.severity === 'low' ? 'low' : 'medium'
    const task = tasks.createTask({
      title: (typeof title === 'string' && title.trim() ? title.trim() : row.title).slice(0, 200),
      description: typeof description === 'string'
        ? description.slice(0, 2000)
        : `${row.summary}\n\nSensor: ${row.sensor_id}\nEntity: ${row.entity_type} ${row.entity_id}`.slice(0, 2000),
      priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : severityPriority,
      project: typeof project === 'string' && project.trim() ? project.trim().slice(0, 80) : 'workspace',
      task_type: ['feature', 'bug', 'chore', 'test', 'docs'].includes(taskType) ? taskType : 'chore'
    })
    const note = `Promoted to task #${task.id}.`
    acknowledgeFindingStatement.run(at, note, at, id)
    recordEvent(id, 'promoted', {
      field: 'task_id',
      newValue: String(task.id),
      note,
      at
    })
    return { finding: toFinding(getFindingStatement.get(id)), task }
  })

  return {
    createSensorRun({ sensors = 0, startedAt = now() } = {}) {
      const result = insertRunStatement.run(sensors, startedAt)
      return toRun(getRunStatement.get(Number(result.lastInsertRowid)))
    },
    finishSensorRun(id, {
      status = 'completed',
      sensors = 0,
      detected = 0,
      created = 0,
      updated = 0,
      resolved = 0,
      reopened = 0,
      unchanged = 0,
      error = null,
      finishedAt = now()
    } = {}) {
      finishRunStatement.run({
        id,
        status: status === 'failed' ? 'failed' : 'completed',
        sensors,
        detected,
        created,
        updated,
        resolved,
        reopened,
        unchanged,
        error: error ?? null,
        finishedAt
      })
      return toRun(getRunStatement.get(id))
    },
    failSensorRun(id, error, finishedAt = now()) {
      failRunStatement.run(String(error ?? 'Sensor scan failed.').slice(0, 2000), finishedAt, id)
      return toRun(getRunStatement.get(id))
    },
    getSensorRun(id) {
      return toRun(getRunStatement.get(id))
    },
    listSensorRuns({ limit = 20 } = {}) {
      const requested = Number(limit)
      const safeLimit = Number.isFinite(requested) && requested >= 1
        ? Math.min(200, Math.trunc(requested))
        : 20
      return listRunsStatement.all(safeLimit).map(toRun)
    },
    applySensorScan(findings, options) {
      return applyScan(findings, options)
    },
    listSensorFindings({ state, sensorId, severity, limit = 100 } = {}) {
      const requested = Number(limit)
      const safeLimit = Number.isFinite(requested) && requested >= 1
        ? Math.min(500, Math.trunc(requested))
        : 100
      let rows
      if (state !== undefined) {
        rows = listFindingsByStateStatement.all(state)
      } else {
        rows = listFindingsStatement.all()
      }
      const filtered = rows.filter((row) => {
        if (sensorId !== undefined && row.sensor_id !== sensorId) return false
        if (severity !== undefined && row.severity !== severity) return false
        return true
      })
      return filtered.slice(0, safeLimit).map(toFinding)
    },
    getSensorFinding(id) {
      return toFinding(getFindingStatement.get(id))
    },
    getSensorFindingByKey(key) {
      return toFinding(getFindingByKeyStatement.get(String(key)))
    },
    getSensorFindingDetail(id, { eventLimit = 50 } = {}) {
      const finding = toFinding(getFindingStatement.get(id))
      if (!finding) return null
      const requested = Number(eventLimit)
      const safeLimit = Number.isFinite(requested) && requested >= 1
        ? Math.min(200, Math.trunc(requested))
        : 50
      return {
        ...finding,
        events: listFindingEventsStatement.all(id, safeLimit).map(toFindingEvent)
      }
    },
    acknowledgeSensorFinding(id, options) {
      return transition(id, 'acknowledge', options)
    },
    dismissSensorFinding(id, options) {
      return transition(id, 'dismiss', options)
    },
    resolveSensorFinding(id, options) {
      return transition(id, 'resolve', options)
    },
    reopenSensorFinding(id, options) {
      return transition(id, 'reopen', options)
    },
    promoteSensorFinding(id, options) {
      return promote(id, options)
    },
    getSensorSummary() {
      const states = Object.fromEntries(SENSOR_STATES.map((state) => [state, 0]))
      for (const row of countByStateStatement.all()) {
        if (SENSOR_STATE_SET.has(row.state)) states[row.state] = row.count
      }
      const bySeverity = Object.fromEntries(SENSOR_SEVERITIES.map((severity) => [severity, 0]))
      for (const row of countActiveBySeverityStatement.all()) {
        if (SENSOR_SEVERITY_SET.has(row.severity)) bySeverity[row.severity] = row.count
      }
      const active = states.open + states.acknowledged
      const total = Object.values(states).reduce((sum, count) => sum + count, 0)
      return {
        total,
        active,
        states,
        bySeverity,
        lastScan: listRunsStatement.all(1).map(toRun)[0] ?? null
      }
    }
  }
}

import express from 'express'
import { createResourceMonitor } from './resourceMonitor.js'
import { createAdaptiveCpuLimit } from './adaptiveCpuLimit.js'
import { buildTaskPrompt } from './localAiPrompt.js'
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'

loadWorkspaceEnv()

const MAX_TITLE_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_PROJECT_LENGTH = 80
const MAX_ACCEPTANCE_CRITERIA_LENGTH = 2000
const TASK_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done'])
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])
const LOCAL_AI_MIN_LOAD = Number(process.env.LOCAL_AI_MIN_LOAD ?? 0.5)
const LOCAL_AI_MAX_LOAD = Number(process.env.LOCAL_AI_MAX_LOAD ?? 1.0)
const LOCAL_AI_MIN_AVAILABLE_MEMORY_MB = Number(process.env.LOCAL_AI_MIN_AVAILABLE_MEMORY_MB ?? 1024)
const LOCAL_AI_MAX_DISK_BUSY_PERCENT = Number(process.env.LOCAL_AI_MAX_DISK_BUSY_PERCENT ?? 30)
const LOCAL_AI_TURN_COOLDOWN_MS = Number(process.env.LOCAL_AI_TURN_COOLDOWN_MS ?? 15000)
const LOCAL_AI_URL = (process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const LOCAL_AI_API_KEY = process.env.LOCAL_AI_API_KEY ?? ''
const MAX_AI_INPUT_LENGTH = 2000

if (!Number.isFinite(LOCAL_AI_MIN_LOAD) || LOCAL_AI_MIN_LOAD < 0) {
  throw new Error('LOCAL_AI_MIN_LOAD must be a non-negative number.')
}
if (!Number.isFinite(LOCAL_AI_MAX_LOAD) || LOCAL_AI_MAX_LOAD < LOCAL_AI_MIN_LOAD) {
  throw new Error('LOCAL_AI_MAX_LOAD must be at least LOCAL_AI_MIN_LOAD.')
}
if (!Number.isFinite(LOCAL_AI_MIN_AVAILABLE_MEMORY_MB) || LOCAL_AI_MIN_AVAILABLE_MEMORY_MB < 0) {
  throw new Error('LOCAL_AI_MIN_AVAILABLE_MEMORY_MB must be a non-negative number.')
}
if (
  !Number.isFinite(LOCAL_AI_MAX_DISK_BUSY_PERCENT) ||
  LOCAL_AI_MAX_DISK_BUSY_PERCENT < 0 ||
  LOCAL_AI_MAX_DISK_BUSY_PERCENT > 100
) {
  throw new Error('LOCAL_AI_MAX_DISK_BUSY_PERCENT must be between 0 and 100.')
}
if (!Number.isFinite(LOCAL_AI_TURN_COOLDOWN_MS) || LOCAL_AI_TURN_COOLDOWN_MS < 0) {
  throw new Error('LOCAL_AI_TURN_COOLDOWN_MS must be a non-negative number.')
}

function getBusyReasons(metrics, cpuLoadLimit) {
  const reasons = []
  if (!Number.isFinite(metrics.loadAverage)) {
    reasons.push('CPU load is unavailable')
  } else if (metrics.loadAverage >= cpuLoadLimit) {
    reasons.push(`CPU load ${metrics.loadAverage.toFixed(2)} is at/above ${cpuLoadLimit}`)
  }
  if (!Number.isFinite(metrics.availableMemoryMb)) {
    reasons.push('available memory is unavailable')
  } else if (metrics.availableMemoryMb < LOCAL_AI_MIN_AVAILABLE_MEMORY_MB) {
    reasons.push(
      `available memory ${Math.floor(metrics.availableMemoryMb)} MB is below ${LOCAL_AI_MIN_AVAILABLE_MEMORY_MB} MB`
    )
  }
  if (!Number.isFinite(metrics.diskBusyPercent)) {
    reasons.push('disk activity is unavailable')
  } else if (metrics.diskBusyPercent > LOCAL_AI_MAX_DISK_BUSY_PERCENT) {
    reasons.push(
      `disk busy time ${Math.round(metrics.diskBusyPercent)}% is above ${LOCAL_AI_MAX_DISK_BUSY_PERCENT}%`
    )
  }
  return reasons
}

function isValidText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength
}

function formatAcceptanceCriteria(criteria) {
  if (typeof criteria === 'string') return criteria
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('Model response must include acceptance_criteria as text or a non-empty list.')
  }

  return criteria.map((criterion, index) => {
    if (typeof criterion === 'string') {
      const text = criterion.trim()
      if (!text) {
        throw new Error('Model response contains an empty acceptance criterion.')
      }
      return `${index + 1}. ${text}`
    }
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
      throw new Error('Model response contains an invalid acceptance criterion.')
    }

    const details = Object.entries(criterion).map(([field, value]) => {
      if (typeof value !== 'string') {
        throw new Error('Model response contains a non-text acceptance criterion.')
      }
      return value.trim() ? `${field.replaceAll('_', ' ')}: ${value.trim()}` : ''
    }).filter(Boolean)
    if (details.length === 0) {
      throw new Error('Model response contains an empty acceptance criterion.')
    }
    return `${index + 1}. ${details.join('; ')}`
  }).join('\n')
}

function parseAssistantDraft(content) {
  const jsonContent = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const draft = JSON.parse(jsonContent)
  if (
    !draft ||
    typeof draft.description !== 'string'
  ) {
    throw new Error('Model response must include a description string.')
  }
  return {
    description: draft.description.slice(0, MAX_AI_INPUT_LENGTH),
    acceptance_criteria: formatAcceptanceCriteria(draft.acceptance_criteria)
      .slice(0, MAX_AI_INPUT_LENGTH)
  }
}

function validateTaskInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set([
    'title', 'description', 'completed', 'project', 'status', 'priority',
    'task_type', 'acceptance_criteria'
  ])
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported task field.'
  }

  if (!partial || Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return 'Title must be a non-empty string.'
    }
    if (body.title.trim().length > MAX_TITLE_LENGTH) {
      return `Title must be at most ${MAX_TITLE_LENGTH} characters.`
    }
  }

  if (Object.hasOwn(body, 'completed') && typeof body.completed !== 'boolean') {
    return 'Completed must be a boolean.'
  }

  if (Object.hasOwn(body, 'status') && !TASK_STATUSES.has(body.status)) {
    return `Status must be one of: ${[...TASK_STATUSES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'completed') && Object.hasOwn(body, 'status')) {
    const statusIsDone = body.status === 'done'
    if (body.completed !== statusIsDone) {
      return 'Completed must match the selected status.'
    }
  }
  if (Object.hasOwn(body, 'priority') && !TASK_PRIORITIES.has(body.priority)) {
    return `Priority must be one of: ${[...TASK_PRIORITIES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'task_type') && !TASK_TYPES.has(body.task_type)) {
    return `Task type must be one of: ${[...TASK_TYPES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'project')) {
    if (typeof body.project !== 'string' || !body.project.trim()) {
      return 'Project must be a non-empty string.'
    }
    if (body.project.trim().length > MAX_PROJECT_LENGTH) {
      return `Project must be at most ${MAX_PROJECT_LENGTH} characters.`
    }
  }
  if (Object.hasOwn(body, 'description')) {
    if (typeof body.description !== 'string') return 'Description must be a string.'
    if (body.description.length > MAX_DESCRIPTION_LENGTH) {
      return `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
    }
  }
  if (Object.hasOwn(body, 'acceptance_criteria')) {
    if (typeof body.acceptance_criteria !== 'string') {
      return 'Acceptance criteria must be a string.'
    }
    if (body.acceptance_criteria.length > MAX_ACCEPTANCE_CRITERIA_LENGTH) {
      return `Acceptance criteria must be at most ${MAX_ACCEPTANCE_CRITERIA_LENGTH} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

function parseId(value) {
  if (!/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function createApp(database, {
  fetchImpl = fetch,
  getResourceMetrics = createResourceMonitor(),
  getCpuLoadLimit = createAdaptiveCpuLimit({
    minLoad: LOCAL_AI_MIN_LOAD,
    maxLoad: LOCAL_AI_MAX_LOAD
  }),
  localAiUrl = LOCAL_AI_URL,
  localAiApiKey = LOCAL_AI_API_KEY
} = {}) {
  const app = express()
  let generationInProgress = false
  let nextGenerationAt = 0
  const localAiHeaders = {
    ...(localAiApiKey ? { Authorization: `Bearer ${localAiApiKey}` } : {})
  }
  app.use(express.json({ limit: '16kb' }))

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'api', database: 'sqlite' })
  })

  app.get('/api/tasks', (request, response) => {
    const filters = Object.fromEntries(
      ['project', 'status', 'priority', 'task_type', 'search']
        .map((field) => [field, request.query[field]])
        .filter(([, value]) => value !== undefined)
    )
    if (Object.values(filters).some((value) => typeof value !== 'string')) {
      return response.status(400).json({ error: 'Each task filter must have a single string value.' })
    }
    if (filters.project && filters.project.length > MAX_PROJECT_LENGTH) {
      return response.status(400).json({ error: `Project filter must be at most ${MAX_PROJECT_LENGTH} characters.` })
    }
    if (filters.status && !TASK_STATUSES.has(filters.status)) {
      return response.status(400).json({ error: `Status must be one of: ${[...TASK_STATUSES].join(', ')}.` })
    }
    if (filters.priority && !TASK_PRIORITIES.has(filters.priority)) {
      return response.status(400).json({ error: `Priority must be one of: ${[...TASK_PRIORITIES].join(', ')}.` })
    }
    if (filters.task_type && !TASK_TYPES.has(filters.task_type)) {
      return response.status(400).json({ error: `Task type must be one of: ${[...TASK_TYPES].join(', ')}.` })
    }
    if (filters.search && (typeof filters.search !== 'string' || filters.search.length > 200)) {
      return response.status(400).json({ error: 'Search must be at most 200 characters.' })
    }
    return response.json(database.listTasks(filters))
  })

  app.get('/api/projects', (_request, response) => {
    response.json(['workspace', ...database.listProjects().filter((project) => project !== 'workspace')])
  })

  app.get('/api/local-ai/status', async (_request, response) => {
    if (generationInProgress) {
      return response.json({
        state: 'busy',
        busyReasons: ['A local model request is already in progress.'],
        retryAfter: 5
      })
    }
    if (Date.now() < nextGenerationAt) {
      return response.json({
        state: 'busy',
        busyReasons: ['Cooling down between local model turns.'],
        retryAfter: Math.ceil((nextGenerationAt - Date.now()) / 1000)
      })
    }

    let metrics
    try {
      metrics = await getResourceMetrics()
    } catch (error) {
      console.error('Local AI resource monitoring failed:', error)
      return response.json({
        state: 'unavailable',
        error: 'Local AI resource monitoring is unavailable.'
      })
    }
    const cpuLoadLimit = getCpuLoadLimit(metrics.loadAverage)
    const limits = {
      cpuLoadLimit,
      minCpuLoad: LOCAL_AI_MIN_LOAD,
      maxCpuLoad: LOCAL_AI_MAX_LOAD,
      minAvailableMemoryMb: LOCAL_AI_MIN_AVAILABLE_MEMORY_MB,
      maxDiskBusyPercent: LOCAL_AI_MAX_DISK_BUSY_PERCENT
    }
    const busyReasons = getBusyReasons(metrics, cpuLoadLimit)
    if (busyReasons.length > 0) {
      return response.json({
        state: 'busy',
        metrics,
        limits,
        busyReasons
      })
    }

    try {
      const healthResponse = await fetchImpl(`${localAiUrl}/health`, {
        headers: localAiHeaders,
        signal: AbortSignal.timeout(5000)
      })
      if (!healthResponse.ok) throw new Error(`llama.cpp health returned ${healthResponse.status}`)
      return response.json({
        state: 'ready',
        metrics,
        limits
      })
    } catch (error) {
      console.error('Local AI health check failed:', error)
      return response.json({
        state: 'unavailable',
        error: 'Configured local AI endpoint is unavailable. Start the selected local model or reconnect Colab, then retry.'
      })
    }
  })

  app.post('/api/local-ai/refine-task', async (request, response) => {
    const input = request.body
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    if (Object.keys(input).some((key) => !['title', 'description', 'acceptance_criteria', 'project', 'task_type'].includes(key))) {
      return response.status(400).json({ error: 'Request includes an unsupported task field.' })
    }
    if (!isValidText(input.title, MAX_TITLE_LENGTH) || !input.title.trim()) {
      return response.status(400).json({ error: 'Title must be a non-empty string of at most 200 characters.' })
    }
    if (input.description !== undefined && !isValidText(input.description, MAX_AI_INPUT_LENGTH)) {
      return response.status(400).json({ error: 'Description must be at most 2000 characters.' })
    }
    if (input.acceptance_criteria !== undefined && !isValidText(input.acceptance_criteria, MAX_AI_INPUT_LENGTH)) {
      return response.status(400).json({ error: 'Acceptance criteria must be at most 2000 characters.' })
    }
    if (input.project !== undefined && (typeof input.project !== 'string' || input.project.length > MAX_PROJECT_LENGTH)) {
      return response.status(400).json({ error: 'Project must be a string of at most 80 characters.' })
    }
    if (input.task_type !== undefined && !TASK_TYPES.has(input.task_type)) {
      return response.status(400).json({ error: `Task type must be one of: ${[...TASK_TYPES].join(', ')}.` })
    }

    if (generationInProgress) {
      return response.status(503).json({
        error: 'Another local model request is in progress.',
        state: 'busy',
        busyReasons: ['A local model request is already in progress.'],
        retryAfter: 5
      })
    }
    if (Date.now() < nextGenerationAt) {
      return response.status(503).json({
        error: 'Local AI is cooling down between model turns.',
        state: 'busy',
        busyReasons: ['Cooling down between local model turns.'],
        retryAfter: Math.ceil((nextGenerationAt - Date.now()) / 1000)
      })
    }
    generationInProgress = true
    let inferenceStarted = false
    try {
      let metrics
      try {
        metrics = await getResourceMetrics()
      } catch (error) {
        console.error('Local AI resource monitoring failed:', error)
        return response.status(503).json({
          error: 'Local AI resource monitoring is unavailable.',
          state: 'unavailable'
        })
      }
      const cpuLoadLimit = getCpuLoadLimit(metrics.loadAverage)
      const limits = {
        cpuLoadLimit,
        minCpuLoad: LOCAL_AI_MIN_LOAD,
        maxCpuLoad: LOCAL_AI_MAX_LOAD,
        minAvailableMemoryMb: LOCAL_AI_MIN_AVAILABLE_MEMORY_MB,
        maxDiskBusyPercent: LOCAL_AI_MAX_DISK_BUSY_PERCENT
      }
      const busyReasons = getBusyReasons(metrics, cpuLoadLimit)
      if (busyReasons.length > 0) {
        return response.status(503).json({
          error: 'Local AI is paused while the machine is busy.',
          state: 'busy',
          metrics,
          limits,
          busyReasons,
          retryAfter: 5
        })
      }

      const prompt = buildTaskPrompt({
        title: input.title,
        project: input.project || 'workspace',
        task_type: input.task_type || 'feature',
        description: input.description || '',
        acceptance_criteria: input.acceptance_criteria || ''
      })

      try {
        inferenceStarted = true
        const modelResponse = await fetchImpl(`${localAiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...localAiHeaders },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({
            model: 'local-model',
            temperature: 0.2,
            max_tokens: prompt.maxTokens,
            response_format: { type: 'json_object' },
            messages: prompt.messages
          })
        })

        if (!modelResponse.ok) {
          console.error(`Local AI request failed with status ${modelResponse.status}.`)
          return response.status(502).json({ error: 'The local model rejected the request.' })
        }

        const result = await modelResponse.json()
        const content = result.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) {
          console.error('Local AI returned an empty or malformed completion.')
          return response.status(502).json({ error: 'The local model returned an empty response.' })
        }

        try {
          return response.json(parseAssistantDraft(content))
        } catch (error) {
          console.error('Could not parse local AI response:', error)
          return response.status(502).json({ error: 'The local model returned an invalid task draft. Please retry.' })
        }
      } catch (error) {
        console.error('Local AI request failed:', error)
        const status = error.name === 'TimeoutError' ? 504 : 503
        return response.status(status).json({
          error: status === 504
            ? 'The local model took too long to respond.'
            : 'The configured local AI endpoint is unavailable. Start the selected model or reconnect Colab and retry.'
        })
      }
    } finally {
      generationInProgress = false
      if (inferenceStarted) {
        nextGenerationAt = Date.now() + LOCAL_AI_TURN_COOLDOWN_MS
      }
    }
  })

  app.post('/api/tasks', (request, response) => {
    const validationError = validateTaskInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    const task = database.createTask({
      title: request.body.title.trim(),
      description: (request.body.description ?? '').trim(),
      project: (request.body.project ?? 'workspace').trim(),
      status: request.body.status ?? 'todo',
      priority: request.body.priority ?? 'medium',
      task_type: request.body.task_type ?? 'feature',
      acceptance_criteria: (request.body.acceptance_criteria ?? '').trim()
    })
    return response.status(201).json(task)
  })

  app.patch('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })

    const validationError = validateTaskInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'title')) changes.title = changes.title.trim()
    for (const field of ['description', 'acceptance_criteria', 'project']) {
      if (Object.hasOwn(changes, field)) changes[field] = changes[field].trim()
    }

    const task = database.updateTask(id, changes)
    if (!task) return response.status(404).json({ error: 'Task not found.' })
    return response.json(task)
  })

  app.delete('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    if (!database.deleteTask(id)) return response.status(404).json({ error: 'Task not found.' })
    return response.status(204).end()
  })

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Request body contains invalid JSON.' })
    }
    if (error.status === 413) {
      return response.status(413).json({ error: 'Request body is too large.' })
    }
    console.error('API request failed:', error)
    return response.status(500).json({ error: 'Internal server error.' })
  })

  return app
}

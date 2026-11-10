import express from 'express'
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { join, relative } from 'node:path'
import { createResourceMonitor } from './resourceMonitor.js'
import { createAdaptiveCpuLimit } from './adaptiveCpuLimit.js'
import { buildTaskPrompt } from './localAiPrompt.js'
import { createModelRegistry, modelQuotaProfiles, publicModelDefinition } from './modelRegistry.js'
import { createModelScheduler } from './modelScheduler.js'
import { createModelClient } from './modelClient.js'
import { createTaskJobStore } from './taskJobStore.js'
import { createModelMetrics } from './modelMetrics.js'
import { createModelBudget } from './modelBudget.js'
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'

loadWorkspaceEnv()

const MAX_TITLE_LENGTH = Number(process.env.MAX_TASK_TITLE_LENGTH ?? 200)
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_TASK_DESCRIPTION_LENGTH ?? 2000)
const MAX_PROJECT_LENGTH = Number(process.env.MAX_TASK_PROJECT_LENGTH ?? 80)
const MAX_ACCEPTANCE_CRITERIA_LENGTH = Number(process.env.MAX_TASK_ACCEPTANCE_CRITERIA_LENGTH ?? 2000)
const MAX_PLANNING_TEXT_LENGTH = Number(process.env.MAX_TASK_PLANNING_TEXT_LENGTH ?? 2000)
const AI_SESSION_ENCRYPTION_KEY = process.env.AI_SESSION_ENCRYPTION_KEY || ''

function encryptSessionSummary(value) {
  if (!AI_SESSION_ENCRYPTION_KEY) return value
  const key = createHash('sha256').update(AI_SESSION_ENCRYPTION_KEY).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptSessionSummary(value) {
  if (!AI_SESSION_ENCRYPTION_KEY || typeof value !== 'string' || !value.startsWith('enc:')) {
    return value
  }
  const parts = value.split(':')
  if (parts.length !== 4) return value
  const key = createHash('sha256').update(AI_SESSION_ENCRYPTION_KEY).digest()
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const encrypted = Buffer.from(parts[3], 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
const PLANNING_TEXT_FIELDS = [
  'objectives', 'requirements', 'decisions', 'relevant_files', 'important_context',
  'work_completed', 'work_active', 'work_blocked', 'next_move'
]
const TASK_TEXT_LIMITS = {
  description: MAX_DESCRIPTION_LENGTH,
  acceptance_criteria: MAX_ACCEPTANCE_CRITERIA_LENGTH,
  ...Object.fromEntries(
    PLANNING_TEXT_FIELDS.map((field) => [field, MAX_PLANNING_TEXT_LENGTH])
  )
}
const USER_FILE_TEXT_FIELDS = [
  'objective', 'requirements', 'decisions', 'relevant_files', 'important_context'
]
const USER_FILE_TEXT_LIMITS = Object.fromEntries(
  USER_FILE_TEXT_FIELDS.map((field) => [field, MAX_PLANNING_TEXT_LENGTH])
)
const USER_FILE_TEXT_LABELS = {
  objective: 'Objective',
  requirements: 'Requirements',
  decisions: 'Decisions',
  relevant_files: 'Relevant files',
  important_context: 'Important context',
  work_completed: 'Work completed',
  work_active: 'Active work',
  work_blocked: 'Blocked work',
  next_move: 'Next move'
}
const TASK_TEXT_LABELS = {
  description: 'Description',
  acceptance_criteria: 'Acceptance criteria',
  objectives: 'Objectives',
  requirements: 'Requirements',
  decisions: 'Decisions',
  relevant_files: 'Relevant files',
  important_context: 'Important context',
  work_completed: 'Work completed',
  work_active: 'Active work',
  work_blocked: 'Blocked work',
  next_move: 'Next move'
}
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

function validateRefineInput(input, { requireModel = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Request body must be a JSON object.'
  }
  const draftFields = [
    'title', ...Object.keys(TASK_TEXT_LIMITS), 'project', 'task_type', 'model', 'task_id'
  ]
  if (Object.keys(input).some((key) => !draftFields.includes(key))) {
    return 'Request includes an unsupported task field.'
  }
  if (!isValidText(input.title, MAX_TITLE_LENGTH) || !input.title.trim()) {
    return 'Title must be a non-empty string of at most 200 characters.'
  }
  for (const field of Object.keys(TASK_TEXT_LIMITS)) {
    if (input[field] !== undefined && !isValidText(input[field], MAX_AI_INPUT_LENGTH)) {
      return `${TASK_TEXT_LABELS[field]} must be at most ${MAX_AI_INPUT_LENGTH} characters.`
    }
  }
  if (input.project !== undefined && (typeof input.project !== 'string' || input.project.length > MAX_PROJECT_LENGTH)) {
    return 'Project must be a string of at most 80 characters.'
  }
  if (input.task_type !== undefined && !TASK_TYPES.has(input.task_type)) {
    return `Task type must be one of: ${[...TASK_TYPES].join(', ')}.`
  }
  if (input.model !== undefined && (!isValidText(input.model, 80) || !input.model.trim())) {
    return 'Model must be a non-empty model ID of at most 80 characters.'
  }
  if (
    input.task_id !== undefined &&
    (!Number.isSafeInteger(input.task_id) || input.task_id < 1)
  ) {
    return 'Task ID must be a positive integer.'
  }
  if (requireModel && input.model === undefined) {
    return 'Model is required for a background job.'
  }
  return undefined
}

function taskFromRefineInput(input) {
  return {
    title: input.title,
    project: input.project || 'workspace',
    task_type: input.task_type || 'feature',
    description: input.description || '',
    acceptance_criteria: input.acceptance_criteria || '',
    objectives: input.objectives || '',
    requirements: input.requirements || '',
    decisions: input.decisions || '',
    relevant_files: input.relevant_files || '',
    important_context: input.important_context || '',
    work_completed: input.work_completed || '',
    work_active: input.work_active || '',
    work_blocked: input.work_blocked || '',
    next_move: input.next_move || ''
  }
}

function validateTaskInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set([
    'title', 'description', 'completed', 'project', 'status', 'priority',
    'task_type', 'acceptance_criteria', ...PLANNING_TEXT_FIELDS
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
  for (const [field, maxLength] of Object.entries(TASK_TEXT_LIMITS)) {
    if (!Object.hasOwn(body, field)) continue
    if (typeof body[field] !== 'string') {
      return `${TASK_TEXT_LABELS[field]} must be a string.`
    }
    if (body[field].length > maxLength) {
      return `${TASK_TEXT_LABELS[field]} must be at most ${maxLength} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

function validateUserFileInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set(['path', ...USER_FILE_TEXT_FIELDS])
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported user-file field.'
  }

  if (!partial || Object.hasOwn(body, 'path')) {
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return 'Path must be a non-empty string.'
    }
    if (body.path.trim().length > 500) {
      return 'Path must be at most 500 characters.'
    }
  }

  for (const [field, maxLength] of Object.entries(USER_FILE_TEXT_LIMITS)) {
    if (!Object.hasOwn(body, field)) continue
    if (typeof body[field] !== 'string') {
      return `${USER_FILE_TEXT_LABELS[field]} must be a string.`
    }
    if (body[field].length > maxLength) {
      return `${USER_FILE_TEXT_LABELS[field]} must be at most ${maxLength} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

function validateFolderInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set(['path', 'objective'])
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported folder field.'
  }

  if (!partial || Object.hasOwn(body, 'path')) {
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return 'Path must be a non-empty string.'
    }
    if (body.path.trim().length > 500) {
      return 'Path must be at most 500 characters.'
    }
  }

  if (Object.hasOwn(body, 'objective')) {
    if (typeof body.objective !== 'string') {
      return 'Objective must be a string.'
    }
    if (body.objective.length > MAX_PLANNING_TEXT_LENGTH) {
      return `Objective must be at most ${MAX_PLANNING_TEXT_LENGTH} characters.`
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

function quotaLimitLabel(budget) {
  const limiter = budget?.budget
  if (!limiter) return 'configured quota'
  if (limiter.unit === 'requests' && limiter.window === 'day') {
    return 'daily request limit'
  }
  const unit = limiter.unit === 'compute_seconds' ? 'compute' : limiter.unit
  return `${limiter.window} ${unit} limit`
}

function applyCooldown(modelBudget, model, error) {
  if (error?.status !== 429 || error.retryAfter === undefined) return
  modelBudget.cooldown?.(model.id, error.retryAfter)
}

export function createApp(database, {
  fetchImpl = fetch,
  getResourceMetrics = createResourceMonitor(),
  getCpuLoadLimit = createAdaptiveCpuLimit({
    minLoad: LOCAL_AI_MIN_LOAD,
    maxLoad: LOCAL_AI_MAX_LOAD
  }),
  localAiUrl = LOCAL_AI_URL,
  localAiApiKey = LOCAL_AI_API_KEY,
  models = createModelRegistry({ localAiUrl }),
  modelClient = createModelClient({ fetchImpl, apiKey: localAiApiKey }),
  modelMetrics = createModelMetrics(),
  modelBudget = createModelBudget({
    repository: database,
    profiles: modelQuotaProfiles(models)
  }),
  turnCooldownMs = LOCAL_AI_TURN_COOLDOWN_MS
} = {}) {
  const app = express()
  const scheduler = createModelScheduler({
    models,
    getResourceMetrics,
    getCpuLoadLimit,
    fetchImpl,
    probeModel: modelClient.probe,
    apiKey: localAiApiKey,
    minAvailableMemoryMb: LOCAL_AI_MIN_AVAILABLE_MEMORY_MB,
    minCpuLoad: LOCAL_AI_MIN_LOAD,
    maxCpuLoad: LOCAL_AI_MAX_LOAD,
    maxDiskBusyPercent: LOCAL_AI_MAX_DISK_BUSY_PERCENT,
    turnCooldownMs,
    getModelMetrics: modelMetrics.snapshot
  })
  const jobStore = createTaskJobStore({ repository: database })
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

  app.get('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })

    let activityLimit = 50
    if (request.query.activity_limit !== undefined) {
      if (!/^[1-9]\d*$/.test(request.query.activity_limit)) {
        return response.status(400).json({ error: 'Activity limit must be a positive integer.' })
      }
      activityLimit = Number(request.query.activity_limit)
      if (!Number.isSafeInteger(activityLimit) || activityLimit > 200) {
        return response.status(400).json({ error: 'Activity limit must be at most 200.' })
      }
    }

    let aiLimit = 20
    if (request.query.ai_limit !== undefined) {
      if (!/^[1-9]\d*$/.test(request.query.ai_limit)) {
        return response.status(400).json({ error: 'AI run limit must be a positive integer.' })
      }
      aiLimit = Number(request.query.ai_limit)
      if (!Number.isSafeInteger(aiLimit) || aiLimit > 100) {
        return response.status(400).json({ error: 'AI run limit must be at most 100.' })
      }
    }

    const task = database.getTaskDetail(id, { activityLimit, aiLimit })
    if (!task) return response.status(404).json({ error: 'Task not found.' })
    return response.json(task)
  })

  app.get('/api/projects', (_request, response) => {
    response.json(['workspace', ...database.listProjects().filter((project) => project !== 'workspace')])
  })

  function withBudget(status) {
    const budget = modelBudget.snapshot(status.id)
    return budget ? { ...status, budget } : status
  }

  async function selectDraftModel(input) {
    let selection
    try {
      selection = await scheduler.select(input.model?.trim())
    } catch (error) {
      console.error('Local AI model selection failed:', error)
      return {
        error: {
          status: 503,
          body: { error: 'Local AI model selection failed.', state: 'unavailable' }
        }
      }
    }
    if (selection.error) return { error: selection.error }

    const model = selection.model
    const budget = modelBudget.check(model.id)
    if (!budget.ok) {
      selection.release({ inferenceStarted: false })
      return {
        error: {
          status: 429,
          body: {
            error: `${model.label} reached its ${quotaLimitLabel(budget)} (${budget.budget.used}/${budget.budget.limit}).`,
            ...budget
          }
        }
      }
    }
    return { selection, model }
  }

  function submitDraftJob(input, model, selection) {
    const task = taskFromRefineInput(input)
    const prompt = buildTaskPrompt(task)
    modelBudget.record(model.id)

    const runner = async ({ signal, onPhase }) => {
      let inferenceStarted = false
      let startedAt
      try {
        inferenceStarted = true
        startedAt = Date.now()
        modelMetrics.recordStart(model.id)
        let content
        try {
          content = await modelClient.complete(model, {
            messages: prompt.messages,
            maxTokens: prompt.maxTokens,
            task,
            signal,
            onPhase,
            onUsage: (usage) => modelBudget.recordUsage?.(model.id, usage)
          })
          modelMetrics.recordSuccess(model.id, { durationMs: Date.now() - startedAt })
        } catch (error) {
          applyCooldown(modelBudget, model, error)
          modelMetrics.recordError(model.id, error, {
            durationMs: startedAt === undefined ? undefined : Date.now() - startedAt
          })
          throw error
        }

        try {
          return parseAssistantDraft(content)
        } catch (error) {
          console.error('Could not parse local AI response:', error)
          throw Object.assign(
            new Error('The local model returned an invalid task draft. Please retry.'),
            { status: 502 }
          )
        }
      } finally {
        selection.release({ inferenceStarted })
      }
    }

    return jobStore.submit({
      model: model.id,
      backend: model.backend,
      title: task.title,
      taskId: input.task_id,
      runner
    })
  }

  async function startDraftJob(input) {
    const selected = await selectDraftModel(input)
    if (selected.error) return selected
    if (taskNotFound(input)) {
      selected.selection.release({ inferenceStarted: false })
      return { error: { status: 404, body: { error: 'Task not found.' } } }
    }
    try {
      return { job: submitDraftJob(input, selected.model, selected.selection) }
    } catch (error) {
      selected.selection.release({ inferenceStarted: false })
      throw error
    }
  }

  function taskNotFound(input) {
    return input.task_id !== undefined && !database.getTask(input.task_id)
  }

  app.get('/api/models', (_request, response) => {
    response.json(models.map((model) => withBudget({
      ...publicModelDefinition(model),
      ...(modelMetrics.snapshot(model.id) || {})
    })))
  })

  app.get('/api/local-ai/status', async (_request, response) => {
    try {
      const status = await scheduler.status()
      return response.json({
        ...status,
        models: status.models.map(withBudget)
      })
    } catch (error) {
      console.error('Local AI status failed:', error)
      return response.json({
        state: 'unavailable',
        error: 'Local AI status is unavailable.'
      })
    }
  })

  app.post('/api/local-ai/refine-task', async (request, response) => {
    const input = request.body
    const validationError = validateRefineInput(input)
    if (validationError) {
      return response.status(400).json({ error: validationError })
    }
    if (taskNotFound(input)) {
      return response.status(404).json({ error: 'Task not found.' })
    }

    const started = await startDraftJob(input)
    if (started.error) {
      return response.status(started.error.status).json(started.error.body)
    }

    const job = await jobStore.wait(started.job.id)
    if (job.state === 'done') return response.json(job.result)
    if (job.state === 'cancelled') {
      return response.status(499).json({ error: job.error || 'The draft was cancelled.' })
    }
    return response.status(job.status ?? 503).json({
      error: job.error || 'The local model is unavailable.',
      ...(job.retryAfter !== undefined ? { retryAfter: job.retryAfter } : {})
    })
  })

  app.get('/api/local-ai/jobs', (_request, response) => {
    response.json(jobStore.list())
  })

  app.get('/api/local-ai/jobs/:id', (request, response) => {
    const job = jobStore.get(request.params.id)
    if (!job) {
      return response.status(404).json({ error: `Unknown job: ${request.params.id}.` })
    }
    return response.json(job)
  })

  app.delete('/api/local-ai/jobs/:id', (request, response) => {
    const result = jobStore.cancel(request.params.id)
    if (!result) {
      return response.status(404).json({ error: `Unknown job: ${request.params.id}.` })
    }
    return response.status(result.cancelled ? 202 : 409).json(result.job)
  })

  app.post('/api/local-ai/jobs', async (request, response) => {
    const input = request.body
    const validationError = validateRefineInput(input, { requireModel: true })
    if (validationError) {
      return response.status(400).json({ error: validationError })
    }
    if (taskNotFound(input)) {
      return response.status(404).json({ error: 'Task not found.' })
    }

    const started = await startDraftJob(input)
    if (started.error) {
      return response.status(started.error.status).json(started.error.body)
    }

    return response.status(202).json(started.job)
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
      acceptance_criteria: (request.body.acceptance_criteria ?? '').trim(),
      objectives: (request.body.objectives ?? '').trim(),
      requirements: (request.body.requirements ?? '').trim(),
      decisions: (request.body.decisions ?? '').trim(),
      relevant_files: (request.body.relevant_files ?? '').trim(),
      important_context: (request.body.important_context ?? '').trim(),
      work_completed: (request.body.work_completed ?? '').trim(),
      work_active: (request.body.work_active ?? '').trim(),
      work_blocked: (request.body.work_blocked ?? '').trim(),
      next_move: (request.body.next_move ?? '').trim()
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
    for (const field of [...Object.keys(TASK_TEXT_LIMITS), 'project']) {
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
    jobStore.unlinkTask(id)
    return response.status(204).end()
  })

  function isTrackedUserFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false
    const normalized = filePath.replace(/\\\\/g, '/')
    const noisePrefixes = [
      'node_modules/', 'apps/python/.venv/', 'apps/web/dist/', 'apps/api/data/',
      '.git/'
    ]
    if (noisePrefixes.some((prefix) => normalized.startsWith(prefix))) return false
    if (normalized.split('/').includes('__pycache__')) return false
    const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase()
    const allowedExtensions = new Set([
      '.js', '.mjs', '.py', '.css', '.html', '.md', '.yml', '.yaml'
    ])
    if (!allowedExtensions.has(extension)) return false
    return true
  }

  app.get('/api/files', (request, response) => {
    response.json(database.listUserFiles({ search: request.query.search || '' }))
  })

  app.get('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })
    const file = database.getUserFile(id)
    if (!file) return response.status(404).json({ error: 'User file not found.' })
    return response.json(file)
  })

  app.post('/api/files', (request, response) => {
    const validationError = validateUserFileInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    if (database.getUserFileByPath(request.body.path.trim())) {
      return response.status(409).json({ error: 'A tracked user file already uses this path.' })
    }

    const file = database.createUserFile({
      path: request.body.path.trim(),
      ...Object.fromEntries(
        USER_FILE_TEXT_FIELDS.map((field) => [
          field,
          (request.body[field] ?? '').trim()
        ])
      )
    })
    return response.status(201).json(file)
  })

  app.patch('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })

    const validationError = validateUserFileInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'path')) changes.path = changes.path.trim()
    for (const field of USER_FILE_TEXT_FIELDS) {
      if (Object.hasOwn(changes, field)) changes[field] = changes[field].trim()
    }

    const file = database.updateUserFile(id, changes)
    if (!file) return response.status(404).json({ error: 'User file not found.' })
    return response.json(file)
  })

  app.delete('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })
    if (!database.deleteUserFile(id)) return response.status(404).json({ error: 'User file not found.' })
    return response.status(204).end()
  })

  app.post('/api/files/scan', async (_request, response) => {
    try {
      const { readdirSync } = await import('node:fs')
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      const entries = readdirSync(root, { recursive: true, withFileTypes: true })
      const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const parent = entry.parentPath || entry.path
          return relative(root, join(parent, entry.name))
        })
        .map((filePath) => filePath.replace(/\\\\/g, '/'))
        .filter(isTrackedUserFile)
      const result = database.scanUserFiles(paths)
      response.json({ ...result, paths })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan user files.' })
    }
  })

  app.get('/api/folders', (_request, response) => {
    response.json(database.listFolders())
  })

  app.get('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })
    const folder = database.getFolder(id)
    if (!folder) return response.status(404).json({ error: 'Folder not found.' })
    return response.json(folder)
  })

  app.post('/api/folders', (request, response) => {
    const validationError = validateFolderInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    if (database.getFolderByPath(request.body.path.trim())) {
      return response.status(409).json({ error: 'A tracked folder already uses this path.' })
    }

    const folder = database.createFolder({
      path: request.body.path.trim(),
      objective: (request.body.objective ?? '').trim()
    })
    return response.status(201).json(folder)
  })

  app.patch('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })

    const validationError = validateFolderInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'path')) changes.path = changes.path.trim()
    if (Object.hasOwn(changes, 'objective')) changes.objective = changes.objective.trim()

    const folder = database.updateFolder(id, changes)
    if (!folder) return response.status(404).json({ error: 'Folder not found.' })
    return response.json(folder)
  })

  app.delete('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })
    if (!database.deleteFolder(id)) return response.status(404).json({ error: 'Folder not found.' })
    return response.status(204).end()
  })

  app.post('/api/folders/scan', async (_request, response) => {
    try {
      const { readdirSync } = await import('node:fs')
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      const entries = readdirSync(root, { recursive: true, withFileTypes: true })
      const paths = [...new Set(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const parent = entry.parentPath || entry.path
            return relative(root, join(parent, entry.name)).replace(/\\\\/g, '/')
          })
          .filter((folderPath) => folderPath && !folderPath.includes('node_modules') && !folderPath.includes('.git'))
      )]
      const result = database.scanFolders(paths)
      response.json({ ...result, paths })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan folders.' })
    }
  })

  app.get('/api/git-worktrees', (_request, response) => {
    response.json(database.listGitWorktrees())
  })

  app.post('/api/git-worktrees/scan', async (_request, response) => {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      const remoteUrl = (() => {
        try {
          return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
            encoding: 'utf8'
          }).trim()
        } catch {
          return ''
        }
      })()
      const output = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8'
      })
      const entries = []
      let current = {}
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          if (current.worktreePath) entries.push(current)
          current = { repositoryRoot: root, worktreePath: line.slice(9).trim() }
        } else if (line.startsWith('HEAD ')) {
          current.headCommit = line.slice(5).trim()
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
        } else if (line === '') {
          if (current.worktreePath) entries.push(current)
          current = {}
        }
      }
      if (current.worktreePath) entries.push(current)
      for (const entry of entries) {
        entry.remoteUrl = remoteUrl
      }
      const result = database.scanGitWorktrees(entries)
      response.json({ ...result, entries })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan Git worktrees.' })
    }
  })

  app.get('/api/tools', (_request, response) => {
    response.json(database.listTools())
  })

  app.post('/api/tools/scan', async (_request, response) => {
    const commands = [
      { name: 'node', command: 'node' },
      { name: 'npm', command: 'npm' },
      { name: 'uv', command: 'uv' },
      { name: 'python', command: 'python3' },
      { name: 'git', command: 'git' },
      { name: 'colab', command: 'colab' },
      { name: 'kaggle', command: 'kaggle' }
    ]
    const entries = commands.map((item) => {
      let available = false
      let version = ''
      try {
        execFileSync('sh', ['-c', `command -v ${item.command}`], { stdio: 'ignore' })
        available = true
      } catch {
        available = false
      }
      if (available) {
        try {
          version = execFileSync(item.command, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          }).trim().split(/\r?\n/)[0]
        } catch {
          version = ''
        }
      }
      return {
        name: item.name,
        command: item.command,
        version,
        available
      }
    })
    const result = database.scanTools(entries)
    response.json({ ...result, entries })
  })

  app.get('/api/environments', (_request, response) => {
    response.json(database.listEnvironments())
  })

  app.post('/api/environments/scan', async (_request, response) => {
    try {
      const { execFileSync } = await import('node:child_process')
      const entries = [
        { name: 'os', value: process.platform, source: 'process.platform' },
        { name: 'architecture', value: process.arch, source: 'process.arch' },
        { name: 'node', value: process.version, source: 'process.version' },
        { name: 'cwd', value: process.cwd(), source: 'process.cwd' }
      ]
      const result = database.scanEnvironments(entries)
      response.json({ ...result, entries })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan environments.' })
    }
  })

  app.get('/api/ai/sessions', (_request, response) => {
    response.json(database.listAiSessions().map((session) => ({
      ...session,
      summary: decryptSessionSummary(session.summary)
    })))
  })

  app.get('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    const session = database.getAiSession(id)
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json({ ...session, summary: decryptSessionSummary(session.summary) })
  })

  app.post('/api/ai/sessions', (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const title = typeof request.body.title === 'string' ? request.body.title.trim().slice(0, 200) : ''
    let taskId
    if (request.body.task_id !== undefined) {
      if (!Number.isSafeInteger(request.body.task_id) || request.body.task_id < 1) {
        return response.status(400).json({ error: 'Task ID must be a positive integer.' })
      }
      if (!database.getTask(request.body.task_id)) {
        return response.status(404).json({ error: 'Task not found.' })
      }
      taskId = request.body.task_id
    }
    const session = database.createAiSession({ title, taskId })
    return response.status(201).json(session)
  })

  app.post('/api/ai/sessions/:id/messages', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const role = request.body.role
    const content = request.body.content
    if (typeof role !== 'string' || !['system', 'user', 'assistant'].includes(role)) {
      return response.status(400).json({ error: 'Role must be system, user, or assistant.' })
    }
    if (typeof content !== 'string' || content.length === 0 || content.length > 20000) {
      return response.status(400).json({ error: 'Content must be between 1 and 20000 characters.' })
    }
    const session = database.addAiMessage(id, { role, content })
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  app.post('/api/ai/sessions/:id/compact', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const summary = request.body.summary
    if (typeof summary !== 'string' || summary.length === 0 || summary.length > 20000) {
      return response.status(400).json({ error: 'Summary must be between 1 and 20000 characters.' })
    }
    const session = database.compactAiSession(id, encryptSessionSummary(summary))
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  app.delete('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!database.deleteAiSession(id)) return response.status(404).json({ error: 'AI session not found.' })
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

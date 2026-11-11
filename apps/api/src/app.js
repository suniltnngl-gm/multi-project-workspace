import express from 'express'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createResourceMonitor } from './resourceMonitor.js'
import { createAdaptiveCpuLimit } from './adaptiveCpuLimit.js'
import { buildTaskPrompt } from './localAiPrompt.js'
import { createModelRegistry, modelQuotaProfiles, publicModelDefinition } from './modelRegistry.js'
import { createModelScheduler } from './modelScheduler.js'
import { createModelClient } from './modelClient.js'
import { createTaskJobStore } from './taskJobStore.js'
import { createModelMetrics } from './modelMetrics.js'
import { createModelBudget } from './modelBudget.js'
import { scanWorkspaceUserFiles, listWorkspaceFolders } from './workspaceScan.js'
import { createLocalVerifier, VerificationError } from './localVerifier.js'
import { createOpenCodeRosterCacheFromEnv } from './opencodeDiscovery.js'
import { createTaskWorktrees, parseWorktreePorcelain } from './taskWorktrees.js'
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'

loadWorkspaceEnv()

const MAX_TITLE_LENGTH = Number(process.env.MAX_TASK_TITLE_LENGTH ?? 200)
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_TASK_DESCRIPTION_LENGTH ?? 2000)
const MAX_PROJECT_LENGTH = Number(process.env.MAX_TASK_PROJECT_LENGTH ?? 80)
const MAX_ACCEPTANCE_CRITERIA_LENGTH = Number(process.env.MAX_TASK_ACCEPTANCE_CRITERIA_LENGTH ?? 2000)
const MAX_PLANNING_TEXT_LENGTH = Number(process.env.MAX_TASK_PLANNING_TEXT_LENGTH ?? 2000)
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
const AI_MESSAGE_MAX_LENGTH = 20000
const MAX_AI_MESSAGES = Number(process.env.AI_MAX_MESSAGES ?? 20)
const MAX_AI_VARIABLES = 20
const MAX_AI_VARIABLE_LENGTH = 2000
const AI_SESSION_CONTEXT_MESSAGES = Number(process.env.AI_SESSION_CONTEXT_MESSAGES ?? 10)
const AI_SESSION_SUMMARY_MAX_CHARS = 2000
const AI_COMPLETE_DEFAULT_MAX_TOKENS = 400
const AI_COMPLETE_MAX_TOKENS_LIMIT = 2000
const COMPLETE_MESSAGE_ROLES = new Set(['system', 'user', 'assistant'])
const COMPLETE_INPUT_FIELDS = new Set([
  'prompt', 'system', 'messages', 'model', 'prompt_template_id', 'variables',
  'session_id', 'task_id', 'max_tokens'
])

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
    'title', ...Object.keys(TASK_TEXT_LIMITS), 'project', 'task_type', 'model', 'task_id', 'session_id'
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
  if (
    input.session_id !== undefined &&
    (!Number.isSafeInteger(input.session_id) || input.session_id < 1)
  ) {
    return 'Session ID must be a positive integer.'
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

function validateCompleteInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }
  for (const key of Object.keys(body)) {
    if (!COMPLETE_INPUT_FIELDS.has(key)) {
      return `Request includes an unsupported field: ${key}.`
    }
  }
  if (body.prompt !== undefined && !isValidText(body.prompt, AI_MESSAGE_MAX_LENGTH)) {
    return `Prompt must be a non-empty string of at most ${AI_MESSAGE_MAX_LENGTH} characters.`
  }
  if (body.system !== undefined && !isValidText(body.system, AI_MESSAGE_MAX_LENGTH)) {
    return `System must be a non-empty string of at most ${AI_MESSAGE_MAX_LENGTH} characters.`
  }
  if (body.model !== undefined && (!isValidText(body.model, 80) || !body.model.trim())) {
    return 'Model must be a non-empty model ID of at most 80 characters.'
  }
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_AI_MESSAGES) {
      return `Messages must be an array of 1 to ${MAX_AI_MESSAGES} entries.`
    }
    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return 'Each message must be an object with role and content.'
      }
      if (!COMPLETE_MESSAGE_ROLES.has(message.role)) {
        return 'Message role must be system, user, or assistant.'
      }
      if (!isValidText(message.content, AI_MESSAGE_MAX_LENGTH) || !message.content.trim()) {
        return `Message content must be a non-empty string of at most ${AI_MESSAGE_MAX_LENGTH} characters.`
      }
      const unsupported = Object.keys(message).find((key) => key !== 'role' && key !== 'content')
      if (unsupported !== undefined) {
        return `Message includes an unsupported field: ${unsupported}.`
      }
    }
  }
  if (body.variables !== undefined) {
    if (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables)) {
      return 'Variables must be an object of template values.'
    }
    const entries = Object.entries(body.variables)
    if (entries.length > MAX_AI_VARIABLES) {
      return `Variables must contain at most ${MAX_AI_VARIABLES} entries.`
    }
    for (const [key, value] of entries) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) {
        return 'Variable names may contain only letters, numbers, and underscores.'
      }
      if (typeof value !== 'string' || value.length > MAX_AI_VARIABLE_LENGTH) {
        return `Variable ${key} must be a string of at most ${MAX_AI_VARIABLE_LENGTH} characters.`
      }
    }
  }
  for (const field of ['prompt_template_id', 'session_id', 'task_id']) {
    if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1)) {
      return `${field} must be a positive integer.`
    }
  }
  if (body.max_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > AI_COMPLETE_MAX_TOKENS_LIMIT) {
      return `max_tokens must be an integer between 1 and ${AI_COMPLETE_MAX_TOKENS_LIMIT}.`
    }
  }
  if (body.prompt === undefined && body.messages === undefined && body.prompt_template_id === undefined) {
    return 'Provide prompt, messages, or prompt_template_id.'
  }
  return undefined
}

function renderTemplateText(text, variables) {
  return String(text).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (original, key) => (
    variables && Object.hasOwn(variables, key) ? variables[key] : original
  ))
}

function buildCompleteMessages(body, template, session) {
  const context = []
  const systemPrompt = template && template.systemPrompt.trim()
    ? renderTemplateText(template.systemPrompt, body.variables)
    : (typeof body.system === 'string' && body.system.trim() ? body.system : '')
  if (systemPrompt) {
    context.push({ role: 'system', content: systemPrompt })
  }
  if (session) {
    if (typeof session.summary === 'string' && session.summary.trim()) {
      context.push({
        role: 'system',
        content: `Previous conversation summary:\n${session.summary.slice(0, AI_SESSION_SUMMARY_MAX_CHARS)}`
      })
    }
    const history = session.messages.slice(-AI_SESSION_CONTEXT_MESSAGES)
    for (const message of history) {
      if (!COMPLETE_MESSAGE_ROLES.has(message.role)) continue
      context.push({
        role: message.role,
        content: String(message.content).slice(0, AI_MESSAGE_MAX_LENGTH)
      })
    }
  }

  const newMessages = []
  if (template && template.userTemplate.trim()) {
    newMessages.push({ role: 'user', content: renderTemplateText(template.userTemplate, body.variables) })
  }
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    newMessages.push({ role: 'user', content: body.prompt })
  }
  for (const message of body.messages ?? []) {
    newMessages.push({ role: message.role, content: message.content })
  }
  return { messages: [...context, ...newMessages], newMessages }
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
  verifier,
  opencodeRosterCache,
  taskWorktrees,
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

  // The local verifier resolves the repository root on first use, mirroring
  // the scan endpoints, so the API works from any cwd inside the repository.
  let resolvedVerifier = null
  const getVerifier = () => {
    if (verifier) return verifier
    if (resolvedVerifier === null) {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      resolvedVerifier = createLocalVerifier({ rootDir: root })
    }
    return resolvedVerifier
  }

  // Task worktrees resolve the repository root on first use as well; tests
  // inject a manager bound to a temporary repository instead.
  let resolvedTaskWorktrees = null
  const getTaskWorktrees = () => {
    if (taskWorktrees) return taskWorktrees
    if (resolvedTaskWorktrees === null) {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      resolvedTaskWorktrees = createTaskWorktrees({ repoRoot: root })
    }
    return resolvedTaskWorktrees
  }
  app.use(express.json({ limit: '16kb' }))

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'api', database: 'sqlite' })
  })

  app.get('/api/verify', (_request, response) => {
    let verifierForRequest
    try {
      verifierForRequest = getVerifier()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for local checks.' })
    }
    return response.json({ checks: verifierForRequest.listChecks() })
  })

  app.post('/api/verify', async (request, response) => {
    let verifierForRequest
    try {
      verifierForRequest = getVerifier()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for local checks.' })
    }
    const requested = request.body?.checks
    if (requested !== undefined && (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      requested.some((id) => typeof id !== 'string' || id.length === 0)
    )) {
      return response.status(400).json({ error: 'checks must be a non-empty array of check ids.' })
    }
    try {
      return response.json(await verifierForRequest.runChecks(requested))
    } catch (error) {
      if (error instanceof VerificationError) {
        return response.status(400).json({ error: error.message })
      }
      return response.status(500).json({ error: 'Could not run local checks.' })
    }
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
    const sessionSummary = input.session_id !== undefined
      ? String(database.getAiSession(input.session_id)?.summary ?? '')
      : ''
    const prompt = buildTaskPrompt(task, { sessionSummary })
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
    if (sessionNotFound(input)) {
      selected.selection.release({ inferenceStarted: false })
      return { error: { status: 404, body: { error: 'AI session not found.' } } }
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

  function sessionNotFound(input) {
    return input.session_id !== undefined && !database.getAiSession(input.session_id)
  }

  app.get('/api/models', (_request, response) => {
    response.json(models.map((model) => withBudget({
      ...publicModelDefinition(model),
      ...(modelMetrics.snapshot(model.id) || {})
    })))
  })

  // The OpenCode roster is discovered from the local CLI on demand and cached;
  // tests inject a cache so the real CLI never runs in the suite.
  let resolvedOpenCodeRosterCache = null
  const getOpenCodeRosterCache = () => {
    if (opencodeRosterCache) return opencodeRosterCache
    if (resolvedOpenCodeRosterCache === null) {
      resolvedOpenCodeRosterCache = createOpenCodeRosterCacheFromEnv()
    }
    return resolvedOpenCodeRosterCache
  }

  app.get('/api/models/opencode', async (request, response) => {
    const slot = models.find((model) => model.id === 'opencode')
    if (!slot) {
      return response.status(404).json({ error: 'The OpenCode backend is not registered.' })
    }
    const refresh = ['1', 'true', 'yes'].includes(String(request.query.refresh ?? '').toLowerCase())
    let roster
    try {
      roster = await getOpenCodeRosterCache().get({ refresh })
    } catch (error) {
      return response.status(500).json({ error: 'Could not read the OpenCode model roster.' })
    }
    const model = slot.cli?.model ?? null
    return response.json({
      model,
      inRoster: roster.ok ? roster.models.includes(model) : null,
      availableModels: roster.models,
      count: roster.models.length,
      fetchedAt: roster.fetchedAt,
      ...(roster.ok ? {} : { error: roster.error })
    })
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
    if (sessionNotFound(input)) {
      return response.status(404).json({ error: 'AI session not found.' })
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
    if (sessionNotFound(input)) {
      return response.status(404).json({ error: 'AI session not found.' })
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

  app.get('/api/files', (request, response) => {
    response.json(database.listUserFiles({ search: request.query.search || '' }))
  })

  app.get('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })
    const file = database.getUserFileDetail(id)
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

  app.post('/api/files/scan', (_request, response) => {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      response.json(scanWorkspaceUserFiles({ rootDir: root, database }))
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

  app.post('/api/folders/scan', (_request, response) => {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
      const paths = listWorkspaceFolders(root)
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
      const entries = parseWorktreePorcelain(output, root)
      for (const entry of entries) {
        entry.remoteUrl = remoteUrl
      }
      const result = database.scanGitWorktrees(entries)
      response.json({ ...result, entries })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan Git worktrees.' })
    }
  })

  async function refreshGitWorktreeRows(worktrees) {
    const remoteUrl = (() => {
      try {
        return execFileSync(
          'git',
          ['-C', worktrees.repoRoot, 'remote', 'get-url', 'origin'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()
      } catch {
        return ''
      }
    })()
    const entries = (await worktrees.listEntries()).map((entry) => ({ ...entry, remoteUrl }))
    database.scanGitWorktrees(entries)
    return entries
  }

  app.post('/api/tasks/:id/worktree', async (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    const task = database.getTask(id)
    if (!task) {
      return response.status(404).json({ error: 'Task not found.' })
    }
    let worktrees
    try {
      worktrees = getTaskWorktrees()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for task worktrees.' })
    }

    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {}
    const branch = typeof body.branch === 'string' && body.branch.trim()
      ? body.branch.trim()
      : undefined
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : undefined

    // A stale link (worktree removed by hand) self-heals: prune the
    // registration and relink instead of wedging the task.
    if (task.worktree_path) {
      if (existsSync(task.worktree_path)) {
        return response.status(409).json({
          error: 'This task already has a worktree linked.',
          worktreePath: task.worktree_path
        })
      }
      try {
        await worktrees.prune()
      } catch {
        // Pruning is best-effort; the link is stale either way.
      }
      database.deleteGitWorktree(task.worktree_path)
      database.unlinkTaskWorktree(id)
    }

    const location = worktrees.resolveWorktree({ taskId: id, title: task.title, name, branch })
    if (existsSync(location.path)) {
      return response.status(409).json({
        error: 'A worktree already exists at the task location; remove it first.',
        worktreePath: location.path
      })
    }
    try {
      await worktrees.create({ taskId: id, title: task.title, name, branch })
    } catch (error) {
      return response.status(500).json({ error: `Could not create the task worktree: ${error.message}` })
    }
    const linked = database.linkTaskWorktree(id, location.path)
    await refreshGitWorktreeRows(worktrees)
    response.status(201).json({
      task: linked,
      worktreePath: location.path,
      branch: location.branch
    })
  })

  app.delete('/api/tasks/:id/worktree', async (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    const task = database.getTask(id)
    if (!task) {
      return response.status(404).json({ error: 'Task not found.' })
    }
    if (!task.worktree_path) {
      return response.status(404).json({ error: 'This task has no worktree linked.' })
    }
    let worktrees
    try {
      worktrees = getTaskWorktrees()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for task worktrees.' })
    }
    const force = ['1', 'true', 'yes'].includes(String(request.query.force ?? '').toLowerCase())
    const path = task.worktree_path

    if (existsSync(path)) {
      try {
        await worktrees.remove({ path, force })
      } catch (error) {
        return response.status(409).json({
          error: force
            ? `Could not remove the task worktree: ${error.message}`
            : 'The worktree has uncommitted changes; pass ?force=1 to remove it anyway.',
          worktreePath: path
        })
      }
    } else {
      try {
        await worktrees.prune()
      } catch {
        // Pruning is best-effort.
      }
    }
    database.deleteGitWorktree(path)
    const unlinked = database.unlinkTaskWorktree(id)
    response.json({ task: unlinked, removedPath: path })
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
    response.json(database.listAiSessions())
  })

  app.get('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    const session = database.getAiSession(id)
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
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
    const session = database.compactAiSession(id, summary)
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  app.delete('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!database.deleteAiSession(id)) return response.status(404).json({ error: 'AI session not found.' })
    return response.status(204).end()
  })

  app.get('/api/prompt-templates', (_request, response) => {
    response.json(database.listPromptTemplates())
  })

  app.get('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    const template = database.getPromptTemplate(id)
    if (!template) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.json(template)
  })

  app.post('/api/prompt-templates', (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''
    if (!name) return response.status(400).json({ error: 'Name is required.' })
    const template = database.createPromptTemplate({
      name: name.slice(0, 120),
      description: typeof request.body.description === 'string' ? request.body.description.slice(0, 500) : '',
      systemPrompt: typeof request.body.system_prompt === 'string' ? request.body.system_prompt : (typeof request.body.systemPrompt === 'string' ? request.body.systemPrompt : ''),
      userTemplate: typeof request.body.user_template === 'string' ? request.body.user_template : (typeof request.body.userTemplate === 'string' ? request.body.userTemplate : '')
    })
    return response.status(201).json(template)
  })

  app.patch('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const changes = {}
    if (typeof request.body.name === 'string') changes.name = request.body.name.trim().slice(0, 120)
    if (typeof request.body.description === 'string') changes.description = request.body.description.slice(0, 500)
    if (typeof request.body.system_prompt === 'string') changes.systemPrompt = request.body.system_prompt
    if (typeof request.body.systemPrompt === 'string') changes.systemPrompt = request.body.systemPrompt
    if (typeof request.body.user_template === 'string') changes.userTemplate = request.body.user_template
    if (typeof request.body.userTemplate === 'string') changes.userTemplate = request.body.userTemplate
    const template = database.updatePromptTemplate(id, changes)
    if (!template) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.json(template)
  })

  app.delete('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    if (!database.deletePromptTemplate(id)) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.status(204).end()
  })

  app.post('/api/ai/complete', async (request, response) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {}
    const validationError = validateCompleteInput(body)
    if (validationError) return response.status(400).json({ error: validationError })

    if (taskNotFound(body)) return response.status(404).json({ error: 'Task not found.' })
    // A task-linked run executes inside the task's worktree when one is live,
    // so AI-generated changes stay out of the main checkout.
    let worktreePath
    if (body.task_id !== undefined) {
      const linkedTask = database.getTask(body.task_id)
      if (linkedTask?.worktree_path && existsSync(linkedTask.worktree_path)) {
        worktreePath = linkedTask.worktree_path
      }
    }
    const session = body.session_id !== undefined ? database.getAiSession(body.session_id) : null
    if (body.session_id !== undefined && !session) {
      return response.status(404).json({ error: 'AI session not found.' })
    }
    const template = body.prompt_template_id !== undefined
      ? database.getPromptTemplate(body.prompt_template_id)
      : null
    if (body.prompt_template_id !== undefined && !template) {
      return response.status(404).json({ error: 'Prompt template not found.' })
    }

    const { messages, newMessages } = buildCompleteMessages(body, template, session)

    const selected = await selectDraftModel({ model: body.model })
    if (selected.error) {
      return response.status(selected.error.status).json(selected.error.body)
    }
    const { model, selection } = selected
    const maxTokens = body.max_tokens ?? AI_COMPLETE_DEFAULT_MAX_TOKENS
    const jobTitle = typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, 80)
      : 'AI chat'

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
            messages,
            maxTokens,
            task: { title: jobTitle, project: 'workspace', task_type: 'chore' },
            ...(worktreePath ? { worktreePath } : {}),
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
        if (session) {
          for (const message of newMessages) {
            if (message.role === 'user' || message.role === 'assistant') {
              database.addAiMessage(session.id, message)
            }
          }
          database.addAiMessage(session.id, { role: 'assistant', content })
        }
        return { content }
      } finally {
        selection.release({ inferenceStarted })
      }
    }

    let job
    try {
      job = jobStore.submit({
        model: model.id,
        backend: model.backend,
        title: jobTitle,
        taskId: body.task_id,
        runner
      })
    } catch (error) {
      selection.release({ inferenceStarted: false })
      throw error
    }

    const finished = await jobStore.wait(job.id)
    if (finished.state === 'done') {
      return response.json({
        content: finished.result.content,
        model: model.id,
        backend: model.backend,
        jobId: job.id,
        ...(session ? { sessionId: session.id } : {})
      })
    }
    if (finished.state === 'cancelled') {
      return response.status(499).json({ error: finished.error || 'The AI request was cancelled.' })
    }
    return response.status(finished.status ?? 503).json({
      error: finished.error || 'The model is unavailable.',
      ...(finished.retryAfter !== undefined ? { retryAfter: finished.retryAfter } : {})
    })
  })

  app.post('/api/ai/improve', async (request, response) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {}
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined
    const createTasks = body.create_tasks === true

    const summary = {
      tasks: database.listTasks().length,
      userFiles: database.listUserFiles().length,
      folders: database.listFolders().length,
      gitWorktrees: database.listGitWorktrees().length,
      tools: database.listTools().length,
      environments: database.listEnvironments().length
    }

    const messages = [
      {
        role: 'system',
        content: 'You are a workspace improvement assistant. Return only JSON: an array of objects with title, description, priority, and rationale. Keep proposals small, safe, and actionable.'
      },
      {
        role: 'user',
        content: `Workspace tracking summary: ${JSON.stringify(summary)}. Suggest up to 5 improvements.`
      }
    ]

    const selected = await scheduler.select(requestedModel)
    if (selected.error) {
      return response.status(selected.error.status).json(selected.error.body)
    }

    let content
    try {
      content = await modelClient.complete(selected.model, {
        messages,
        maxTokens: 500,
        task: { title: 'Improve workspace', project: 'workspace', task_type: 'chore' }
      })
    } catch (error) {
      return response.status(error.status ?? 502).json({ error: error.message || 'AI improvement failed.' })
    } finally {
      selected.selection.release({ inferenceStarted: Boolean(content) })
    }

    let suggestions = []
    try {
      const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\\s*|\\s*```$/g, ''))
      if (Array.isArray(parsed)) suggestions = parsed
    } catch {
      suggestions = [{ title: 'Review AI improvement output', description: content, priority: 'medium', rationale: 'Model output was not JSON.' }]
    }

    const created = []
    if (createTasks) {
      for (const suggestion of suggestions) {
        if (typeof suggestion?.title !== 'string' || !suggestion.title.trim()) continue
        created.push(database.createTask({
          title: suggestion.title.trim().slice(0, 200),
          description: typeof suggestion.description === 'string' ? suggestion.description.slice(0, 2000) : '',
          priority: ['low', 'medium', 'high', 'urgent'].includes(suggestion.priority) ? suggestion.priority : 'medium',
          task_type: 'chore',
          project: 'workspace'
        }))
      }
    }

    response.json({ suggestions, created, summary })
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

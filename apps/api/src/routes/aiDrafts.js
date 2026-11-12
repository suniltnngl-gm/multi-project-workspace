// Objective: Own the AI drafting routes: refine-task, background jobs, complete, and improve, with their shared model selection and runner logic.
// Requirements: One attempt per selected model with budget, cooldown, and provenance recorded; drafts parse into task shape; complete and improve run as jobs like any other model call; improve suggestions persist as proposals that never become tasks without approval.
// Decisions: Draft validation, prompt building, and runner helpers stay in one group because refine-task, jobs, complete, and improve share them; the shared env module is imported before the module-level AI limits are read; the improve route hands parsed suggestions to the proposals store so the board, not the model, decides what becomes a task.
// Relevant Files: apps/api/src/routes/aiDrafts.js, apps/api/src/routes/util.js, apps/api/src/taskJobStore.js, apps/api/src/localAiPrompt.js
// Important Context: User file. Route group for /api/local-ai/* and /api/ai/*.
// Work State: Completed: Extracted from app.js as task #45; env loading uses the shared env module as task #63; Active: None; Blocked: None; Next Move: Maintain as needed.
import '../env.js'
import { Router } from 'express'
import { existsSync } from 'node:fs'
import { buildTaskPrompt } from '../localAiPrompt.js'
import {
  isValidText,
  MAX_TITLE_LENGTH,
  MAX_PROJECT_LENGTH,
  TASK_TEXT_LIMITS,
  TASK_TEXT_LABELS,
  TASK_TYPES
} from './util.js'

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

function quotaLimitLabel(budget) {
  const limiter = budget?.budget
  if (!limiter || !limiter.unit || !limiter.window) return 'configured quota'
  const learned = limiter.unit === 'requests' && limiter.window === 'day' &&
    limiter.observed?.cap !== undefined &&
    limiter.limit === limiter.observed.cap &&
    limiter.used === limiter.observed.requests
  if (learned) return 'learned daily request limit'
  if (limiter.unit === 'requests' && limiter.window === 'day') {
    return 'daily request limit'
  }
  const unit = limiter.unit === 'compute_seconds' ? 'compute' : limiter.unit
  return `${limiter.window} ${unit} limit`
}

function quotaErrorMessage(model, budget) {
  const limiter = budget?.budget
  const hasLimit = Boolean(limiter?.unit && limiter?.window)
  // A cooldown-only snapshot has no configured limiter. Reporting
  // "undefined undefined limit" on a live 429 is worse than naming the wait.
  if (!hasLimit && budget?.retryAfter !== undefined) {
    return `${model.label} is cooling down after a provider rate limit; retry in ${budget.retryAfter} seconds.`
  }
  const usage = limiter &&
    Number.isFinite(limiter.used) &&
    Number.isFinite(limiter.limit)
    ? ` (${limiter.used}/${limiter.limit})`
    : ''
  return `${model.label} reached its ${quotaLimitLabel(budget)}${usage}.`
}

function applyCooldown(modelBudget, model, error) {
  if (error?.status !== 429 || error.retryAfter === undefined) return
  const scope = model.cli?.model
  if (typeof modelBudget.observe429 === 'function') {
    modelBudget.observe429(model.id, { retryAfter: error.retryAfter, scope })
    return
  }
  modelBudget.cooldown?.(model.id, error.retryAfter, scope)
}

// Prefer a reservation when the ledger supports it so two concurrent jobs
// cannot both consume the last provider slot. Older injected budgets keep the
// check/record path and still work.
function gateModelBudget(modelBudget, model) {
  const scope = model.cli?.model
  if (typeof modelBudget.reserve === 'function') {
    return { ...modelBudget.reserve(model.id, { scope, calls: 1 }), scope }
  }
  return { ...modelBudget.check(model.id, scope), scope }
}

function budgetUsageSink(gate) {
  return (usage) => {
    gate.usage = usage
  }
}

function settleModelBudget(modelBudget, model, gate) {
  if (!gate) return
  if (gate.reservationId && typeof modelBudget.settle === 'function') {
    modelBudget.settle(gate.reservationId, { usage: gate.usage })
    return
  }
  modelBudget.record?.(model.id, 1, gate.scope)
  if (gate.usage) modelBudget.recordUsage?.(model.id, gate.usage)
}

function releaseModelBudget(modelBudget, gate) {
  if (gate?.reservationId && typeof modelBudget.release === 'function') {
    modelBudget.release(gate.reservationId)
  }
}

export function createAiDraftsRouter({
  database,
  jobStore,
  scheduler,
  modelClient,
  modelMetrics,
  modelBudget
}) {
  const router = Router()

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
    const gate = gateModelBudget(modelBudget, model)
    if (!gate.ok) {
      releaseModelBudget(modelBudget, gate)
      selection.release({ inferenceStarted: false })
      return {
        error: {
          status: 429,
          body: {
            error: quotaErrorMessage(model, gate),
            ...gate
          }
        }
      }
    }
    return { selection, model, gate }
  }

  function submitDraftJob(input, model, selection, gate) {
    const task = taskFromRefineInput(input)
    const sessionSummary = input.session_id !== undefined
      ? String(database.getAiSession(input.session_id)?.summary ?? '')
      : ''
    const prompt = buildTaskPrompt(task, { sessionSummary })

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
            onUsage: budgetUsageSink(gate)
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
        settleModelBudget(modelBudget, model, gate)
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
      releaseModelBudget(modelBudget, selected.gate)
      selected.selection.release({ inferenceStarted: false })
      return { error: { status: 404, body: { error: 'Task not found.' } } }
    }
    if (sessionNotFound(input)) {
      releaseModelBudget(modelBudget, selected.gate)
      selected.selection.release({ inferenceStarted: false })
      return { error: { status: 404, body: { error: 'AI session not found.' } } }
    }
    try {
      return {
        job: submitDraftJob(input, selected.model, selected.selection, selected.gate)
      }
    } catch (error) {
      releaseModelBudget(modelBudget, selected.gate)
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

  router.post('/api/local-ai/refine-task', async (request, response) => {
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
    if (job.state === 'done') {
      // The job id travels with the draft so clients can hand it back as
      // source_job_id and record the drafting provenance on the created task.
      return response.json({ ...job.result, jobId: started.job.id })
    }
    if (job.state === 'cancelled') {
      return response.status(499).json({ error: job.error || 'The draft was cancelled.' })
    }
    return response.status(job.status ?? 503).json({
      error: job.error || 'The local model is unavailable.',
      ...(job.retryAfter !== undefined ? { retryAfter: job.retryAfter } : {})
    })
  })

  router.get('/api/local-ai/jobs', (_request, response) => {
    response.json(jobStore.list())
  })

  router.get('/api/local-ai/jobs/:id', (request, response) => {
    const job = jobStore.get(request.params.id)
    if (!job) {
      return response.status(404).json({ error: `Unknown job: ${request.params.id}.` })
    }
    return response.json(job)
  })

  router.delete('/api/local-ai/jobs/:id', (request, response) => {
    const result = jobStore.cancel(request.params.id)
    if (!result) {
      return response.status(404).json({ error: `Unknown job: ${request.params.id}.` })
    }
    return response.status(result.cancelled ? 202 : 409).json(result.job)
  })

  router.post('/api/local-ai/jobs', async (request, response) => {
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

  router.post('/api/ai/complete', async (request, response) => {
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
    const { model, selection, gate } = selected
    const maxTokens = body.max_tokens ?? AI_COMPLETE_DEFAULT_MAX_TOKENS
    const jobTitle = typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, 80)
      : 'AI chat'

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
            onUsage: budgetUsageSink(gate)
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
        settleModelBudget(modelBudget, model, gate)
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
      releaseModelBudget(modelBudget, gate)
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

  router.post('/api/ai/improve', async (request, response) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {}
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined

    const summary = {
      tasks: database.listTasks().length,
      userFiles: database.listUserFiles().length,
      folders: database.listFolders().length,
      gitWorktrees: database.listGitWorktrees().length,
      tools: database.listTools().length,
      environments: database.listEnvironments().length
    }

    // Undecided titles are do-not-repeat hints: the proposal store skips them
    // anyway, but telling the model saves the output tokens duplicates would
    // waste. Cap the list so the hint cannot bloat the prompt.
    const pendingTitles = database.listTaskProposals({ status: 'proposed' })
      .map((proposal) => proposal.title.trim())
      .filter(Boolean)
      .slice(0, 20)

    const messages = [
      {
        role: 'system',
        content: 'You are a workspace improvement assistant. Return only JSON: an array of at most 3 objects, each with title (up to 200 characters), description (up to 2000 characters), priority ("low", "medium", or "high"), and rationale (up to 2000 characters). Keep proposals small, safe, and actionable.'
      },
      {
        role: 'user',
        content: `Workspace tracking summary: ${JSON.stringify(summary)}. Suggest up to 3 improvements${pendingTitles.length > 0 ? `; do not repeat these pending titles: ${JSON.stringify(pendingTitles)}` : ''}.`
      }
    ]

    const selected = await selectDraftModel({ model: requestedModel })
    if (selected.error) {
      return response.status(selected.error.status).json(selected.error.body)
    }
    const { model, selection, gate } = selected

    // The improvement run is a job like any other model call, so it records
    // model provenance, honors budget and cooldown, and can be inspected or
    // cancelled through the job endpoints.
    const runner = async ({ signal, onPhase }) => {
      let inferenceStarted = false
      let startedAt
      try {
        inferenceStarted = true
        startedAt = Date.now()
        modelMetrics.recordStart(model.id)
        try {
          const content = await modelClient.complete(model, {
            messages,
            maxTokens: 400,
            task: { title: 'Improve workspace', project: 'workspace', task_type: 'chore' },
            signal,
            onPhase,
            onUsage: budgetUsageSink(gate)
          })
          modelMetrics.recordSuccess(model.id, { durationMs: Date.now() - startedAt })
          return content
        } catch (error) {
          applyCooldown(modelBudget, model, error)
          modelMetrics.recordError(model.id, error, {
            durationMs: startedAt === undefined ? undefined : Date.now() - startedAt
          })
          throw error
        }
      } finally {
        settleModelBudget(modelBudget, model, gate)
        selection.release({ inferenceStarted })
      }
    }

    let job
    try {
      job = jobStore.submit({
        model: model.id,
        backend: model.backend,
        title: 'Improve workspace',
        runner
      })
    } catch (error) {
      releaseModelBudget(modelBudget, gate)
      selection.release({ inferenceStarted: false })
      throw error
    }

    const finished = await jobStore.wait(job.id)
    if (finished.state === 'cancelled') {
      return response.status(499).json({ error: finished.error || 'The improvement run was cancelled.' })
    }
    if (finished.state !== 'done') {
      return response.status(finished.status ?? 503).json({
        error: finished.error || 'The model is unavailable.',
        ...(finished.retryAfter !== undefined ? { retryAfter: finished.retryAfter } : {})
      })
    }
    const content = finished.result

    let suggestions = []
    try {
      const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      if (Array.isArray(parsed)) suggestions = parsed
    } catch {
      suggestions = [{ title: 'Review AI improvement output', description: content, priority: 'medium', rationale: 'Model output was not JSON.' }]
    }

    // Suggestions persist as proposals, never tasks: the improve run is a
    // dry-run by design, and a human approves, rejects, or rolls back through
    // the proposal endpoints. Titles with an undecided proposal are skipped so
    // re-runs do not duplicate pending work.
    const { created, skipped } = database.createTaskProposals({
      proposals: suggestions,
      jobId: job.id
    })

    response.json({ proposals: created, skipped, summary, jobId: job.id })
  })

  return router
}

// Objective: Own the AI drafting routes: refine-task, background jobs, complete, and improve, orchestrated over the multi-agent control plane with shared model selection and budget helpers.
// Requirements: Execute refine-task, local-ai jobs, complete, and improve as tracked agentBus runs (parent + workers + optional reviewer) with pre-run register backfill, context hydration, and session compaction; preserve backward-compatible response envelopes and originAgentRunId proposal attribution; keep budget, cooldown, and billing circuit breakers accurate.
// Decisions: Draft validation, prompt building, and runThroughAgentBus orchestration stay in one group so all AI draft routes share register hydration, preReserved budget handoff, and multi-agent slicing/review options; improve suggestions still persist as proposals that require approval before becoming tasks.
// Relevant Files: apps/api/src/routes/aiDrafts.js, apps/api/src/routes/util.js, apps/api/src/taskJobStore.js, apps/api/src/localAiPrompt.js, apps/api/src/agentBus.js, apps/api/src/swarmRunner.js
// Important Context: User file. Multi-agent route group for /api/local-ai/* and /api/ai/*.
// Work State: Completed: Extracted from app.js (#45), shared env loading (#63), pre-run register backfill, and multi-agent agentBus execution across all four routes; Active: None; Blocked: None; Next Move: Maintain as needed.
import '../env.js'
import { Router } from 'express'
import { existsSync } from 'node:fs'
import {
  backfillTaskRegisters,
  buildTaskPrompt,
  formatAgentContextBlock,
  resolveFileAndFolderRegisters,
  resolveTaskSessionContext
} from '../localAiPrompt.js'
import {
  describeFallback,
  fallbackAllowed,
  fallbackCandidates,
  isFallbackEligible
} from '../modelFallback.js'
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
const MAX_ARTIFACT_THRESHOLD = 500
const COMPLETE_MESSAGE_ROLES = new Set(['system', 'user', 'assistant'])
const MULTI_AGENT_FIELDS = [
  'workers', 'worker_count', 'models', 'include_reviewer', 'backfill_registers'
]
const COMPLETE_INPUT_FIELDS = new Set([
  'prompt', 'system', 'messages', 'model', 'prompt_template_id', 'variables',
  'session_id', 'task_id', 'max_tokens', 'include_context', ...MULTI_AGENT_FIELDS
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

function validateMultiAgentOptions(input) {
  for (const field of ['workers', 'worker_count']) {
    if (input[field] !== undefined) {
      if (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 6) {
        return `${field} must be an integer between 1 and 6.`
      }
    }
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length === 0 || input.models.length > 6) {
      return 'models must be a non-empty array of at most 6 model IDs.'
    }
    for (const entry of input.models) {
      if (!isValidText(entry, 80) || !entry.trim()) {
        return 'Each entry in models must be a non-empty model ID of at most 80 characters.'
      }
    }
  }
  for (const flag of ['include_reviewer', 'backfill_registers', 'include_context']) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') {
      return `${flag} must be a boolean.`
    }
  }
  return undefined
}

function validateRefineInput(input, { requireModel = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Request body must be a JSON object.'
  }
  const draftFields = [
    'title', ...Object.keys(TASK_TEXT_LIMITS), 'project', 'task_type', 'model', 'task_id', 'session_id',
    ...MULTI_AGENT_FIELDS
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
  const multiAgentError = validateMultiAgentOptions(input)
  if (multiAgentError) return multiAgentError
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
  return validateMultiAgentOptions(body)
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
  if (gate.usage) modelBudget.recordUsage?.(model.id, gate.usage, gate.scope)
}

function releaseModelBudget(modelBudget, gate) {
  if (gate?.reservationId && typeof modelBudget.release === 'function') {
    modelBudget.release(gate.reservationId)
  }
}

function compactBusText(text, maxChars = 400) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, Math.max(0, maxChars - 3))}...`
}

function tryParseStructuredJson(content) {
  const clean = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  if (!clean) return null
  try {
    return JSON.parse(clean)
  } catch {
    return null
  }
}

const VALID_REGISTER_FIELDS = new Set([
  'objectives', 'requirements', 'decisions', 'relevant_files',
  'important_context', 'work_active', 'next_move'
])

function extractRegistersFromJson(parsed) {
  const raw = parsed?.registers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const fields = {}
  for (const [key, value] of Object.entries(raw)) {
    if (VALID_REGISTER_FIELDS.has(key) && typeof value === 'string' && value.trim()) {
      fields[key] = value.trim().slice(0, 1800)
    }
  }
  return fields
}

function pickSecondaryModel(preferredModels, index, fallbackModel, registryModels = []) {
  const explicit = Array.isArray(preferredModels) ? preferredModels[index] : undefined
  if (typeof explicit === 'string' && explicit.trim()) {
    const found = registryModels.find((entry) => entry.id === explicit.trim())
    return found ?? { id: explicit.trim(), backend: '' }
  }
  const callable = registryModels.filter((entry) => entry.callable !== false && entry.id !== fallbackModel.id)
  if (callable.length > 0) {
    return callable[(index - 1) % callable.length]
  }
  return fallbackModel
}

export function createAiDraftsRouter({
  database,
  jobStore,
  scheduler,
  modelClient,
  modelMetrics,
  modelBudget,
  fallbackChain = [],
  fallbackAllowSessions = false,
  agentBus = null,
  swarmRunner = null,
  models = []
}) {
  const router = Router()
  const jobAgentRuns = new Map()

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

  async function selectFallbackModel(id) {
    try {
      const selection = await scheduler.select(id)
      if (selection.error) return null
      const gate = gateModelBudget(modelBudget, selection.model)
      if (!gate.ok) {
        releaseModelBudget(modelBudget, gate)
        selection.release({ inferenceStarted: false })
        return null
      }
      return { model: selection.model, selection, gate }
    } catch (error) {
      console.error(`Fallback model selection failed for ${id}:`, error)
      return null
    }
  }

  async function runAttempt({ model, selection, gate, buildRequest, signal, onPhase }) {
    let startedAt
    try {
      startedAt = Date.now()
      modelMetrics.recordStart(model.id)
      const content = await modelClient.complete(model, {
        ...buildRequest(),
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
    } finally {
      settleModelBudget(modelBudget, model, gate)
      selection.release({ inferenceStarted: true })
    }
  }

  /**
   * Run the selected model, then walk the opt-in fallback chain only for
   * capacity, rate-limit, timeout, or GPU-hardware failures. Each attempt gets
   * its own scheduler selection and budget reservation; the job is retargeted
   * so its provenance names the model that actually answered.
   */
  async function runWithFallback({
    primary,
    sessionBound,
    buildRequest,
    signal,
    onPhase,
    retarget
  }) {
    const candidates = fallbackAllowed({
      chain: fallbackChain,
      sessionBound,
      allowSessions: fallbackAllowSessions
    })
      ? fallbackCandidates(fallbackChain, primary.model.id)
      : []

    let attempt = primary
    let fallbackFrom
    let fallbackReason
    let index = 0
    const attempted = new Set([primary.model.id])

    while (true) {
      try {
        const content = await runAttempt({
          ...attempt,
          buildRequest,
          signal,
          onPhase
        })
        return {
          content,
          model: attempt.model,
          fallbackFrom,
          fallbackReason,
          usage: attempt.gate?.usage
        }
      } catch (error) {
        if (candidates.length === 0 || !isFallbackEligible(error)) {
          if (fallbackFrom) {
            error.fallbackFrom = fallbackFrom
            error.fallbackReason = fallbackReason
          }
          throw error
        }

        fallbackFrom = fallbackFrom ?? attempt.model.id
        fallbackReason = describeFallback(error)
        let next = null
        while (index < candidates.length) {
          const id = candidates[index++]
          if (attempted.has(id)) continue
          attempted.add(id)
          next = await selectFallbackModel(id)
          if (next) break
        }
        if (!next) {
          error.fallbackFrom = fallbackFrom
          error.fallbackReason = fallbackReason
          throw error
        }
        retarget?.({
          model: next.model.id,
          backend: next.model.backend,
          fallbackFrom,
          fallbackReason
        })
        attempt = next
      }
    }
  }

  function rememberJobAgentRun(jobId, agentRunId) {
    if (!jobId || !agentRunId) return
    jobAgentRuns.set(jobId, agentRunId)
    if (jobAgentRuns.size > 500) {
      const oldest = jobAgentRuns.keys().next().value
      if (oldest !== undefined) jobAgentRuns.delete(oldest)
    }
  }

  function recordRunUsageFromGate(runId, agentId, modelId, usage, calls = 1) {
    if (!agentBus) return
    agentBus.recordUsage({
      runId,
      agentId,
      usage: {
        calls,
        model: modelId,
        promptTokens: Number(usage?.promptTokens ?? 0),
        completionTokens: Number(usage?.completionTokens ?? 0),
        totalTokens: Number(usage?.totalTokens ?? 0)
      }
    })
  }

  function persistTaskRegisterFields(runId, parentAgentId, taskId, fields) {
    if (!taskId || typeof database.applyTaskOps !== 'function' || typeof database.getTask !== 'function') {
      return
    }
    const entries = Object.entries(fields ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())
    if (entries.length === 0) return
    const task = database.getTask(taskId)
    if (!task) return
    database.applyTaskOps({
      agent: { id: parentAgentId },
      ops: [{
        op_id: `backfill-${runId}`,
        op: 'update_task',
        task_id: task.id,
        expected_updated_at: task.updated_at,
        fields: Object.fromEntries(entries)
      }]
    })
  }

  /**
   * Execute an AI operation over the SQLite star-topology agentBus so every
   * call has explicit run provenance, parent -> worker assignments, worker -> parent
   * results (or artifacts), optional multi-worker perspectives, and optional
   * reviewer verification.
   */
  async function runThroughAgentBus({
    taskId = null,
    title = 'AI task',
    goal = '',
    primary,
    sessionBound = false,
    buildRequest,
    multiAgentInput = {},
    signal,
    onPhase,
    retarget,
    onRunCreated
  }) {
    if (!agentBus) {
      const direct = await runWithFallback({
        primary,
        sessionBound,
        buildRequest: () => buildRequest({ workerIndex: 0, workerCount: 1 }),
        signal,
        onPhase,
        retarget
      })
      return { ...direct, agentRunId: null, extraOutputs: [], reviewerResult: null }
    }

    const requestedWorkers = multiAgentInput.workers ?? multiAgentInput.worker_count ?? 1
    const workerCount = Math.min(6, Math.max(1, Number(requestedWorkers) || 1))
    const includeReviewer = multiAgentInput.include_reviewer === true
    const backfillEnabled = multiAgentInput.backfill_registers !== false
    const registryModels = Array.isArray(models) && models.length > 0 ? models : []

    const agentsSpec = [
      {
        role: 'parent',
        name: 'parent',
        model: primary.model.id,
        ...(primary.model.backend ? { backend: primary.model.backend } : {})
      },
      {
        role: 'worker',
        name: 'worker-1',
        model: primary.model.id,
        ...(primary.model.backend ? { backend: primary.model.backend } : {})
      }
    ]
    for (let index = 1; index < workerCount; index += 1) {
      const candidate = pickSecondaryModel(multiAgentInput.models, index, primary.model, registryModels)
      agentsSpec.push({
        role: 'worker',
        name: `worker-${index + 1}`,
        model: candidate.id,
        ...(candidate.backend ? { backend: candidate.backend } : {})
      })
    }
    if (includeReviewer) {
      const reviewerModel = pickSecondaryModel(
        multiAgentInput.models,
        workerCount,
        primary.model,
        registryModels
      )
      agentsSpec.push({
        role: 'reviewer',
        name: 'reviewer',
        model: reviewerModel.id,
        ...(reviewerModel.backend ? { backend: reviewerModel.backend } : {})
      })
    }

    const created = agentBus.createRun({
      ...(taskId !== undefined && taskId !== null ? { task_id: taskId } : {}),
      model_plan: { workerCount, includeReviewer, primaryModel: primary.model.id },
      plan: {
        title: compactBusText(title, 120),
        workerCount,
        includeReviewer,
        hasSwarmRunner: Boolean(swarmRunner)
      },
      agents: agentsSpec
    })
    if (created.error) {
      const direct = await runWithFallback({
        primary,
        sessionBound,
        buildRequest: () => buildRequest({ workerIndex: 0, workerCount: 1 }),
        signal,
        onPhase,
        retarget
      })
      return { ...direct, agentRunId: null, extraOutputs: [], reviewerResult: null }
    }

    const runId = created.id
    onRunCreated?.(runId)
    const parentAgent = created.agents.find((entry) => entry.role === 'parent')
    const workers = created.agents.filter((entry) => entry.role === 'worker')
    const reviewerAgent = created.agents.find((entry) => entry.role === 'reviewer') ?? null

    agentBus.startRun(runId)
    agentBus.transitionRun(runId, 'dispatching')
    agentBus.transitionRun(runId, 'running')

    const assignGoal = compactBusText(goal || title, 600)
    const extraOutputs = []
    let primaryResult = null
    let reviewerResult = null

    try {
      const w1 = workers[0]
      const assigned1 = agentBus.sendMessage({
        agentId: parentAgent.id,
        runId,
        to: w1.name,
        kind: 'assign',
        preReserved: true,
        payload: { sliceIndex: 1, title: compactBusText(title, 120), goal: assignGoal },
        idempotencyKey: `assign-${w1.name}-1`,
        correlationId: 'slice-1'
      })
      if (assigned1.error) {
        throw Object.assign(
          new Error(assigned1.error.body?.error || 'Failed to dispatch worker assignment.'),
          { status: assigned1.error.status || 429 }
        )
      }

      const claimed1 = agentBus.claimInbox({ agentId: w1.id, runId, limit: 1 })
      const assignMsg1 = claimed1.messages?.[0]
      if (assignMsg1) agentBus.ackMessage({ agentId: w1.id, messageId: assignMsg1.id })

      primaryResult = await runWithFallback({
        primary,
        sessionBound,
        buildRequest: () => ({
          ...buildRequest({ workerIndex: 0, workerCount }),
          sessionKey: w1.promptCacheKey
        }),
        signal,
        onPhase,
        retarget: (info) => {
          retarget?.(info)
          agentBus.switchAgentModel({
            runId,
            agentId: w1.id,
            model: info.model,
            backend: info.backend ?? '',
            reason: info.fallbackReason ?? ''
          })
        }
      })

      recordRunUsageFromGate(runId, w1.id, primaryResult.model.id, primaryResult.usage, 1)
      const artifactRefs1 = []
      if (primaryResult.content.length > MAX_ARTIFACT_THRESHOLD && typeof database.saveAgentArtifact === 'function') {
        const artifact = database.saveAgentArtifact({
          kind: 'worker_output',
          path: 'slice-1',
          producer: w1.name,
          content: primaryResult.content
        })
        artifactRefs1.push(artifact.contentHash)
      }
      agentBus.sendMessage({
        agentId: w1.id,
        runId,
        to: 'parent',
        kind: 'result',
        payload: {
          sliceIndex: 1,
          summary: compactBusText(primaryResult.content, 400),
          status: 'done',
          ...(assignMsg1 ? { assignSeq: assignMsg1.seq } : {})
        },
        artifactRefs: artifactRefs1,
        idempotencyKey: `result-${w1.name}-1`,
        correlationId: 'slice-1'
      })
      if (assignMsg1) {
        agentBus.completeMessage({
          agentId: w1.id,
          messageId: assignMsg1.id,
          result: { summary: compactBusText(primaryResult.content, 400) }
        })
      }
      database.updateAgent(w1.id, { state: 'done' })

      for (let index = 1; index < workers.length; index += 1) {
        const worker = workers[index]
        const selectedExtra = await selectDraftModel({ model: worker.model })
        if (selectedExtra.error) continue

        const sent = agentBus.sendMessage({
          agentId: parentAgent.id,
          runId,
          to: worker.name,
          kind: 'assign',
          preReserved: true,
          payload: {
            sliceIndex: index + 1,
            title: `${compactBusText(title, 90)} (perspective ${index + 1})`,
            goal: assignGoal
          },
          idempotencyKey: `assign-${worker.name}-1`,
          correlationId: `slice-${index + 1}`
        })
        if (sent.error) {
          releaseModelBudget(modelBudget, selectedExtra.gate)
          selectedExtra.selection.release({ inferenceStarted: false })
          continue
        }

        const claimed = agentBus.claimInbox({ agentId: worker.id, runId, limit: 1 })
        const msg = claimed.messages?.[0]
        if (msg) agentBus.ackMessage({ agentId: worker.id, messageId: msg.id })

        try {
          const workerRes = await runWithFallback({
            primary: selectedExtra,
            sessionBound,
            buildRequest: () => ({
              ...buildRequest({
                workerIndex: index,
                workerCount,
                primaryContent: primaryResult.content,
                extraOutputs
              }),
              sessionKey: worker.promptCacheKey
            }),
            signal,
            onPhase
          })
          recordRunUsageFromGate(runId, worker.id, workerRes.model.id, workerRes.usage, 1)
          extraOutputs.push({
            worker: worker.name,
            model: workerRes.model.id,
            content: workerRes.content
          })
          agentBus.sendMessage({
            agentId: worker.id,
            runId,
            to: 'parent',
            kind: 'result',
            payload: {
              sliceIndex: index + 1,
              summary: compactBusText(workerRes.content, 400),
              status: 'done',
              ...(msg ? { assignSeq: msg.seq } : {})
            },
            idempotencyKey: `result-${worker.name}-1`,
            correlationId: `slice-${index + 1}`
          })
          if (msg) {
            agentBus.completeMessage({
              agentId: worker.id,
              messageId: msg.id,
              result: { summary: compactBusText(workerRes.content, 400) }
            })
          }
          database.updateAgent(worker.id, { state: 'done' })
        } catch (workerErr) {
          if (msg) {
            agentBus.failMessage({
              agentId: worker.id,
              messageId: msg.id,
              error: workerErr.message || 'Worker failed.',
              retryable: false
            })
          }
          agentBus.sendMessage({
            agentId: worker.id,
            runId,
            to: 'parent',
            kind: 'error',
            payload: { sliceIndex: index + 1, error: workerErr.message || 'Worker failed.' },
            idempotencyKey: `error-${worker.name}-1`,
            correlationId: `slice-${index + 1}`
          })
          database.updateAgent(worker.id, { state: 'failed' })
        }
      }

      if (reviewerAgent) {
        const selectedReviewer = await selectDraftModel({ model: reviewerAgent.model })
        if (!selectedReviewer.error) {
          agentBus.transitionRun(runId, 'reviewing')
          const combinedOutputs = [
            `worker-1: ${compactBusText(primaryResult.content, 500)}`,
            ...extraOutputs.map((entry) => `${entry.worker}: ${compactBusText(entry.content, 500)}`)
          ]
          agentBus.sendMessage({
            agentId: parentAgent.id,
            runId,
            to: reviewerAgent.name,
            kind: 'handoff',
            payload: {
              refs: ['#2'],
              slices: combinedOutputs,
              summary: `Review ${combinedOutputs.length} worker output(s).`
            },
            idempotencyKey: `handoff-review-${runId}`,
            correlationId: 'review'
          })
          const claimedReview = agentBus.claimInbox({ agentId: reviewerAgent.id, runId, limit: 1 })
          const reviewMsg = claimedReview.messages?.[0]
          if (reviewMsg) agentBus.ackMessage({ agentId: reviewerAgent.id, messageId: reviewMsg.id })

          try {
            const revCall = await runWithFallback({
              primary: selectedReviewer,
              sessionBound: false,
              buildRequest: () => ({
                messages: [
                  {
                    role: 'system',
                    content: 'You are the reviewer. Verify the worker outputs for accuracy and return JSON {"approved": boolean, "summary": string}.'
                  },
                  {
                    role: 'user',
                    content: combinedOutputs.join('\n')
                  }
                ],
                maxTokens: 300,
                sessionKey: reviewerAgent.promptCacheKey
              }),
              signal,
              onPhase
            })
            recordRunUsageFromGate(runId, reviewerAgent.id, revCall.model.id, revCall.usage, 1)
            const parsedVerdict = tryParseStructuredJson(revCall.content)
            const approved = parsedVerdict?.approved === false ? false : true
            const verdictSummary = typeof parsedVerdict?.summary === 'string' && parsedVerdict.summary.trim()
              ? compactBusText(parsedVerdict.summary, 400)
              : compactBusText(revCall.content, 400)
            reviewerResult = { approved, summary: verdictSummary, content: revCall.content, parsed: parsedVerdict }
            agentBus.sendMessage({
              agentId: reviewerAgent.id,
              runId,
              to: 'parent',
              kind: 'verdict',
              payload: {
                approved,
                summary: verdictSummary,
                ...(reviewMsg ? { handoffSeq: reviewMsg.seq } : {})
              },
              idempotencyKey: `verdict-${runId}`,
              correlationId: 'review'
            })
            if (reviewMsg) {
              agentBus.completeMessage({
                agentId: reviewerAgent.id,
                messageId: reviewMsg.id,
                result: { approved, summary: verdictSummary }
              })
            }
            database.updateAgent(reviewerAgent.id, { state: 'done' })
          } catch (revErr) {
            if (reviewMsg) {
              agentBus.failMessage({
                agentId: reviewerAgent.id,
                messageId: reviewMsg.id,
                error: revErr.message || 'Reviewer failed.',
                retryable: false
              })
            }
            database.updateAgent(reviewerAgent.id, { state: 'failed' })
          }
        }
      }

      const parentClaimed = agentBus.claimInbox({ agentId: parentAgent.id, runId, limit: 20 })
      for (const message of parentClaimed.messages ?? []) {
        agentBus.ackMessage({ agentId: parentAgent.id, messageId: message.id })
        agentBus.completeMessage({ agentId: parentAgent.id, messageId: message.id, result: { recorded: true } })
      }

      if (taskId && backfillEnabled) {
        const registerFields = {
          ...extractRegistersFromJson(tryParseStructuredJson(primaryResult.content)),
          ...(reviewerResult?.parsed ? extractRegistersFromJson(reviewerResult.parsed) : {})
        }
        persistTaskRegisterFields(runId, parentAgent.id, taskId, registerFields)
      }

      agentBus.checkpointRun({
        agentId: parentAgent.id,
        runId,
        checkpoint: {
          workerCount,
          completedOutputs: 1 + extraOutputs.length,
          ...(reviewerResult ? { reviewed: true, approved: reviewerResult.approved } : {})
        }
      })
      database.updateAgent(parentAgent.id, { state: 'done' })
      agentBus.transitionRun(runId, 'completed', {
        result: { summary: compactBusText(primaryResult.content, 400) }
      })

      return {
        ...primaryResult,
        agentRunId: runId,
        extraOutputs,
        reviewerResult
      }
    } catch (error) {
      const current = database.getAgentRun(runId)
      if (current && !['completed', 'failed', 'cancelled'].includes(current.state)) {
        for (const msg of database.listAgentMessages(runId)) {
          if (msg.toAgentId === workers[0].id && ['delivered', 'leased', 'acked'].includes(msg.state)) {
            agentBus.failMessage({
              agentId: workers[0].id,
              messageId: msg.id,
              error: error?.message || 'Agent call failed.',
              retryable: false
            })
          }
        }
        agentBus.sendMessage({
          agentId: workers[0].id,
          runId,
          to: 'parent',
          kind: 'error',
          payload: { sliceIndex: 1, error: error?.message || 'Agent call failed.' },
          idempotencyKey: `error-${workers[0].name}-1`,
          correlationId: 'slice-1'
        })
        agentBus.transitionRun(runId, 'failed', { error: error?.message || 'Agent call failed.' })
      }
      throw error
    }
  }

  function submitDraftJob(input, model, selection, gate) {
    const rawTask = taskFromRefineInput(input)
    const storedTask = input.task_id !== undefined ? database.getTask(input.task_id) : null
    const candidateTask = storedTask
      ? {
          ...storedTask,
          ...Object.fromEntries(
            Object.entries(rawTask).filter(([key, value]) => (
              key === 'title' ? Boolean(value) : value !== ''
            ))
          ),
          id: storedTask.id
        }
      : rawTask
    const { task, fileRegisters, folderRegisters } = backfillTaskRegisters(database, candidateTask, {
      persist: Boolean(input.task_id !== undefined && input.backfill_registers !== false)
    })
    const { sessionSummary } = resolveTaskSessionContext(database, {
      taskId: input.task_id,
      sessionId: input.session_id
    })
    const extraRegisterContext = formatAgentContextBlock({
      fileRegisters,
      folderRegisters,
      maxChars: 500
    })
    const combinedSummary = [sessionSummary, extraRegisterContext].filter(Boolean).join('\n')
    const prompt = buildTaskPrompt(task, { sessionSummary: combinedSummary })

    let jobRef = null
    const runner = async ({ signal, onPhase, retarget }) => {
      const result = await runThroughAgentBus({
        taskId: input.task_id ?? null,
        title: `Refine task: ${task.title}`,
        goal: task.title,
        primary: { model, selection, gate },
        sessionBound: input.session_id !== undefined,
        multiAgentInput: input,
        signal,
        onPhase,
        retarget,
        onRunCreated: (agentRunId) => rememberJobAgentRun(jobRef?.id, agentRunId),
        buildRequest: ({ workerIndex }) => {
          if (workerIndex === 0) {
            return {
              messages: prompt.messages,
              maxTokens: prompt.maxTokens,
              task
            }
          }
          return {
            messages: [
              prompt.messages[0],
              {
                role: 'user',
                content: `${prompt.messages[1].content}\nProvide an independent alternative refinement as worker-${workerIndex + 1}.`
              }
            ],
            maxTokens: prompt.maxTokens,
            task
          }
        }
      })
      rememberJobAgentRun(jobRef?.id, result.agentRunId)

      const reviewedDraft = result.reviewerResult?.parsed
      const candidateContent = (
        typeof reviewedDraft?.description === 'string' && reviewedDraft?.acceptance_criteria
          ? result.reviewerResult.content
          : result.content
      )

      try {
        return parseAssistantDraft(candidateContent)
      } catch (error) {
        console.error('Could not parse local AI response:', error)
        throw Object.assign(
          new Error('The local model returned an invalid task draft. Please retry.'),
          { status: 502 }
        )
      }
    }

    jobRef = jobStore.submit({
      model: model.id,
      backend: model.backend,
      title: task.title,
      taskId: input.task_id,
      runner
    })
    return jobRef
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
      const agentRunId = jobAgentRuns.get(started.job.id)
      // The job id travels with the draft so clients can hand it back as
      // source_job_id and record the drafting provenance on the created task.
      return response.json({
        ...job.result,
        jobId: started.job.id,
        ...(agentRunId ? { agentRunId } : {})
      })
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
    let linkedTask = null
    if (body.task_id !== undefined) {
      linkedTask = database.getTask(body.task_id)
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
    if (body.include_context === true || body.backfill_registers === true) {
      const backfilled = linkedTask
        ? backfillTaskRegisters(database, linkedTask, {
            persist: Boolean(body.backfill_registers === true)
          })
        : { task: null, fileRegisters: [], folderRegisters: [] }
      const { sessionSummary } = !session && linkedTask
        ? resolveTaskSessionContext(database, { taskId: linkedTask.id })
        : { sessionSummary: '' }
      const contextBlock = formatAgentContextBlock({
        task: backfilled.task,
        fileRegisters: backfilled.fileRegisters,
        folderRegisters: backfilled.folderRegisters,
        sessionSummary
      })
      if (contextBlock) {
        if (messages[0]?.role === 'system') {
          messages[0] = { role: 'system', content: `${messages[0].content}\n\nWorkspace context:\n${contextBlock}` }
        } else {
          messages.unshift({ role: 'system', content: `Workspace context:\n${contextBlock}` })
        }
      }
    }

    const selected = await selectDraftModel({ model: body.model })
    if (selected.error) {
      return response.status(selected.error.status).json(selected.error.body)
    }
    const { model, selection, gate } = selected
    const maxTokens = body.max_tokens ?? AI_COMPLETE_DEFAULT_MAX_TOKENS
    const jobTitle = typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, 80)
      : 'AI chat'

    const runner = async ({ signal, onPhase, retarget }) => {
      const result = await runThroughAgentBus({
        taskId: body.task_id ?? null,
        title: jobTitle,
        goal: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : jobTitle,
        primary: { model, selection, gate },
        sessionBound: Boolean(session),
        multiAgentInput: body,
        signal,
        onPhase,
        retarget,
        buildRequest: ({ workerIndex, workerCount }) => ({
          messages: workerIndex === 0
            ? messages
            : [
                ...messages,
                {
                  role: 'user',
                  content: `Provide worker ${workerIndex + 1}/${workerCount} verification or complementary details concisely.`
                }
              ],
          maxTokens,
          task: { title: jobTitle, project: 'workspace', task_type: 'chore' },
          ...(worktreePath ? { worktreePath } : {})
        })
      })
      const finalContent = typeof result.reviewerResult?.parsed?.content === 'string'
        ? result.reviewerResult.parsed.content
        : result.content
      if (session) {
        for (const message of newMessages) {
          if (message.role === 'user' || message.role === 'assistant') {
            database.addAiMessage(session.id, message)
          }
        }
        database.addAiMessage(session.id, { role: 'assistant', content: finalContent })
      }
      return {
        content: finalContent,
        model: result.model.id,
        backend: result.model.backend,
        ...(result.agentRunId ? { agentRunId: result.agentRunId } : {}),
        ...(result.fallbackFrom
          ? {
              fallbackFrom: result.fallbackFrom,
              fallbackReason: result.fallbackReason
            }
          : {})
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
      const result = finished.result ?? {}
      return response.json({
        content: result.content,
        model: result.model ?? finished.model ?? model.id,
        backend: result.backend ?? finished.backend ?? model.backend,
        jobId: job.id,
        ...(result.agentRunId ? { agentRunId: result.agentRunId } : {}),
        ...(result.fallbackFrom || finished.fallbackFrom
          ? {
              fallbackFrom: result.fallbackFrom ?? finished.fallbackFrom,
              fallbackReason: result.fallbackReason ?? finished.fallbackReason
            }
          : {}),
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
    const multiAgentError = validateMultiAgentOptions(body)
    if (multiAgentError) {
      return response.status(400).json({ error: multiAgentError })
    }
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

    // The improvement run executes on agentBus as a tracked multi-agent run
    // inside jobStore, recording both model job provenance and agentRunId.
    const runner = async ({ signal, onPhase, retarget }) => {
      const result = await runThroughAgentBus({
        title: 'Improve workspace',
        goal: `Suggest workspace improvements from tracking summary (${JSON.stringify(summary)}).`,
        primary: { model, selection, gate },
        sessionBound: false,
        multiAgentInput: body,
        signal,
        onPhase,
        retarget,
        buildRequest: ({ workerIndex, workerCount }) => ({
          messages: workerIndex === 0
            ? messages
            : [
                messages[0],
                {
                  role: 'user',
                  content: `${messages[1].content} (Worker ${workerIndex + 1}/${workerCount}: focus on non-overlapping reliability, testing, or documentation improvements.)`
                }
              ],
          maxTokens: 400,
          task: { title: 'Improve workspace', project: 'workspace', task_type: 'chore' }
        })
      })
      return {
        contents: [result.content, ...result.extraOutputs.map((entry) => entry.content)],
        agentRunId: result.agentRunId
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

    const outputPayload = finished.result && typeof finished.result === 'object'
      ? finished.result
      : { contents: [finished.result], agentRunId: null }
    const rawContents = Array.isArray(outputPayload.contents) ? outputPayload.contents : [outputPayload]
    const agentRunId = outputPayload.agentRunId || ''

    const suggestions = []
    for (const content of rawContents) {
      const parsed = tryParseStructuredJson(content)
      if (Array.isArray(parsed)) {
        suggestions.push(...parsed)
      } else if (parsed && Array.isArray(parsed.proposals)) {
        suggestions.push(...parsed.proposals)
      } else if (suggestions.length === 0) {
        suggestions.push({
          title: 'Review AI improvement output',
          description: String(content ?? ''),
          priority: 'medium',
          rationale: 'Model output was not JSON.'
        })
      }
    }

    // Suggestions persist as proposals, never tasks: the improve run is a
    // dry-run by design, and a human approves, rejects, or rolls back through
    // the proposal endpoints. Titles with an undecided proposal are skipped so
    // re-runs do not duplicate pending work.
    const { created, skipped } = database.createTaskProposals({
      proposals: suggestions,
      jobId: job.id,
      agentRunId
    })

    response.json({
      proposals: created,
      skipped,
      summary,
      jobId: job.id,
      ...(agentRunId ? { agentRunId } : {})
    })
  })

  return router
}

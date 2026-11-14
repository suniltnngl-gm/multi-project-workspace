// Objective: Coordinate a non-native, low-quota multi-agent swarm over the SQLite agent control plane with zero-token routing, parallel self-improvement, and optional AI parent/sibling hooks.
// Requirements: Keep deterministic coordination as the default (0 parent model calls); run parallel workspace sensor/portability/telemetry self-improvement on every swarm run by default; isolate worker sessions via promptCacheKey; pass delta #seq references; hydrate taskId, worktreePath, and file/folder/session registers; backfill blank task registers; deduplicate proposals and record agentTaskOps in finalizeSwarmRun; wrap execution in jobStore; support parentMode (deterministic/auto/ai), worker question answering, and maxReviewRounds retry rounds; handle HTTP 429 via observe429 and automatic model switching.
// Decisions: State lives in agent_runs/agent_messages/agent_run_usage so runs survive pauses and inspect identically over CLI and API; callAgentWithFallback shares budget reservation, cooldown observation, and fallback switching; buildParallelSelfImprovement combines scanWorkspaceSensors portability/gap detection with run telemetry without extra model tokens; finalizeSwarmRun applies task ops before transitioning to terminal state and compacts outcomes into ai_sessions.
// Relevant Files: apps/api/src/swarmRunner.js, apps/api/src/agentBus.js, apps/api/src/workspaceSensors.js, apps/api/src/providerQuota.js, apps/api/src/modelBudget.js, apps/api/src/modelClient.js, apps/api/src/localAiPrompt.js, apps/api/src/routes/agents.js, apps/api/src/routes/aiDrafts.js, scripts/ai-swarm.mjs
// Important Context: User file. Implements the permanent parallel swarm + self-improvement workflow strategy over SQLite.
// Work State: Completed: Non-native 2+2+2 swarm runner, parallel self-improvement lane, task/worktree/agentTaskOps/jobStore sync, AI parent/sibling hooks, context hydration & session compaction; Active: None; Blocked: None; Next Move: Maintain as needed.
import { isTerminalRunState } from './agentProtocol.js'
import {
  backfillTaskRegisters,
  formatAgentContextBlock,
  recordAgentSessionExchange,
  resolveFileAndFolderRegisters,
  resolveTaskSessionContext,
  splitFileRefs
} from './localAiPrompt.js'
import { isFallbackEligible } from './modelFallback.js'
import {
  billingRank,
  buildSwarmRoster,
  planAgentDispatch,
  quotaScopeForModel,
  resolveAgentModel
} from './providerQuota.js'
import { scanWorkspaceUserFiles } from './workspaceScan.js'
import { scanWorkspaceSensors } from './workspaceSensors.js'

const MAX_ARTIFACT_THRESHOLD = 500
const DEFAULT_SWARM_MAX_TOKENS = 600
const DEFAULT_COOLDOWN_SECONDS = 60

function compactText(text, maxChars = 400) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, Math.max(0, maxChars - 3))}...`
}

function tryParseJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const stripped = trimmed.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  try {
    return JSON.parse(stripped)
  } catch {
    return null
  }
}

const MAX_PROPOSALS_PER_TURN = 5
const VALID_PARENT_MODES = new Set(['deterministic', 'auto', 'ai'])
const REGISTER_KEYS = [
  'objectives',
  'requirements',
  'decisions',
  'relevant_files',
  'important_context',
  'work_active',
  'next_move'
]

function extractRegisters(parsed) {
  const source = parsed?.registers
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const result = {}
  for (const key of REGISTER_KEYS) {
    if (typeof source[key] === 'string' && source[key].trim()) {
      result[key] = compactText(source[key], 1800)
    }
  }
  return result
}

function extractProposals(parsed) {
  const raw = Array.isArray(parsed?.proposals) ? parsed.proposals : []
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const title = typeof entry.title === 'string' ? compactText(entry.title, 200) : ''
      if (!title) return null
      return {
        title,
        description: typeof entry.description === 'string' && entry.description.trim()
          ? compactText(entry.description, 1500)
          : title,
        priority: ['low', 'medium', 'high'].includes(entry.priority) ? entry.priority : 'medium',
        task_type: typeof entry.task_type === 'string' && entry.task_type.trim()
          ? entry.task_type.trim()
          : 'chore',
        ...(typeof entry.project === 'string' && entry.project.trim()
          ? { project: entry.project.trim() }
          : {}),
        rationale: typeof entry.rationale === 'string' ? compactText(entry.rationale, 1500) : ''
      }
    })
    .filter(Boolean)
    .slice(0, MAX_PROPOSALS_PER_TURN)
}

function parseWorkerResponse(content) {
  const parsed = tryParseJson(content)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rawQuestion = typeof parsed.question === 'string' && parsed.question.trim()
      ? compactText(parsed.question, 400)
      : (parsed.status === 'question' && typeof parsed.summary === 'string' && parsed.summary.trim()
        ? compactText(parsed.summary, 400)
        : null)
    if (typeof parsed.summary === 'string' || rawQuestion) {
      return {
        summary: compactText(parsed.summary || rawQuestion || content, 400),
        status: rawQuestion ? 'question' : (typeof parsed.status === 'string' ? parsed.status : 'done'),
        details: typeof parsed.details === 'string' ? parsed.details : String(content ?? ''),
        question: rawQuestion,
        proposals: extractProposals(parsed),
        registers: extractRegisters(parsed)
      }
    }
  }
  return {
    summary: compactText(content, 400),
    status: 'done',
    details: String(content ?? ''),
    question: null,
    proposals: [],
    registers: {}
  }
}

function parseReviewerResponse(content) {
  const parsed = tryParseJson(content)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const approved = parsed.approved === false || parsed.verdict === 'rejected'
      ? false
      : true
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
      ? compactText(parsed.summary, 400)
      : compactText(content, 400)
    return {
      approved,
      summary,
      details: parsed.details ?? null,
      proposals: extractProposals(parsed),
      registers: extractRegisters(parsed)
    }
  }
  const lowered = String(content ?? '').toLowerCase()
  const approved = !/\b(rejected|fail(?:ed)?|changes requested)\b/.test(lowered)
  return {
    approved,
    summary: compactText(content, 400),
    details: null,
    proposals: [],
    registers: {}
  }
}

export function normalizeSlices(objective = '', slices, workerCount) {
  if (Array.isArray(slices) && slices.length > 0) {
    return slices.map((entry, index) => {
      if (typeof entry === 'string') {
        const goal = entry.trim()
        return {
          index: index + 1,
          title: goal.slice(0, 80) || `Slice ${index + 1}`,
          goal: goal || `Slice ${index + 1}`,
          files: []
        }
      }
      const goal = String(entry?.goal || entry?.title || '').trim() || `Slice ${index + 1}`
      const title = String(entry?.title || goal).trim().slice(0, 80)
      const files = Array.isArray(entry?.files)
        ? entry.files.filter((file) => typeof file === 'string' && file.trim())
        : []
      return { index: index + 1, title, goal, files }
    })
  }

  const trimmedObjective = String(objective ?? '').trim()
  const parts = trimmedObjective
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length > 1) {
    return parts.map((part, index) => ({
      index: index + 1,
      title: part.slice(0, 80),
      goal: part,
      files: []
    }))
  }

  const count = Math.max(1, Math.min(6, Math.floor(Number(workerCount) || 2)))
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    title: `Slice ${index + 1}`,
    goal: trimmedObjective
      ? `Slice ${index + 1}/${count} of: ${trimmedObjective}`
      : `Slice ${index + 1}/${count}`,
    files: []
  }))
}

export function createSwarmRunner({
  database,
  bus,
  models = [],
  modelClient,
  modelBudget,
  scheduler = null,
  modelMetrics = null,
  jobStore = null,
  fallbackChain = [],
  now = Date.now
} = {}) {
  if (!database || !bus) {
    throw new Error('createSwarmRunner requires database and bus.')
  }

  function hydrateTaskOptions(options = {}) {
    if (options.taskId === undefined || options.taskId === null || options.taskId === '') {
      const explicitFiles = splitFileRefs(options.files ?? [])
      const resolved = explicitFiles.length > 0
        ? resolveFileAndFolderRegisters(database, explicitFiles)
        : { fileRegisters: [], folderRegisters: [], files: [] }
      const { sessionSummary } = options.sessionId !== undefined && options.sessionId !== null
        ? resolveTaskSessionContext(database, { sessionId: options.sessionId })
        : { sessionSummary: '' }
      const contextBlock = formatAgentContextBlock({
        fileRegisters: resolved.fileRegisters,
        folderRegisters: resolved.folderRegisters,
        sessionSummary
      })
      return {
        hydrated: {
          ...options,
          ...(resolved.files.length > 0 ? { defaultFiles: resolved.files } : {}),
          ...(contextBlock ? { contextBlock } : {}),
          ...(options.sessionId !== undefined && options.sessionId !== null
            ? { sessionId: Number(options.sessionId) }
            : {}),
          syncSession: options.syncSession !== false,
          syncFiles: Boolean(options.syncFiles)
        }
      }
    }
    const parsedId = Number(options.taskId)
    if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
      return { error: bus.errorResult(400, 'Task ID must be a positive integer.') }
    }
    if (typeof database.getTask !== 'function') {
      return { hydrated: { ...options, taskId: parsedId } }
    }
    const task = database.getTask(parsedId)
    if (!task) {
      return { error: bus.errorResult(404, 'Task not found.') }
    }

    const backfilled = backfillTaskRegisters(database, task, {
      extraFiles: options.files ?? [],
      persist: options.backfillRegisters !== false
    })
    const activeTask = backfilled.task
    const relevantFiles = backfilled.files.slice(0, 20)
    const { sessionSummary } = resolveTaskSessionContext(database, {
      taskId: task.id,
      sessionId: options.sessionId
    })
    const contextBlock = formatAgentContextBlock({
      task: activeTask,
      fileRegisters: backfilled.fileRegisters,
      folderRegisters: backfilled.folderRegisters,
      sessionSummary
    })
    const rawObjective = typeof options.objective === 'string' ? options.objective.trim() : ''
    const hasDelimitedObjective = /[;\n]/.test(rawObjective)
    const criteriaSlices = (!options.slices && !hasDelimitedObjective)
      ? String(activeTask.acceptance_criteria ?? '')
        .split(/\r?\n+/)
        .map((line) => line.trim().replace(/^(?:\d+[.)]|[-*])\s*/, '').trim())
        .filter(Boolean)
      : []

    let slices = options.slices
    if (!Array.isArray(slices) && criteriaSlices.length > 0) {
      slices = criteriaSlices.map((goal, index) => ({
        index: index + 1,
        title: goal.slice(0, 80),
        goal,
        files: relevantFiles
      }))
    } else if (Array.isArray(slices) && relevantFiles.length > 0) {
      slices = slices.map((entry) => (
        typeof entry === 'string'
          ? { title: entry.trim().slice(0, 80), goal: entry.trim(), files: relevantFiles }
          : { ...entry, files: Array.isArray(entry.files) && entry.files.length > 0 ? entry.files : relevantFiles }
      ))
    }

    return {
      hydrated: {
        ...options,
        taskId: activeTask.id,
        title: (typeof options.title === 'string' && options.title.trim()) ? options.title : activeTask.title,
        objective: rawObjective || String(activeTask.description ?? '').trim() || activeTask.title,
        worktreePath: (typeof options.worktreePath === 'string' && options.worktreePath.trim())
          ? options.worktreePath.trim()
          : (activeTask.worktree_path || ''),
        ...(contextBlock ? { contextBlock } : {}),
        ...(options.sessionId !== undefined && options.sessionId !== null
          ? { sessionId: Number(options.sessionId) }
          : {}),
        syncSession: options.syncSession !== false,
        syncFiles: Boolean(options.syncFiles),
        ...(slices ? { slices } : {}),
        ...(relevantFiles.length > 0 && !slices ? { defaultFiles: relevantFiles } : {})
      }
    }
  }

  function readSyncResourceStatus(explicitStatus) {
    if (explicitStatus && typeof explicitStatus.then !== 'function') {
      return explicitStatus
    }
    if (scheduler && typeof scheduler.peekStatus === 'function') {
      return scheduler.peekStatus()
    }
    if (scheduler && typeof scheduler.status === 'function') {
      try {
        const result = scheduler.status()
        if (result && typeof result.then !== 'function') return result
      } catch {
        return null
      }
    }
    return null
  }

  async function readAsyncResourceStatus() {
    if (scheduler && typeof scheduler.status === 'function') {
      try {
        const result = await scheduler.status()
        if (result) return result
      } catch {
        return null
      }
    }
    return readSyncResourceStatus()
  }

  function planSwarm(rawOptions = {}) {
    const { error, hydrated } = hydrateTaskOptions(rawOptions)
    if (error) return error
    const {
      title,
      objective = '',
      slices,
      workerCount,
      includeReviewer = true,
      models: preferredModels = [],
      opencodeModels = [],
      agents: customAgents,
      resourceStatus,
      parentMode: rawParentMode = 'deterministic',
      maxReviewRounds: rawMaxReviewRounds = 0,
      defaultFiles = [],
      taskId,
      worktreePath = '',
      contextBlock = '',
      sessionId = null,
      syncSession = true,
      syncFiles = false,
      selfImprove: rawSelfImprove = true,
      autoProposeSelfImprovement = false
    } = hydrated
    const selfImprove = rawSelfImprove !== false
    const parentMode = VALID_PARENT_MODES.has(rawParentMode) ? rawParentMode : 'deterministic'
    const maxReviewRounds = Math.max(0, Math.min(3, Math.floor(Number(rawMaxReviewRounds) || 0)))
    const effectiveResourceStatus = readSyncResourceStatus(resourceStatus)
    const normalizedSlices = normalizeSlices(objective, slices, workerCount).map((slice) => (
      slice.files.length === 0 && defaultFiles.length > 0
        ? { ...slice, files: defaultFiles }
        : slice
    ))
    const explicitWorkerCount = Number.isFinite(Number(workerCount)) && Number(workerCount) > 0
      ? Number(workerCount)
      : normalizedSlices.length
    const effectiveWorkerCount = Math.min(6, Math.max(1, Math.floor(explicitWorkerCount)))
    const roster = buildSwarmRoster({
      models,
      modelBudget,
      resourceStatus: effectiveResourceStatus,
      workerCount: effectiveWorkerCount,
      includeReviewer,
      preferredModels,
      opencodeModels
    })

    const agentsForPlan = Array.isArray(customAgents) && customAgents.length > 0
      ? customAgents
      : roster.agents
    const workersForSlices = agentsForPlan.filter((agent) => agent.role === 'worker')
    const mappedSlices = normalizedSlices.map((slice, index) => ({
      ...slice,
      worker: slice.worker
        || workersForSlices[index % Math.max(1, workersForSlices.length)]?.name
        || 'worker-1'
    }))

    const dispatchPlan = planAgentDispatch({
      models,
      modelBudget,
      resourceStatus: effectiveResourceStatus,
      agents: agentsForPlan
    })

    const byLimitKind = {
      resource: 0,
      compute_utilization: 0,
      provider_model: 0
    }
    for (let index = 0; index < agentsForPlan.length; index += 1) {
      const kind = dispatchPlan.agents[index]?.limitKind ?? agentsForPlan[index]?.limitKind
      if (kind && Object.hasOwn(byLimitKind, kind)) {
        byLimitKind[kind] += 1
      }
    }

    const workerDomains = new Set(
      dispatchPlan.agents
        .filter((agent) => agent.role === 'worker' && agent.groupKey)
        .map((agent) => agent.groupKey)
    )
    if (workerDomains.size === 0) {
      for (const worker of workersForSlices) {
        if (worker.groupKey) workerDomains.add(worker.groupKey)
      }
    }

    const cleanObjective = String(objective ?? '').trim()
    const cleanTitle = (typeof title === 'string' && title.trim())
      || cleanObjective.slice(0, 80)
      || 'Swarm run'
    const delimitedCount = cleanObjective.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).length
    const hasExplicitSlices = (Array.isArray(slices) && slices.length > 0) || delimitedCount > 1
    const autoSlicePending = parentMode === 'ai' || (parentMode === 'auto' && !hasExplicitSlices)

    return {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(contextBlock ? { contextBlock } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      syncSession,
      syncFiles,
      selfImprove,
      autoProposeSelfImprovement: Boolean(autoProposeSelfImprovement),
      selfImprovementPlan: {
        enabled: selfImprove,
        strategy: selfImprove ? 'parallel' : 'disabled',
        combines: ['workspace_sensors', 'portability_audit', 'run_telemetry', 'worker_proposals']
      },
      title: cleanTitle,
      objective: cleanObjective,
      includeReviewer: agentsForPlan.some((agent) => agent.role === 'reviewer'),
      parentMode,
      maxReviewRounds,
      autoSlicePending,
      agents: agentsForPlan,
      slices: mappedSlices,
      dispatchPlan,
      quotaSummary: {
        parentModelCalls: autoSlicePending ? 1 : 0,
        distinctProviderDomains: workerDomains.size,
        byLimitKind
      }
    }
  }

  function formatBoard(runId) {
    const run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    if (!run) return null
    const agentById = new Map(run.agents.map((agent) => [agent.id, agent]))
    const board = [...run.messages]
      .sort((a, b) => a.seq - b.seq)
      .map((message) => {
        const fromAgent = agentById.get(message.fromAgentId)
        const toAgent = agentById.get(message.toAgentId)
        return {
          seq: message.seq,
          id: message.id,
          kind: message.kind,
          state: message.state,
          from: fromAgent ? `@${fromAgent.name}` : message.fromAgentId,
          to: toAgent ? `@${toAgent.name}` : message.toAgentId,
          correlationId: message.correlationId,
          summary: message.payload?.summary ?? message.payload?.goal ?? message.error ?? '',
          payload: message.payload,
          result: message.result ?? null,
          artifactRefs: message.artifactRefs ?? [],
          createdAt: message.createdAt
        }
      })

    const taskOps = typeof database.listAgentTaskOps === 'function'
      ? database.listAgentTaskOps(run.id)
      : []

    const selfImprovement = run.result?.selfImprovement
      ?? run.checkpoint?.selfImprovement
      ?? null

    return {
      runId: run.id,
      taskId: run.taskId ?? null,
      state: run.state,
      title: run.plan?.title ?? '',
      objective: run.plan?.objective ?? '',
      selfImprove: run.plan?.selfImprove !== false,
      ...(selfImprovement ? { selfImprovement } : {}),
      ...(run.plan?.worktreePath ? { worktreePath: run.plan.worktreePath } : {}),
      agents: run.agents,
      board,
      usage: run.usage,
      budgetState: run.budgetState,
      checkpoint: run.checkpoint,
      ...(taskOps.length > 0 ? { taskOps } : {}),
      result: run.result ?? null,
      error: run.error ?? null
    }
  }

  function dispatchPendingSlices(runId, primaryAgentId, slices, { round = 0 } = {}) {
    const stillPending = []
    let dispatched = 0
    for (const slice of slices) {
      const roundKey = round > 0 ? `-r${round}` : ''
      const sent = bus.sendMessage({
        agentId: primaryAgentId,
        runId,
        to: slice.worker,
        kind: 'assign',
        payload: {
          sliceIndex: slice.index,
          title: slice.title,
          goal: slice.goal,
          files: slice.files ?? [],
          refs: Array.isArray(slice.refs) ? slice.refs : []
        },
        idempotencyKey: `assign-slice-${slice.index}${roundKey}`,
        correlationId: `slice-${slice.index}${roundKey}`
      })
      if (!sent.error || sent.duplicate) {
        if (!sent.duplicate) dispatched += 1
      } else if (sent.error.status === 429) {
        stillPending.push(slice)
      } else {
        stillPending.push({ ...slice, dispatchError: sent.error.body?.error ?? 'Dispatch failed.' })
      }
    }
    return { stillPending, dispatched }
  }

  function createSwarm(options = {}) {
    const plan = planSwarm(options)
    if (plan.error) return plan
    if (!plan.objective) {
      return bus.errorResult(400, 'Swarm objective or taskId is required.')
    }
    const agents = (Array.isArray(options.agents) && options.agents.length > 0
      ? options.agents
      : plan.agents
    ).map((agent) => ({
      role: agent.role,
      name: agent.name,
      model: agent.model,
      ...(agent.backend ? { backend: agent.backend } : {})
    }))

    const resolvedWorktreePath = (typeof options.worktreePath === 'string' && options.worktreePath.trim())
      ? options.worktreePath.trim()
      : (plan.worktreePath ?? '')

    const created = bus.createRun({
      task_id: plan.taskId ?? options.taskId,
      budget: options.budget,
      model_plan: {
        quotaSummary: plan.quotaSummary,
        dispatchPlan: plan.dispatchPlan
      },
      plan: {
        title: plan.title,
        objective: plan.objective,
        slices: plan.slices,
        includeReviewer: plan.includeReviewer,
        parentMode: plan.parentMode,
        maxReviewRounds: plan.maxReviewRounds,
        syncTask: options.syncTask !== false,
        completeTask: Boolean(options.completeTask),
        syncSession: plan.syncSession !== false,
        syncFiles: Boolean(plan.syncFiles),
        selfImprove: plan.selfImprove !== false,
        autoProposeSelfImprovement: Boolean(plan.autoProposeSelfImprovement),
        ...(plan.contextBlock ? { contextBlock: plan.contextBlock } : {}),
        ...(plan.sessionId !== undefined && plan.sessionId !== null ? { sessionId: plan.sessionId } : {}),
        autoSlicePending: plan.autoSlicePending,
        worktreePath: resolvedWorktreePath
      },
      agents
    })
    if (created.error) return created

    bus.startRun(created.id)
    bus.transitionRun(created.id, 'dispatching')
    bus.transitionRun(created.id, 'running')

    const { stillPending } = plan.autoSlicePending
      ? { stillPending: [] }
      : dispatchPendingSlices(created.id, created.primaryAgentId, plan.slices)
    bus.checkpointRun({
      agentId: created.primaryAgentId,
      runId: created.id,
      checkpoint: {
        pendingSlices: stillPending,
        completedSlices: [],
        failedSlices: [],
        reviewRequested: false,
        reviewRound: 0,
        autoSlicePending: Boolean(plan.autoSlicePending),
        slices: plan.slices,
        selfImprovement: null,
        stepCount: 0
      }
    })

    return formatBoard(created.id)
  }

  function resolveCallableModel(modelSpec, backendSpec = '') {
    return resolveAgentModel(models, modelSpec, backendSpec) ?? {
      id: modelSpec,
      label: modelSpec,
      provider: 'custom',
      backend: backendSpec || 'http',
      ...(backendSpec ? { cli: { model: backendSpec } } : {})
    }
  }

  function pickFallbackModel(currentModelId, excludedIds, resourceStatus = null) {
    const callableModels = models.filter((model) => model && model.callable !== false)
    const snapshotPlan = callableModels.length > 0
      ? planAgentDispatch({
        models,
        modelBudget,
        resourceStatus,
        agents: callableModels.map((model) => ({
          name: model.id,
          role: 'worker',
          model: model.id,
          backend: model.backend
        }))
      })
      : { agents: [] }
    const dispatchById = new Map(
      snapshotPlan.agents.map((entry) => [entry.model, entry])
    )
    const headroomById = new Map(
      callableModels.map((model) => {
        const baseId = model.baseId ?? model.id
        const scope = quotaScopeForModel(model)
        const result = typeof modelBudget?.headroom === 'function'
          ? modelBudget.headroom(baseId, scope)
          : null
        return [model.id, result]
      })
    )
    const rankedRegistryIds = [...callableModels]
      .sort((a, b) => {
        const billing = billingRank(a) - billingRank(b)
        if (billing !== 0) return billing
        const aAuto = a.autoSelect !== false && a.execution !== 'batch'
        const bAuto = b.autoSelect !== false && b.execution !== 'batch'
        if (aAuto !== bAuto) return aAuto ? -1 : 1
        const aHead = headroomById.get(a.id)
        const bHead = headroomById.get(b.id)
        const aConfigured = Boolean(aHead?.configured || !a.remote)
        const bConfigured = Boolean(bHead?.configured || !b.remote)
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1
        const aHeadroom = dispatchById.get(a.id)?.headroom ?? 1
        const bHeadroom = dispatchById.get(b.id)?.headroom ?? 1
        if (aHeadroom !== bHeadroom) return bHeadroom - aHeadroom
        const aObserved = Number(aHead?.observedRequests ?? 0)
        const bObserved = Number(bHead?.observedRequests ?? 0)
        if (aObserved !== bObserved) return aObserved - bObserved
        const aRemote = a.remote === true && a.limitKind !== 'resource'
        const bRemote = b.remote === true && b.limitKind !== 'resource'
        if (aRemote !== bRemote) return aRemote ? -1 : 1
        return (b.priority ?? 0) - (a.priority ?? 0)
      })
      .map((model) => model.id)

    const candidateSpecs = [
      ...fallbackChain,
      ...rankedRegistryIds
    ]
    const seen = new Set()
    for (const spec of candidateSpecs) {
      if (typeof spec !== 'string' || !spec.trim()) continue
      const cand = resolveAgentModel(models, spec.trim())
      if (!cand || cand.id === currentModelId || excludedIds.has(cand.id) || seen.has(cand.id)) {
        continue
      }
      seen.add(cand.id)
      const baseId = cand.baseId ?? cand.id
      const scope = quotaScopeForModel(cand)
      const check = modelBudget?.check?.(baseId, scope)
      if (check && check.ok === false) {
        continue
      }
      const dispatch = planAgentDispatch({
        models,
        modelBudget,
        resourceStatus,
        agents: [{ name: 'fallback', role: 'worker', model: cand.id, backend: cand.backend }]
      })
      if (dispatch.ok !== false) {
        return cand
      }
    }
    return null
  }

  async function trySwitchFallbackModel({
    run,
    activeAgent,
    activeModel,
    excludedIds,
    attempt,
    maxAttempts = 2,
    reason
  }) {
    if (attempt >= maxAttempts - 1) return null
    excludedIds.add(activeModel.id)
    const resourceStatus = await readAsyncResourceStatus()
    const nextModel = pickFallbackModel(activeModel.id, excludedIds, resourceStatus)
    if (!nextModel) return null

    const switched = bus.switchAgentModel({
      runId: run.id,
      agentId: activeAgent.id,
      model: nextModel.id,
      backend: nextModel.backend ?? '',
      ...(reason ? { reason } : {})
    })
    const nextAgent = switched.agent ?? activeAgent
    return { agent: nextAgent, model: nextModel }
  }

  async function callAgentWithFallback(agent, messages, { run, maxTokens = DEFAULT_SWARM_MAX_TOKENS } = {}) {
    if (!modelClient || typeof modelClient.complete !== 'function') {
      return { ok: false, error: 'Model client is not configured.' }
    }

    const excludedIds = new Set()
    let activeAgent = database.getAgent(agent.id) ?? agent
    let activeModel = resolveCallableModel(activeAgent.model, activeAgent.backend)
    const maxAttempts = Math.max(2, Math.min(4, models.length || 2))

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const baseId = activeModel.baseId ?? activeModel.id
      const scope = quotaScopeForModel(activeModel)
      let gate = null
      if (modelBudget) {
        if (typeof modelBudget.reserve === 'function') {
          const reserved = modelBudget.reserve(baseId, { scope, calls: 1, tokens: maxTokens })
          if (reserved?.ok === false) {
            const switched = await trySwitchFallbackModel({
              run,
              activeAgent,
              activeModel,
              excludedIds,
              attempt,
              maxAttempts,
              reason: `${activeModel.label || activeModel.id} quota exhausted or cooling down.`
            })
            if (!switched) {
              return {
                ok: false,
                status: 429,
                error: `${activeModel.label || activeModel.id} has no quota headroom.`
              }
            }
            activeAgent = switched.agent
            activeModel = switched.model
            continue
          }
          gate = { ...reserved, scope }
        } else {
          gate = { ...modelBudget.check?.(baseId, scope), scope }
        }
      }

      const isLocalResourceModel = !activeModel.remote || activeModel.limitKind === 'resource'
      let scheduled = null
      if (scheduler && typeof scheduler.select === 'function' && isLocalResourceModel) {
        scheduled = await scheduler.select(baseId)
        if (scheduled?.error) {
          if (gate?.reservationId && typeof modelBudget?.release === 'function') {
            modelBudget.release(gate.reservationId)
          }
          const gateReason = scheduled.error.body?.busyReasons?.[0]
            || scheduled.error.body?.error
            || `${activeModel.label || activeModel.id} local resource gate is busy.`
          modelMetrics?.recordStart?.(baseId)
          modelMetrics?.recordError?.(baseId, new Error(gateReason))
          const switched = await trySwitchFallbackModel({
            run,
            activeAgent,
            activeModel,
            excludedIds,
            attempt,
            maxAttempts,
            reason: gateReason
          })
          if (switched) {
            activeAgent = switched.agent
            activeModel = switched.model
            continue
          }
          return {
            ok: false,
            status: scheduled.error.status || 503,
            error: gateReason
          }
        }
      }

      const startedAt = now()
      let reportedUsage = null
      let inferenceStarted = false
      modelMetrics?.recordStart?.(baseId)
      try {
        inferenceStarted = true
        const content = await modelClient.complete(activeModel, {
          messages,
          maxTokens,
          sessionKey: activeAgent.promptCacheKey,
          ...(run.plan?.worktreePath ? { worktreePath: run.plan.worktreePath } : {}),
          onUsage: (usage) => {
            reportedUsage = usage
          }
        })
        const durationMs = Math.max(0, now() - startedAt)
        modelMetrics?.recordSuccess?.(baseId, { durationMs })
        if (modelBudget) {
          if (gate?.reservationId && typeof modelBudget.settle === 'function') {
            modelBudget.settle(gate.reservationId, { usage: reportedUsage ?? undefined })
          } else {
            modelBudget.record?.(baseId, 1, scope)
            if (reportedUsage) modelBudget.recordUsage?.(baseId, reportedUsage, scope)
          }
        }
        bus.recordUsage({
          agentId: activeAgent.id,
          runId: run.id,
          usage: {
            calls: 1,
            promptTokens: reportedUsage?.promptTokens ?? reportedUsage?.prompt_tokens ?? 0,
            completionTokens: reportedUsage?.completionTokens ?? reportedUsage?.completion_tokens ?? 0,
            totalTokens: reportedUsage?.totalTokens ?? reportedUsage?.total_tokens ?? 0,
            durationMs,
            model: activeModel.id
          }
        })
        return { ok: true, content, agent: activeAgent, model: activeModel }
      } catch (error) {
        if (gate?.reservationId && typeof modelBudget?.release === 'function') {
          modelBudget.release(gate.reservationId)
        }
        modelMetrics?.recordError?.(baseId, error, {
          durationMs: Math.max(0, now() - startedAt)
        })
        const errorStatus = Number(error?.status)
        if (errorStatus === 429) {
          const retryAfter = error.retryAfter ?? DEFAULT_COOLDOWN_SECONDS
          if (typeof modelBudget?.observe429 === 'function') {
            modelBudget.observe429(baseId, { retryAfter, scope })
          } else {
            modelBudget?.cooldown?.(baseId, retryAfter, scope)
          }
        }
        const fallbackEligible = isFallbackEligible(error)
          || errorStatus === 502
          || error?.code === 'RESOURCE_BUSY'
        if (fallbackEligible) {
          const switched = await trySwitchFallbackModel({
            run,
            activeAgent,
            activeModel,
            excludedIds,
            attempt,
            maxAttempts,
            reason: String(error?.message || `HTTP ${errorStatus || 'error'}`)
          })
          if (switched) {
            activeAgent = switched.agent
            activeModel = switched.model
            continue
          }
        }
        return {
          ok: false,
          status: error?.status ?? 502,
          error: String(error?.message || 'Model execution failed.')
        }
      } finally {
        scheduled?.release?.({ inferenceStarted })
      }
    }

    return { ok: false, status: 429, error: 'All candidate models failed or hit rate limits.' }
  }

  function contextSuffixForRun(run, extraFiles = []) {
    const parts = []
    const baseContext = typeof run?.plan?.contextBlock === 'string'
      ? run.plan.contextBlock.trim()
      : ''
    if (baseContext) parts.push(baseContext)
    const sliceFiles = splitFileRefs(extraFiles)
    if (sliceFiles.length > 0 && typeof database?.listUserFiles === 'function') {
      const resolved = resolveFileAndFolderRegisters(database, sliceFiles, { expandRelevant: true })
      const unseenFiles = resolved.fileRegisters.filter((entry) => !baseContext.includes(entry.path))
      const unseenFolders = resolved.folderRegisters.filter((entry) => !baseContext.includes(entry.path))
      if (unseenFiles.length > 0 || unseenFolders.length > 0) {
        const extra = formatAgentContextBlock({
          fileRegisters: unseenFiles,
          folderRegisters: unseenFolders,
          maxChars: 500
        })
        if (extra) parts.push(extra)
      }
    }
    const combined = parts.filter(Boolean).join('\n')
    return combined ? `\nContext:\n${combined}` : ''
  }

  async function runWorkerMessage(run, worker, message) {
    bus.ackMessage({ agentId: worker.id, messageId: message.id })
    if (message.kind !== 'assign') {
      bus.completeMessage({ agentId: worker.id, messageId: message.id, result: { ignored: true } })
      database.updateAgent(worker.id, { state: 'waiting' })
      return
    }

    const refs = Array.isArray(message.payload?.refs) && message.payload.refs.length > 0
      ? `\nRefs: ${message.payload.refs.join(', ')}`
      : ''
    const files = Array.isArray(message.payload?.files) && message.payload.files.length > 0
      ? `\nFiles: ${message.payload.files.join(', ')}`
      : ''
    const answerLine = message.payload?.parentAnswer
      ? `\nParent answer: ${message.payload.parentAnswer}`
      : ''
    const contextLine = contextSuffixForRun(run, message.payload?.files ?? [])
    const promptMessages = [
      {
        role: 'system',
        content:
          'You are a swarm worker executing one scoped slice. ' +
          'Reply concisely, preferring JSON {"summary": string, "status": "done", "details": string, "proposals": []}. ' +
          'If blocked by a critical missing requirement, reply JSON {"summary": string, "status": "question", "question": string}.'
      },
      {
        role: 'user',
        content: `#${message.seq} [assign] ${message.payload?.title ? `${message.payload.title}: ` : ''}${message.payload?.goal ?? ''}${files}${refs}${answerLine}${contextLine}`
      }
    ]

    const call = await callAgentWithFallback(worker, promptMessages, { run })
    if (!call.ok) {
      bus.failMessage({
        agentId: worker.id,
        messageId: message.id,
        error: call.error,
        retryable: false
      })
      bus.sendMessage({
        agentId: worker.id,
        runId: run.id,
        to: 'parent',
        kind: 'error',
        payload: {
          sliceIndex: message.payload?.sliceIndex,
          error: call.error,
          assignSeq: message.seq
        },
        idempotencyKey: `error-${message.id}`,
        correlationId: message.correlationId
      })
      database.updateAgent(worker.id, { state: 'failed' })
      return
    }

    const parsed = parseWorkerResponse(call.content)
    if (parsed.question && !message.payload?.parentAnswer) {
      bus.sendMessage({
        agentId: worker.id,
        runId: run.id,
        to: 'parent',
        kind: 'question',
        payload: {
          sliceIndex: message.payload?.sliceIndex,
          title: message.payload?.title ?? '',
          goal: message.payload?.goal ?? '',
          files: message.payload?.files ?? [],
          question: parsed.question,
          summary: parsed.question,
          assignSeq: message.seq
        },
        idempotencyKey: `question-${message.id}`,
        correlationId: message.correlationId
      })
      bus.completeMessage({
        agentId: worker.id,
        messageId: message.id,
        result: { question: parsed.question }
      })
      database.updateAgent(worker.id, { state: 'waiting' })
      return
    }

    const artifactRefs = []
    if (call.content.length > MAX_ARTIFACT_THRESHOLD) {
      const artifact = database.saveAgentArtifact({
        kind: 'worker_output',
        path: `slice-${message.payload?.sliceIndex ?? message.seq}`,
        producer: worker.name,
        content: call.content
      })
      artifactRefs.push(artifact.contentHash)
    }

    bus.sendMessage({
      agentId: worker.id,
      runId: run.id,
      to: 'parent',
      kind: 'result',
      payload: {
        sliceIndex: message.payload?.sliceIndex,
        summary: parsed.summary,
        status: parsed.status,
        assignSeq: message.seq,
        ...(parsed.proposals.length > 0 ? { proposals: parsed.proposals } : {}),
        ...(Object.keys(parsed.registers).length > 0 ? { registers: parsed.registers } : {})
      },
      artifactRefs,
      idempotencyKey: `result-${message.id}`,
      correlationId: message.correlationId
    })
    bus.completeMessage({
      agentId: worker.id,
      messageId: message.id,
      result: { summary: parsed.summary }
    })
    database.updateAgent(worker.id, { state: 'waiting' })
  }

  function processParentInbox(run, checkpoint) {
    const claimed = bus.claimInbox({ agentId: run.primaryAgentId, runId: run.id, limit: 20 })
    const agentById = new Map(run.agents.map((agent) => [agent.id, agent]))
    const completedSlices = Array.isArray(checkpoint.completedSlices)
      ? [...checkpoint.completedSlices]
      : []
    const failedSlices = Array.isArray(checkpoint.failedSlices)
      ? [...checkpoint.failedSlices]
      : []
    const seenSliceSeqs = new Set(completedSlices.map((entry) => entry.seq))
    const questions = []
    let processed = 0
    let verdictResult = null

    for (const message of claimed.messages ?? []) {
      processed += 1
      bus.ackMessage({ agentId: run.primaryAgentId, messageId: message.id })
      if (message.kind === 'result') {
        if (!seenSliceSeqs.has(message.seq)) {
          seenSliceSeqs.add(message.seq)
          completedSlices.push({
            seq: message.seq,
            from: agentById.get(message.fromAgentId)?.name ?? message.fromAgentId,
            sliceIndex: message.payload?.sliceIndex,
            summary: message.payload?.summary ?? '',
            artifactRefs: message.artifactRefs ?? [],
            proposals: Array.isArray(message.payload?.proposals) ? message.payload.proposals : [],
            registers: (message.payload?.registers && typeof message.payload.registers === 'object')
              ? message.payload.registers
              : {}
          })
        }
        bus.completeMessage({
          agentId: run.primaryAgentId,
          messageId: message.id,
          result: { recorded: true }
        })
      } else if (message.kind === 'question') {
        questions.push({
          seq: message.seq,
          id: message.id,
          workerName: agentById.get(message.fromAgentId)?.name ?? message.fromAgentId,
          sliceIndex: message.payload?.sliceIndex,
          title: message.payload?.title ?? '',
          goal: message.payload?.goal ?? '',
          files: Array.isArray(message.payload?.files) ? message.payload.files : [],
          question: message.payload?.question || message.payload?.summary || '',
          correlationId: message.correlationId
        })
        bus.completeMessage({
          agentId: run.primaryAgentId,
          messageId: message.id,
          result: { queuedForParentAnswer: true }
        })
      } else if (message.kind === 'error') {
        failedSlices.push({
          seq: message.seq,
          from: agentById.get(message.fromAgentId)?.name ?? message.fromAgentId,
          sliceIndex: message.payload?.sliceIndex,
          error: message.payload?.error ?? 'Worker failed.'
        })
        bus.completeMessage({
          agentId: run.primaryAgentId,
          messageId: message.id,
          result: { recorded: true }
        })
      } else if (message.kind === 'verdict') {
        const approved = message.payload?.approved !== false
        verdictResult = {
          approved,
          seq: message.seq,
          summary: message.payload?.summary ?? (approved ? 'Approved.' : 'Rejected.'),
          proposals: Array.isArray(message.payload?.proposals) ? message.payload.proposals : [],
          registers: (message.payload?.registers && typeof message.payload.registers === 'object')
            ? message.payload.registers
            : {},
          verdict: message.payload
        }
        bus.completeMessage({
          agentId: run.primaryAgentId,
          messageId: message.id,
          result: { recorded: true, approved }
        })
      } else {
        bus.completeMessage({
          agentId: run.primaryAgentId,
          messageId: message.id,
          result: { acknowledged: true }
        })
      }
    }

    return { completedSlices, failedSlices, questions, processed, verdictResult }
  }

  async function runReviewerTurn(run, reviewer, handoffMessage) {
    bus.ackMessage({ agentId: reviewer.id, messageId: handoffMessage.id })
    const refs = Array.isArray(handoffMessage.payload?.refs)
      ? handoffMessage.payload.refs.join(', ')
      : ''
    const summaries = Array.isArray(handoffMessage.payload?.slices)
      ? handoffMessage.payload.slices.join('\n')
      : handoffMessage.payload?.summary ?? ''

    const contextLine = contextSuffixForRun(run)
    const promptMessages = [
      {
        role: 'system',
        content:
          'You are the swarm reviewer. Verify the combined slice summaries and respond concisely, ' +
          'preferring JSON {"approved": boolean, "summary": string}.'
      },
      {
        role: 'user',
        content: `#${handoffMessage.seq} [handoff] Refs: ${refs}\n${summaries}${contextLine}`
      }
    ]

    const call = await callAgentWithFallback(reviewer, promptMessages, { run })
    if (!call.ok) {
      bus.failMessage({
        agentId: reviewer.id,
        messageId: handoffMessage.id,
        error: call.error,
        retryable: false
      })
      bus.sendMessage({
        agentId: reviewer.id,
        runId: run.id,
        to: 'parent',
        kind: 'verdict',
        payload: {
          approved: false,
          summary: call.error,
          handoffSeq: handoffMessage.seq
        },
        idempotencyKey: `verdict-${handoffMessage.id}`,
        correlationId: handoffMessage.correlationId
      })
      database.updateAgent(reviewer.id, { state: 'failed' })
      return
    }

    const parsed = parseReviewerResponse(call.content)
    bus.sendMessage({
      agentId: reviewer.id,
      runId: run.id,
      to: 'parent',
      kind: 'verdict',
      payload: {
        approved: parsed.approved,
        summary: parsed.summary,
        handoffSeq: handoffMessage.seq,
        ...(parsed.proposals.length > 0 ? { proposals: parsed.proposals } : {}),
        ...(Object.keys(parsed.registers).length > 0 ? { registers: parsed.registers } : {})
      },
      idempotencyKey: `verdict-${handoffMessage.id}`,
      correlationId: handoffMessage.correlationId
    })
    bus.completeMessage({
      agentId: reviewer.id,
      messageId: handoffMessage.id,
      result: { approved: parsed.approved, summary: parsed.summary }
    })
    database.updateAgent(reviewer.id, { state: 'done' })
  }

  function effectiveSlicesFor(run, checkpoint) {
    if (Array.isArray(checkpoint?.slices) && checkpoint.slices.length > 0) {
      return checkpoint.slices
    }
    return Array.isArray(run?.plan?.slices) ? run.plan.slices : []
  }

  function normalizeProposalKey(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  function buildParallelSelfImprovement(run, checkpoint, verdictResult = null) {
    if (run?.plan?.selfImprove === false) {
      return { enabled: false, strategy: 'disabled' }
    }

    let sensorFindings = []
    try {
      if (typeof database.listTasks === 'function' && typeof database.listSensorFindings === 'function') {
        const scanned = scanWorkspaceSensors({ database, models, modelBudget, now: now() })
        sensorFindings = Array.isArray(scanned?.findings) ? scanned.findings : []
      }
    } catch {
      sensorFindings = []
    }

    const events = typeof database.listAgentEvents === 'function'
      ? database.listAgentEvents(run.id, { limit: 500 })
      : []
    const switchedModels = events
      .filter((event) => event.type === 'agent_model_switched')
      .map((event) => ({
        agentId: event.agentId ?? '',
        fromModel: event.data?.fromModel ?? '',
        toModel: event.data?.toModel ?? '',
        reason: compactText(event.data?.reason ?? '', 200)
      }))

    const usage = typeof database.getAgentRunUsage === 'function'
      ? database.getAgentRunUsage(run.id)
      : { calls: 0, totalTokens: 0, durationMs: 0 }

    const portabilityIssues = sensorFindings.filter((entry) =>
      entry.sensorId === 'tracking.repository_root_missing'
      || entry.sensorId === 'tracking.worktree_missing'
    )
    const portabilityOk = portabilityIssues.length === 0

    const recommendations = []
    const suggestedProposals = []

    if (!portabilityOk) {
      recommendations.push(
        `Repair ${portabilityIssues.length} missing repository root or worktree path(s) to preserve portability.`
      )
      suggestedProposals.push({
        title: 'Repair non-portable repository or worktree paths',
        description: portabilityIssues.map((entry) => entry.summary).join(' '),
        priority: 'high',
        task_type: 'chore',
        rationale: 'Detected by parallel swarm portability self-improvement lane.'
      })
    }

    if (switchedModels.length > 0) {
      recommendations.push(
        `Inspect ${switchedModels.length} model fallback switch(es) recorded during this swarm run.`
      )
    }

    const quotaGaps = sensorFindings.filter((entry) =>
      entry.sensorId === 'provider.quota_blocked' || entry.sensorId === 'model.usage_without_profile'
    )
    if (quotaGaps.length > 0) {
      recommendations.push(
        `Tune quota profiles or fallback ordering for ${quotaGaps.length} provider/model sensor finding(s).`
      )
    }

    const metadataGaps = sensorFindings.filter((entry) =>
      entry.sensorId === 'tracking.files_without_objective'
      || entry.sensorId === 'tracking.folders_without_objective'
    )
    if (metadataGaps.length > 0) {
      recommendations.push(
        'Backfill missing file/folder header objectives and run ./workspace files scan.'
      )
      suggestedProposals.push({
        title: 'Backfill missing file and folder register objectives',
        description: metadataGaps.map((entry) => entry.summary).join(' '),
        priority: 'medium',
        task_type: 'chore',
        rationale: 'Detected by parallel swarm register self-improvement lane.'
      })
    }

    if (verdictResult && verdictResult.approved === false) {
      recommendations.push('Review rejected slice feedback before retrying execution.')
    }

    return {
      enabled: true,
      strategy: 'parallel',
      evaluatedAt: new Date(now()).toISOString(),
      portabilityOk,
      sensorFindingsCount: sensorFindings.length,
      sensorHighlights: sensorFindings.slice(0, 5).map((entry) => ({
        sensorId: entry.sensorId,
        severity: entry.severity,
        title: entry.title
      })),
      telemetry: {
        calls: Number(usage?.calls ?? 0),
        totalTokens: Number(usage?.totalTokens ?? 0),
        durationMs: Number(usage?.durationMs ?? 0),
        completedSlices: (checkpoint.completedSlices ?? []).length,
        failedSlices: (checkpoint.failedSlices ?? []).length,
        modelSwitches: switchedModels.length,
        switchedModels
      },
      recommendations,
      suggestedProposals: suggestedProposals.slice(0, 2)
    }
  }

  function syncTaskAndProposals(
    run,
    parentAgent,
    checkpoint,
    { approved, summary, verdictResult, selfImprovement = null }
  ) {
    if (!parentAgent || typeof database.applyTaskOps !== 'function') return
    const existingKeys = new Set(
      (typeof database.listTaskProposals === 'function'
        ? database.listTaskProposals({ status: 'proposed' })
        : [])
        .map((entry) => normalizeProposalKey(entry.title))
        .filter(Boolean)
    )
    const rawProposals = [
      ...(checkpoint.completedSlices ?? []).flatMap((slice) => slice.proposals ?? []),
      ...(verdictResult?.proposals ?? []),
      ...(run.plan?.autoProposeSelfImprovement ? (selfImprovement?.suggestedProposals ?? []) : [])
    ]
    const allProposals = []
    for (const proposal of rawProposals) {
      const key = normalizeProposalKey(proposal?.title)
      if (!key || existingKeys.has(key)) continue
      existingKeys.add(key)
      allProposals.push(proposal)
      if (allProposals.length >= MAX_PROPOSALS_PER_TURN) break
    }

    const ops = allProposals.map((proposal, index) => ({
      op_id: `propose-${run.id}-${index + 1}`,
      op: 'propose_task',
      title: proposal.title,
      description: proposal.description || proposal.title,
      priority: proposal.priority ?? 'medium',
      task_type: proposal.task_type ?? 'chore',
      ...(proposal.project ? { project: proposal.project } : {}),
      rationale: proposal.rationale || `Proposed during swarm run ${run.id}.`
    }))

    const mergedRegisters = {}
    for (const slice of checkpoint.completedSlices ?? []) {
      if (!slice.registers || typeof slice.registers !== 'object') continue
      for (const key of REGISTER_KEYS) {
        if (typeof slice.registers[key] === 'string' && slice.registers[key].trim()) {
          mergedRegisters[key] = compactText(slice.registers[key], 1800)
        }
      }
    }
    if (verdictResult?.registers && typeof verdictResult.registers === 'object') {
      for (const key of REGISTER_KEYS) {
        if (typeof verdictResult.registers[key] === 'string' && verdictResult.registers[key].trim()) {
          mergedRegisters[key] = compactText(verdictResult.registers[key], 1800)
        }
      }
    }

    if (run.taskId && run.plan?.syncTask !== false && typeof database.getTask === 'function') {
      const task = database.getTask(run.taskId)
      if (task) {
        if (approved) {
          const completedText = compactText(
            (checkpoint.completedSlices ?? [])
              .map((slice) => `#${slice.seq} (${slice.from}): ${slice.summary}`)
              .join('\n') || summary,
            1800
          ) || 'Swarm completed.'
          const canComplete = Boolean(run.plan?.completeTask && String(task.acceptance_criteria ?? '').trim())
          ops.push({
            op_id: `sync-task-${run.id}`,
            op: 'update_task',
            task_id: task.id,
            expected_updated_at: task.updated_at,
            ...(canComplete ? { verified: true } : {}),
            fields: {
              ...mergedRegisters,
              work_completed: completedText,
              ...(canComplete ? { status: 'done' } : {})
            }
          })
        } else {
          const reason = compactText(
            summary || checkpoint.failedSlices?.[0]?.error || 'Swarm execution failed.',
            500
          )
          ops.push({
            op_id: `sync-task-${run.id}`,
            op: 'update_task',
            task_id: task.id,
            expected_updated_at: task.updated_at,
            reason,
            fields: {
              ...mergedRegisters,
              status: 'blocked',
              work_blocked: reason
            }
          })
        }
      }
    }

    if (ops.length > 0) {
      database.applyTaskOps({ agent: parentAgent, ops })
    }
  }

  function finalizeSwarmRun(run, checkpoint, { approved, summary, verdictResult = null }) {
    const parentAgent = run.agents.find((agent) => agent.id === run.primaryAgentId)
      ?? run.agents.find((agent) => agent.role === 'parent')
    const selfImprovement = buildParallelSelfImprovement(run, checkpoint, verdictResult)
    checkpoint.selfImprovement = selfImprovement
    syncTaskAndProposals(run, parentAgent, checkpoint, {
      approved,
      summary,
      verdictResult,
      selfImprovement
    })
    bus.checkpointRun({ agentId: run.primaryAgentId, runId: run.id, checkpoint })
    database.updateAgent(run.primaryAgentId, { state: approved ? 'done' : 'failed' })
    bus.transitionRun(
      run.id,
      approved ? 'completed' : 'failed',
      approved
        ? {
          result: {
            summary,
            ...(verdictResult ? { verdict: verdictResult.verdict } : {}),
            ...(selfImprovement ? { selfImprovement } : {}),
            slices: checkpoint.completedSlices
          }
        }
        : {
          error: summary,
          result: {
            ...(verdictResult ? { verdict: verdictResult.verdict } : {}),
            ...(selfImprovement ? { selfImprovement } : {}),
            slices: checkpoint.completedSlices,
            ...(checkpoint.failedSlices?.length > 0 ? { failedSlices: checkpoint.failedSlices } : {})
          }
        }
    )
    if (
      run.plan?.syncSession !== false
      && (run.taskId || run.plan?.sessionId !== undefined && run.plan?.sessionId !== null)
    ) {
      recordAgentSessionExchange(database, {
        taskId: run.taskId ?? null,
        sessionId: run.plan?.sessionId ?? null,
        title: run.plan?.title || 'Swarm session',
        userContent: run.plan?.objective || '',
        assistantContent: summary || (checkpoint.completedSlices ?? []).map((slice) => slice.summary).join('\n')
      })
    }
    if (run.plan?.syncFiles === true) {
      try {
        scanWorkspaceUserFiles({
          rootDir: run.plan?.worktreePath || process.cwd(),
          database
        })
      } catch {
        // Ignore scan errors when the worktree path is synthetic or not registered on disk.
      }
    }
    return { stepped: true, ...formatBoard(run.id) }
  }

  async function runParentAutoSlice(run, checkpoint) {
    const parentAgent = run.agents.find((agent) => agent.id === run.primaryAgentId)
      ?? run.agents.find((agent) => agent.role === 'parent')
    const workers = run.agents.filter((agent) => agent.role === 'worker')
    const fallbackSlices = effectiveSlicesFor(run, checkpoint)
    let mappedSlices = fallbackSlices

    if (parentAgent && workers.length > 0) {
      const contextLine = contextSuffixForRun(run)
      const promptMessages = [
        {
          role: 'system',
          content:
            'You are the swarm parent planner. Split the objective into concrete worker slices and reply ONLY with JSON ' +
            '{"slices": [{"title": string, "goal": string, "files": string[]}]}.'
        },
        {
          role: 'user',
          content: `#0 [auto-slice] Split objective into ${workers.length} parallel worker slice(s): ${run.plan?.objective ?? ''}${contextLine}`
        }
      ]
      const call = await callAgentWithFallback(parentAgent, promptMessages, { run })
      if (call.ok) {
        const parsed = tryParseJson(call.content)
        const rawSlices = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.slices) ? parsed.slices : null)
        if (rawSlices && rawSlices.length > 0) {
          mappedSlices = normalizeSlices(run.plan?.objective, rawSlices, workers.length)
            .slice(0, 6)
            .map((slice, index) => ({
              ...slice,
              worker: slice.worker
                || workers[index % workers.length]?.name
                || 'worker-1'
            }))
        }
      }
    }

    checkpoint.slices = mappedSlices
    checkpoint.autoSlicePending = false
    const { stillPending } = dispatchPendingSlices(run.id, run.primaryAgentId, mappedSlices, {
      round: Number(checkpoint.reviewRound ?? 0)
    })
    checkpoint.pendingSlices = stillPending
    return true
  }

  async function answerWorkerQuestions(run, questions, checkpoint) {
    if (!Array.isArray(questions) || questions.length === 0) return false
    const parentAgent = run.agents.find((agent) => agent.id === run.primaryAgentId)
      ?? run.agents.find((agent) => agent.role === 'parent')
    let answered = false

    for (const question of questions) {
      let answerText = ''
      if (parentAgent) {
        const contextLine = contextSuffixForRun(run, question.files ?? [])
        const promptMessages = [
          {
            role: 'system',
            content:
              'You are the swarm parent coordinator. Answer the worker question concisely in plain text or JSON {"answer": string}.'
          },
          {
            role: 'user',
            content: `#${question.seq} [answer-question] Worker ${question.workerName} asks about "${question.goal}": ${question.question}${contextLine}`
          }
        ]
        const call = await callAgentWithFallback(parentAgent, promptMessages, { run })
        if (!call.ok) {
          checkpoint.failedSlices.push({
            seq: question.seq,
            from: question.workerName,
            sliceIndex: question.sliceIndex,
            error: call.error || 'Parent failed to answer worker question.'
          })
          continue
        }
        const parsed = tryParseJson(call.content)
        answerText = compactText(
          typeof parsed?.answer === 'string'
            ? parsed.answer
            : (typeof parsed?.summary === 'string' ? parsed.summary : call.content),
          600
        )
      }

      bus.sendMessage({
        agentId: run.primaryAgentId,
        runId: run.id,
        to: question.workerName,
        kind: 'assign',
        payload: {
          sliceIndex: question.sliceIndex,
          title: question.title,
          goal: question.goal,
          files: question.files ?? [],
          refs: [`#${question.seq}`],
          parentAnswer: answerText
        },
        idempotencyKey: `answer-slice-${question.sliceIndex ?? 'x'}-${question.seq}`,
        correlationId: question.correlationId || `slice-${question.sliceIndex ?? question.seq}`
      })
      answered = true
    }

    return answered
  }

  function startRevisionRound(run, checkpoint, verdictResult) {
    const nextRound = Number(checkpoint.reviewRound ?? 0) + 1
    checkpoint.reviewRound = nextRound
    checkpoint.reviewRequested = false
    checkpoint.completedSlices = []
    const revisionSlices = effectiveSlicesFor(run, checkpoint).map((slice) => ({
      ...slice,
      goal: `${slice.goal} (Revision round ${nextRound} requested by @reviewer in #${verdictResult.seq}: ${verdictResult.summary})`,
      refs: [`#${verdictResult.seq}`]
    }))
    if (database.getAgentRun(run.id)?.state === 'reviewing') {
      bus.transitionRun(run.id, 'running')
    }
    const { stillPending } = dispatchPendingSlices(run.id, run.primaryAgentId, revisionSlices, {
      round: nextRound
    })
    checkpoint.pendingSlices = stillPending
  }

  async function stepSwarm(runId) {
    let run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    if (!run) return bus.errorResult(404, 'Agent run not found.')
    if (isTerminalRunState(run.state)) {
      return { stepped: false, ...formatBoard(runId) }
    }

    let didWork = false
    const checkpoint = {
      pendingSlices: Array.isArray(run.checkpoint?.pendingSlices) ? [...run.checkpoint.pendingSlices] : [],
      completedSlices: Array.isArray(run.checkpoint?.completedSlices) ? [...run.checkpoint.completedSlices] : [],
      failedSlices: Array.isArray(run.checkpoint?.failedSlices) ? [...run.checkpoint.failedSlices] : [],
      reviewRequested: Boolean(run.checkpoint?.reviewRequested),
      reviewRound: Number(run.checkpoint?.reviewRound ?? 0),
      autoSlicePending: Boolean(run.checkpoint?.autoSlicePending),
      slices: effectiveSlicesFor(run, run.checkpoint),
      selfImprovement: run.checkpoint?.selfImprovement ?? null,
      stepCount: Number(run.checkpoint?.stepCount ?? 0) + 1
    }

    // Phase 0: Optional in-process AI parent auto-slicing when parentMode requested it.
    if (checkpoint.autoSlicePending) {
      await runParentAutoSlice(run, checkpoint)
      didWork = true
      run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    }

    // Phase A: Dispatch any pending slices whose provider slot opened up.
    if (checkpoint.pendingSlices.length > 0) {
      const dispatchable = checkpoint.pendingSlices.filter((slice) => !slice.dispatchError)
      const errored = checkpoint.pendingSlices.filter((slice) => slice.dispatchError)
      const { stillPending, dispatched } = dispatchPendingSlices(
        runId,
        run.primaryAgentId,
        dispatchable,
        { round: checkpoint.reviewRound }
      )
      checkpoint.pendingSlices = [...stillPending, ...errored]
      if (dispatched > 0) {
        didWork = true
        run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
      }
    }

    // Phase B: Run all ready workers and the parallel self-improvement lane together.
    const workers = run.agents.filter((agent) => agent.role === 'worker')
    const readyWorkers = workers.filter((worker) =>
      run.messages.some((message) => message.toAgentId === worker.id && message.state === 'queued')
    )
    const selfImproveTask = run.plan?.selfImprove !== false
      ? Promise.resolve().then(() => buildParallelSelfImprovement(run, checkpoint))
      : Promise.resolve(checkpoint.selfImprovement)
    if (readyWorkers.length > 0) {
      didWork = true
      const [parallelAudit] = await Promise.all([
        selfImproveTask,
        ...readyWorkers.map(async (worker) => {
          const claimed = bus.claimInbox({ agentId: worker.id, runId, limit: 10 })
          for (const message of claimed.messages ?? []) {
            await runWorkerMessage(run, worker, message)
          }
        })
      ])
      checkpoint.selfImprovement = parallelAudit
    } else if (run.plan?.selfImprove !== false && !checkpoint.selfImprovement) {
      checkpoint.selfImprovement = await selfImproveTask
    }

    // Phase C: Parent inbox processing (results, worker questions, errors, verdicts).
    run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    const parentResult = processParentInbox(run, checkpoint)
    checkpoint.completedSlices = parentResult.completedSlices
    checkpoint.failedSlices = parentResult.failedSlices
    if (parentResult.processed > 0) didWork = true

    if (parentResult.questions.length > 0) {
      const answered = await answerWorkerQuestions(run, parentResult.questions, checkpoint)
      if (answered) didWork = true
      run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    }

    if (parentResult.verdictResult) {
      const { approved, summary } = parentResult.verdictResult
      if (!approved && checkpoint.reviewRound < Number(run.plan?.maxReviewRounds ?? 0)) {
        startRevisionRound(run, checkpoint, parentResult.verdictResult)
        bus.checkpointRun({ agentId: run.primaryAgentId, runId, checkpoint })
        return { stepped: true, ...formatBoard(runId) }
      }
      return finalizeSwarmRun(run, checkpoint, {
        approved,
        summary,
        verdictResult: parentResult.verdictResult
      })
    }

    // After workers finish, try dispatching queued slices that waited on a provider slot.
    if (checkpoint.pendingSlices.length > 0) {
      const dispatchable = checkpoint.pendingSlices.filter((slice) => !slice.dispatchError)
      const errored = checkpoint.pendingSlices.filter((slice) => slice.dispatchError)
      const { stillPending, dispatched } = dispatchPendingSlices(
        runId,
        run.primaryAgentId,
        dispatchable,
        { round: checkpoint.reviewRound }
      )
      checkpoint.pendingSlices = [...stillPending, ...errored]
      if (dispatched > 0) didWork = true
    }

    const totalSlices = effectiveSlicesFor(run, checkpoint).length
    const activeAssignments = database.listActiveAgentAssignments(runId)
    const blockingPending = checkpoint.pendingSlices.filter((slice) => !slice.dispatchError)

    if (
      checkpoint.failedSlices.length > 0 &&
      blockingPending.length === 0 &&
      activeAssignments.length === 0 &&
      checkpoint.completedSlices.length + checkpoint.failedSlices.length >= totalSlices
    ) {
      return finalizeSwarmRun(run, checkpoint, {
        approved: false,
        summary: checkpoint.failedSlices[0]?.error || 'One or more swarm slices failed.'
      })
    }

    if (
      blockingPending.length === 0 &&
      activeAssignments.length === 0 &&
      checkpoint.completedSlices.length >= totalSlices &&
      checkpoint.pendingSlices.length === 0
    ) {
      const currentRun = database.getAgentRun(runId)
      if (!isTerminalRunState(currentRun.state)) {
        if (run.reviewerAgentId && !checkpoint.reviewRequested) {
          if (currentRun.state === 'running') {
            bus.transitionRun(runId, 'reviewing')
          }
          const orderedSlices = checkpoint.completedSlices
            .slice()
            .sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0))
          const roundKey = checkpoint.reviewRound > 0 ? `-r${checkpoint.reviewRound}` : ''
          bus.sendMessage({
            agentId: run.primaryAgentId,
            runId,
            to: 'reviewer',
            kind: 'handoff',
            payload: {
              refs: orderedSlices.map((slice) => `#${slice.seq}`),
              slices: orderedSlices.map(
                (slice) => `#${slice.seq} (${slice.from}, slice ${slice.sliceIndex}): ${slice.summary}`
              ),
              summary: `Review ${orderedSlices.length} completed slice(s).`
            },
            idempotencyKey: `handoff-review-${runId}${roundKey}`,
            correlationId: `review${roundKey}`
          })
          checkpoint.reviewRequested = true
          didWork = true
        } else if (!run.reviewerAgentId) {
          return finalizeSwarmRun(run, checkpoint, {
            approved: true,
            summary: checkpoint.completedSlices
              .map((slice) => `#${slice.seq}: ${slice.summary}`)
              .join('\n')
          })
        }
      }
    }

    // Phase D: Reviewer execution if reviewing and handoff is queued.
    run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
    if (run.state === 'reviewing' && run.reviewerAgentId) {
      const reviewer = run.agents.find((agent) => agent.id === run.reviewerAgentId)
      const hasHandoff = reviewer && run.messages.some(
        (message) => message.toAgentId === reviewer.id && message.state === 'queued'
      )
      if (hasHandoff) {
        didWork = true
        const claimed = bus.claimInbox({ agentId: reviewer.id, runId, limit: 5 })
        for (const message of claimed.messages ?? []) {
          await runReviewerTurn(run, reviewer, message)
        }
        run = bus.getRun(runId, { messageLimit: 500, eventLimit: 500 })
        const verdictCheck = processParentInbox(run, checkpoint)
        checkpoint.completedSlices = verdictCheck.completedSlices
        checkpoint.failedSlices = verdictCheck.failedSlices
        if (verdictCheck.verdictResult) {
          const { approved, summary } = verdictCheck.verdictResult
          if (!approved && checkpoint.reviewRound < Number(run.plan?.maxReviewRounds ?? 0)) {
            startRevisionRound(run, checkpoint, verdictCheck.verdictResult)
            bus.checkpointRun({ agentId: run.primaryAgentId, runId, checkpoint })
            return { stepped: true, ...formatBoard(runId) }
          }
          return finalizeSwarmRun(run, checkpoint, {
            approved,
            summary,
            verdictResult: verdictCheck.verdictResult
          })
        }
      }
    }

    if (!isTerminalRunState(database.getAgentRun(runId).state)) {
      bus.checkpointRun({ agentId: run.primaryAgentId, runId, checkpoint })
    }
    return { stepped: didWork, ...formatBoard(runId) }
  }

  async function executeSwarm(runId, { maxSteps = 10, trackJob = true } = {}) {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(maxSteps) || 10)))
    let latest = formatBoard(runId)
    if (!latest) return bus.errorResult(404, 'Agent run not found.')

    let steps = 0
    const runLoop = async ({ signal, onPhase } = {}) => {
      while (!signal?.aborted && steps < limit && !isTerminalRunState(latest.state)) {
        onPhase?.(`step ${steps + 1}`)
        const result = await stepSwarm(runId)
        if (result?.error) return result
        steps += 1
        latest = result
        if (!result.stepped) break
      }
      if (signal?.aborted && !isTerminalRunState(latest.state)) {
        bus.cancelRun({ runId, reason: 'Cancelled via job store.' })
        latest = formatBoard(runId)
      }
      return latest
    }

    if (jobStore && typeof jobStore.submit === 'function' && trackJob !== false) {
      const leadAgent = latest.agents?.find((agent) => agent.role === 'worker') ?? latest.agents?.[0]
      const job = jobStore.submit({
        model: leadAgent?.model || 'swarm',
        backend: leadAgent?.backend || 'swarm',
        title: latest.title || 'Swarm run',
        ...(latest.taskId !== null && latest.taskId !== undefined ? { taskId: latest.taskId } : {}),
        runner: async ({ signal, onPhase }) => {
          const outcome = await runLoop({ signal, onPhase })
          if (outcome?.error?.status) {
            const err = new Error(outcome.error.body?.error || 'Swarm execution failed.')
            err.status = outcome.error.status
            throw err
          }
          return outcome?.result?.summary || outcome?.error || outcome?.state || 'done'
        }
      })
      const settled = await jobStore.wait(job.id)
      const board = formatBoard(runId)
      if (settled.state === 'error' && !isTerminalRunState(board?.state)) {
        return bus.errorResult(settled.status || 502, settled.error || 'Swarm execution failed.')
      }
      return { steps, ...board, jobId: job.id }
    }

    const loopOutcome = await runLoop()
    if (loopOutcome?.error?.status) return loopOutcome
    return { steps, ...formatBoard(runId) }
  }

  return {
    planSwarm,
    createSwarm,
    stepSwarm,
    executeSwarm,
    formatBoard
  }
}

// Objective: Detect workspace gaps and improvement opportunities deterministically, without spending model quota.
// Requirements: Sensors read one immutable snapshot and never call a model or a provider; finding keys stay stable across scans so lifecycle state survives; thresholds come from configuration; every detector is independently testable.
// Decisions: One registry of pure detect(snapshot) functions behind buildWorkspaceSnapshot() keeps detection separate from persistence and from the API/CLI; the snapshot carries only data plus local filesystem checks, so the same rules run in the API and in scripts; aggregated detectors report a count and a bounded sample instead of one finding per file to keep the queue actionable.
// Relevant Files: apps/api/src/workspaceSensors.js, apps/api/src/db/sensors.js, apps/api/src/routes/sensors.js, apps/api/src/providerQuota.js, apps/api/src/modelBudget.js
// Important Context: User file. Zero-token control plane: findings complement, but never replace, model-generated proposals.
import { existsSync } from 'node:fs'
import { modelQuotaProfiles } from './modelRegistry.js'
import { resolveQuotaProfiles } from './modelBudget.js'
import { providerSnapshots, quotaScopeForModel } from './providerQuota.js'

export const SENSOR_SEVERITIES = Object.freeze(['low', 'medium', 'high'])
export const SENSOR_DEFAULTS = Object.freeze({
  staleTaskHours: 72,
  staleRunHours: 24,
  sampleLimit: 10
})

const NON_TERMINAL_RUN_STATES = new Set([
  'draft', 'planning', 'dispatching', 'running', 'reviewing'
])
const ACTIVE_TASK_STATUSES = new Set(['todo', 'in_progress', 'blocked'])
const HOUR_MS = 60 * 60 * 1000

function readNumber(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}.`)
  }
  return value
}

export function resolveSensorConfig({ env = process.env } = {}) {
  const staleTaskHours = readNumber(
    env, 'SENSOR_STALE_TASK_HOURS', SENSOR_DEFAULTS.staleTaskHours, { max: 24 * 365 }
  )
  const staleRunHours = readNumber(
    env, 'SENSOR_STALE_RUN_HOURS', SENSOR_DEFAULTS.staleRunHours, { max: 24 * 365 }
  )
  const sampleLimit = Math.floor(readNumber(
    env, 'SENSOR_SAMPLE_LIMIT', SENSOR_DEFAULTS.sampleLimit, { min: 1, max: 100 }
  ))
  return {
    staleTaskHours,
    staleRunHours,
    sampleLimit,
    staleTaskMs: staleTaskHours * HOUR_MS,
    staleRunMs: staleRunHours * HOUR_MS
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function ageMs(iso, now) {
  const at = typeof iso === 'number' ? iso : Date.parse(String(iso ?? ''))
  return Number.isFinite(at) ? Math.max(0, now - at) : null
}

function hours(ms) {
  return Math.round((ms / HOUR_MS) * 10) / 10
}

function safePathExists(pathExists, path) {
  if (typeof path !== 'string' || path.trim() === '') return false
  try {
    return Boolean(pathExists(path))
  } catch {
    return false
  }
}

function finding(sensorId, {
  key,
  severity = 'medium',
  title,
  summary,
  entityType = '',
  entityId = '',
  details = {}
}) {
  return {
    key: `${sensorId}:${key}`,
    sensorId,
    severity: SENSOR_SEVERITIES.includes(severity) ? severity : 'medium',
    title,
    summary,
    entity: { type: entityType, id: String(entityId) },
    details
  }
}

function normalizeTitle(value) {
  return text(value).replace(/\s+/g, ' ').toLowerCase()
}

function sample(values, limit) {
  return values.slice(0, limit)
}

export function buildWorkspaceSnapshot({
  database,
  models = [],
  modelBudget,
  now = Date.now(),
  env = process.env,
  pathExists = existsSync,
  thresholds = resolveSensorConfig({ env })
} = {}) {
  if (!database) throw new Error('buildWorkspaceSnapshot requires a database.')

  const tasks = database.listTasks()
  const agentRuns = database.listAgentRuns({ limit: 500 })
  const agentRunUsage = {}
  for (const run of agentRuns) {
    if (NON_TERMINAL_RUN_STATES.has(run.state)) {
      agentRunUsage[run.id] = database.getAgentRunUsage(run.id)
    }
  }

  const configuredProfiles = resolveQuotaProfiles({
    env,
    profiles: modelQuotaProfiles(Array.isArray(models) ? models : [])
  })
  const modelEntries = (Array.isArray(models) ? models : []).map((model) => {
    const scope = quotaScopeForModel(model)
    let budget
    try {
      budget = typeof modelBudget?.snapshot === 'function'
        ? modelBudget.snapshot(model.id, scope)
        : undefined
    } catch (error) {
      budget = undefined
    }
    return {
      id: model.id,
      label: model.label,
      provider: model.provider,
      billingCategory: model.billingCategory,
      ...(scope ? { scope } : {}),
      configured: configuredProfiles.has(model.id),
      budget
    }
  })

  const repositories = database.listRepositories().map((repository) => ({
    ...repository,
    rootExists: safePathExists(pathExists, repository.rootPath)
  }))
  const gitWorktrees = database.listGitWorktrees().map((worktree) => ({
    ...worktree,
    pathExists: safePathExists(pathExists, worktree.worktreePath)
  }))

  return {
    now,
    generatedAt: new Date(now).toISOString(),
    thresholds,
    tasks,
    agentRuns,
    agentRunUsage,
    models: modelEntries,
    providers: providerSnapshots({
      models: Array.isArray(models) ? models : [],
      modelBudget
    }),
    tools: database.listTools(),
    environments: database.listEnvironments(),
    repositories,
    gitWorktrees,
    userFiles: database.listUserFiles(),
    folders: database.listFolders(),
    agentScripts: database.listAgentScripts({ limit: 500 }),
    mcpServers: database.listMcpServers()
  }
}

// One detector per gap. Each returns zero or more findings; keys are stable for
// the same entity so a rescan updates the same row instead of duplicating it.
export const SENSORS = Object.freeze([
  {
    id: 'task.blocked_without_reason',
    title: 'Blocked task has no reason',
    description: 'A blocked task should record why it is blocked in work_blocked.',
    category: 'tasks',
    defaultSeverity: 'high',
    detect(snapshot) {
      const found = []
      for (const task of snapshot.tasks) {
        if (task.status !== 'blocked' || text(task.work_blocked)) continue
        found.push(finding('task.blocked_without_reason', {
          key: `task:${task.id}`,
          severity: 'high',
          title: 'Blocked task has no reason',
          summary: `Task #${task.id} "${task.title}" is blocked but work_blocked is empty.`,
          entityType: 'task',
          entityId: task.id,
          details: { taskId: task.id, status: task.status, priority: task.priority }
        }))
      }
      return found
    }
  },
  {
    id: 'task.missing_next_move',
    title: 'Active task has no next move',
    description: 'Blocked and in-progress tasks should name the next concrete step.',
    category: 'tasks',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const task of snapshot.tasks) {
        if (!['blocked', 'in_progress'].includes(task.status) || text(task.next_move)) continue
        found.push(finding('task.missing_next_move', {
          key: `task:${task.id}`,
          severity: task.status === 'blocked' ? 'high' : 'medium',
          title: 'Active task has no next move',
          summary: `Task #${task.id} "${task.title}" is ${task.status.replace('_', ' ')} without a next_move.`,
          entityType: 'task',
          entityId: task.id,
          details: { taskId: task.id, status: task.status }
        }))
      }
      return found
    }
  },
  {
    id: 'task.stale_in_progress',
    title: 'In-progress task is stale',
    description: 'An in-progress task that has not changed for the configured window may be abandoned.',
    category: 'tasks',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const task of snapshot.tasks) {
        if (task.status !== 'in_progress') continue
        const age = ageMs(task.updated_at, snapshot.now)
        if (age === null || age < snapshot.thresholds.staleTaskMs) continue
        found.push(finding('task.stale_in_progress', {
          key: `task:${task.id}`,
          severity: 'medium',
          title: 'In-progress task is stale',
          summary: `Task #${task.id} "${task.title}" has been in progress for ${hours(age)}h without an update.`,
          entityType: 'task',
          entityId: task.id,
          details: {
            taskId: task.id,
            ageHours: hours(age),
            thresholdHours: snapshot.thresholds.staleTaskHours,
            updatedAt: task.updated_at
          }
        }))
      }
      return found
    }
  },
  {
    id: 'task.duplicate_active_title',
    title: 'Duplicate active task titles',
    description: 'Two or more unfinished tasks share the same title, which hides duplicate work.',
    category: 'tasks',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const groups = new Map()
      for (const task of snapshot.tasks) {
        if (task.status === 'done') continue
        const normalized = normalizeTitle(task.title)
        if (!normalized) continue
        const group = groups.get(normalized) ?? []
        group.push(task)
        groups.set(normalized, group)
      }
      const found = []
      for (const [normalized, tasks] of groups) {
        if (tasks.length < 2) continue
        const taskIds = tasks.map((task) => task.id).sort((a, b) => a - b)
        found.push(finding('task.duplicate_active_title', {
          key: normalized.slice(0, 200),
          severity: 'medium',
          title: 'Duplicate active task titles',
          summary: `${tasks.length} unfinished tasks share the title "${tasks[0].title}".`,
          entityType: 'task_title',
          entityId: normalized.slice(0, 200),
          details: { normalizedTitle: normalized, taskIds, count: tasks.length }
        }))
      }
      return found
    }
  },
  {
    id: 'agent_run.stale',
    title: 'Agent run is stale',
    description: 'A non-terminal agent run that has not changed for the configured window may be orphaned.',
    category: 'agents',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const run of snapshot.agentRuns) {
        if (!NON_TERMINAL_RUN_STATES.has(run.state)) continue
        const age = ageMs(run.updatedAt, snapshot.now)
        if (age === null || age < snapshot.thresholds.staleRunMs) continue
        found.push(finding('agent_run.stale', {
          key: `run:${run.id}`,
          severity: 'medium',
          title: 'Agent run is stale',
          summary: `Run ${run.id} has been ${run.state} for ${hours(age)}h without an update.`,
          entityType: 'agent_run',
          entityId: run.id,
          details: {
            runId: run.id,
            state: run.state,
            ageHours: hours(age),
            thresholdHours: snapshot.thresholds.staleRunHours,
            ...(run.taskId !== undefined ? { taskId: run.taskId } : {})
          }
        }))
      }
      return found
    }
  },
  {
    id: 'agent_run.budget_exhausted',
    title: 'Agent run budget is exhausted',
    description: 'A non-terminal run with no remaining tokens, calls, or time cannot make further progress.',
    category: 'agents',
    defaultSeverity: 'high',
    detect(snapshot) {
      const found = []
      for (const run of snapshot.agentRuns) {
        if (!NON_TERMINAL_RUN_STATES.has(run.state)) continue
        const budget = run.budget ?? {}
        const usage = snapshot.agentRunUsage[run.id] ?? {
          calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0
        }
        const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : run.createdAt
        const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, snapshot.now - startedAt) : 0
        const remaining = {
          tokens: Number.isFinite(budget.maxTokens) ? budget.maxTokens - usage.totalTokens : null,
          calls: Number.isFinite(budget.maxCalls) ? budget.maxCalls - usage.calls : null,
          ms: Number.isFinite(budget.maxMs) ? budget.maxMs - elapsedMs : null
        }
        const exhausted = Object.values(remaining).some(
          (value) => value !== null && value <= 0
        )
        if (!exhausted) continue
        found.push(finding('agent_run.budget_exhausted', {
          key: `run:${run.id}`,
          severity: 'high',
          title: 'Agent run budget is exhausted',
          summary: `Run ${run.id} has no remaining ${Object.entries(remaining)
            .filter(([, value]) => value !== null && value <= 0)
            .map(([name]) => name)
            .join(', ')} budget.`,
          entityType: 'agent_run',
          entityId: run.id,
          details: {
            runId: run.id,
            state: run.state,
            budget,
            usage: {
              calls: usage.calls,
              totalTokens: usage.totalTokens,
              durationMs: usage.durationMs
            },
            remaining,
            elapsedMs
          }
        }))
      }
      return found
    }
  },
  {
    id: 'provider.quota_blocked',
    title: 'Provider quota is blocked',
    description: 'Every model in a provider quota domain is exhausted or cooling down.',
    category: 'quota',
    defaultSeverity: 'high',
    detect(snapshot) {
      const found = []
      for (const provider of snapshot.providers) {
        if (provider.ok !== false) continue
        found.push(finding('provider.quota_blocked', {
          key: provider.groupKey,
          severity: 'high',
          title: 'Provider quota is blocked',
          summary: `Provider ${provider.provider} has no available model${
            Number.isFinite(provider.retryAfter) ? `; retry in ${provider.retryAfter}s` : ''
          }.`,
          entityType: 'provider',
          entityId: provider.groupKey,
          details: {
            groupKey: provider.groupKey,
            provider: provider.provider,
            modelCount: provider.modelCount,
            ...(Number.isFinite(provider.retryAfter) ? { retryAfter: provider.retryAfter } : {}),
            models: provider.models.map((model) => ({
              id: model.id,
              ok: model.ok,
              headroom: model.headroom,
              ...(model.retryAfter !== undefined ? { retryAfter: model.retryAfter } : {})
            }))
          }
        }))
      }
      return found
    }
  },
  {
    id: 'model.usage_without_profile',
    title: 'Model has usage but no quota profile',
    description: 'Observed requests exist for a model whose reset limits are not configured.',
    category: 'quota',
    defaultSeverity: 'low',
    detect(snapshot) {
      const found = []
      for (const model of snapshot.models) {
        const budget = model.budget
        if (!budget || model.configured) continue
        const observed = Number(budget.observed?.requests ?? 0)
        const limiters = Array.isArray(budget.limiters) ? budget.limiters.length : 0
        if (observed <= 0 || limiters > 0) continue
        found.push(finding('model.usage_without_profile', {
          key: model.id,
          severity: 'low',
          title: 'Model has usage but no quota profile',
          summary: `${model.label ?? model.id} has ${observed} observed request(s) but no configured quota profile.`,
          entityType: 'model',
          entityId: model.id,
          details: {
            model: model.id,
            provider: model.provider,
            observedRequests: observed,
            ...(budget.observed?.cap !== undefined ? { learnedCap: budget.observed.cap } : {})
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tool.unavailable',
    title: 'Tracked tool is unavailable',
    description: 'A workflow tool that the workspace tracks cannot currently be resolved.',
    category: 'tracking',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const tool of snapshot.tools) {
        if (tool.available) continue
        found.push(finding('tool.unavailable', {
          key: tool.name,
          severity: 'medium',
          title: 'Tracked tool is unavailable',
          summary: `Tool ${tool.name} is tracked but unavailable (expected command: ${tool.command}).`,
          entityType: 'tool',
          entityId: tool.name,
          details: { name: tool.name, command: tool.command, checkedAt: tool.checkedAt }
        }))
      }
      return found
    }
  },
  {
    id: 'mcp.server_error',
    title: 'MCP server reports an error',
    description: 'A discovered MCP server has a non-empty status error.',
    category: 'tracking',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const server of snapshot.mcpServers) {
        if (!text(server.statusError)) continue
        found.push(finding('mcp.server_error', {
          key: server.name,
          severity: 'medium',
          title: 'MCP server reports an error',
          summary: `MCP server ${server.name} reports: ${server.statusError}`,
          entityType: 'mcp_server',
          entityId: server.name,
          details: {
            name: server.name,
            status: server.status,
            statusError: server.statusError,
            lastSeenAt: server.lastSeenAt
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.file_missing',
    title: 'Tracked file is missing on disk',
    description: 'A tracked user file disappeared from its repository but keeps its history row.',
    category: 'tracking',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const byRepository = new Map()
      for (const file of snapshot.userFiles) {
        if (!file.missingAt) continue
        const group = byRepository.get(file.repositoryId) ?? []
        group.push(file)
        byRepository.set(file.repositoryId, group)
      }
      const found = []
      for (const [repositoryId, files] of byRepository) {
        found.push(finding('tracking.file_missing', {
          key: `repo:${repositoryId}`,
          severity: 'medium',
          title: 'Tracked files are missing on disk',
          summary: `${files.length} tracked file(s) in repository ${repositoryId} are missing on disk.`,
          entityType: 'repository',
          entityId: repositoryId,
          details: {
            repositoryId,
            count: files.length,
            sample: sample(files, snapshot.thresholds.sampleLimit).map((file) => ({
              id: file.id,
              path: file.path,
              missingAt: file.missingAt
            }))
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.files_without_objective',
    title: 'Tracked files have no objective',
    description: 'Files without an objective cannot guide AI work or review.',
    category: 'tracking',
    defaultSeverity: 'low',
    detect(snapshot) {
      const byRepository = new Map()
      for (const file of snapshot.userFiles) {
        if (file.missingAt || text(file.objective)) continue
        const group = byRepository.get(file.repositoryId) ?? []
        group.push(file)
        byRepository.set(file.repositoryId, group)
      }
      const found = []
      for (const [repositoryId, files] of byRepository) {
        found.push(finding('tracking.files_without_objective', {
          key: `repo:${repositoryId}`,
          severity: 'low',
          title: 'Tracked files have no objective',
          summary: `${files.length} tracked file(s) in repository ${repositoryId} have no objective.`,
          entityType: 'repository',
          entityId: repositoryId,
          details: {
            repositoryId,
            count: files.length,
            sample: sample(files, snapshot.thresholds.sampleLimit).map((file) => ({
              id: file.id,
              path: file.path
            }))
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.folders_without_objective',
    title: 'Tracked folders have no objective',
    description: 'Folders without an objective have no stated purpose for agents or reviewers.',
    category: 'tracking',
    defaultSeverity: 'low',
    detect(snapshot) {
      const byRepository = new Map()
      for (const folder of snapshot.folders) {
        if (text(folder.objective)) continue
        const group = byRepository.get(folder.repositoryId) ?? []
        group.push(folder)
        byRepository.set(folder.repositoryId, group)
      }
      const found = []
      for (const [repositoryId, folders] of byRepository) {
        found.push(finding('tracking.folders_without_objective', {
          key: `repo:${repositoryId}`,
          severity: 'low',
          title: 'Tracked folders have no objective',
          summary: `${folders.length} tracked folder(s) in repository ${repositoryId} have no objective.`,
          entityType: 'repository',
          entityId: repositoryId,
          details: {
            repositoryId,
            count: folders.length,
            sample: sample(folders, snapshot.thresholds.sampleLimit).map((folder) => ({
              id: folder.id,
              path: folder.path
            }))
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.repository_root_missing',
    title: 'Repository root is missing',
    description: 'A registered repository root no longer exists on disk, so scans skip it.',
    category: 'tracking',
    defaultSeverity: 'high',
    detect(snapshot) {
      const found = []
      for (const repository of snapshot.repositories) {
        if (repository.rootExists) continue
        found.push(finding('tracking.repository_root_missing', {
          key: `repo:${repository.id}`,
          severity: 'high',
          title: 'Repository root is missing',
          summary: `Repository ${repository.name} points at a missing root: ${repository.rootPath}`,
          entityType: 'repository',
          entityId: repository.id,
          details: {
            repositoryId: repository.id,
            name: repository.name,
            rootPath: repository.rootPath
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.worktree_missing',
    title: 'Git worktree is missing',
    description: 'A tracked worktree path no longer exists, which breaks task isolation assumptions.',
    category: 'tracking',
    defaultSeverity: 'medium',
    detect(snapshot) {
      const found = []
      for (const worktree of snapshot.gitWorktrees) {
        if (worktree.pathExists) continue
        found.push(finding('tracking.worktree_missing', {
          key: `worktree:${worktree.id}`,
          severity: 'medium',
          title: 'Git worktree is missing',
          summary: `Worktree ${worktree.worktreePath} no longer exists on disk.`,
          entityType: 'git_worktree',
          entityId: worktree.id,
          details: {
            worktreeId: worktree.id,
            repositoryId: worktree.repositoryId,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.script_unverified',
    title: 'Registered script is unverified',
    description: 'A deterministic script should be verified before agents rely on it.',
    category: 'tracking',
    defaultSeverity: 'low',
    detect(snapshot) {
      const found = []
      for (const script of snapshot.agentScripts) {
        if (script.verifiedAt !== undefined) continue
        found.push(finding('tracking.script_unverified', {
          key: `script:${script.id}`,
          severity: 'low',
          title: 'Registered script is unverified',
          summary: `Script ${script.name} has never been verified.`,
          entityType: 'agent_script',
          entityId: script.id,
          details: {
            scriptId: script.id,
            name: script.name,
            intent: script.intent,
            version: script.version,
            costClass: script.costClass
          }
        }))
      }
      return found
    }
  },
  {
    id: 'tracking.empty_domain',
    title: 'Tracking domain is empty',
    description: 'An expected tracking domain has no rows, so sensors and agents have no context there.',
    category: 'tracking',
    defaultSeverity: 'low',
    detect(snapshot) {
      const domains = [
        ['repositories', 'repository roots', snapshot.repositories],
        ['user_files', 'tracked files', snapshot.userFiles],
        ['folders', 'tracked folders', snapshot.folders],
        ['git_worktrees', 'Git worktrees', snapshot.gitWorktrees],
        ['tools', 'workflow tools', snapshot.tools],
        ['environments', 'environment facts', snapshot.environments],
        ['agent_scripts', 'registered scripts', snapshot.agentScripts],
        ['mcp_servers', 'MCP servers', snapshot.mcpServers],
        ['agent_runs', 'agent runs', snapshot.agentRuns]
      ]
      return domains
        .filter(([, , rows]) => rows.length === 0)
        .map(([domain, label]) => finding('tracking.empty_domain', {
          key: domain,
          severity: 'low',
          title: 'Tracking domain is empty',
          summary: `The ${label} domain has no rows.`,
          entityType: 'tracking_domain',
          entityId: domain,
          details: { domain, label, count: 0 }
        }))
    }
  }
])

const SEVERITY_RANK = new Map([['high', 0], ['medium', 1], ['low', 2]])

export const SENSOR_CATALOG = Object.freeze(SENSORS.map((sensor) => ({
  id: sensor.id,
  title: sensor.title,
  description: sensor.description,
  category: sensor.category,
  defaultSeverity: sensor.defaultSeverity
})))

export function runSensorScan({ snapshot, sensors = SENSORS } = {}) {
  if (!snapshot) throw new Error('runSensorScan requires a snapshot.')
  const findings = new Map()
  const errors = []
  for (const sensor of sensors) {
    try {
      for (const entry of sensor.detect(snapshot)) {
        findings.set(entry.key, { ...entry, sensorId: sensor.id })
      }
    } catch (error) {
      errors.push({ sensorId: sensor.id, error: error.message })
    }
  }
  const ordered = [...findings.values()].sort((a, b) => {
    const severity = (SEVERITY_RANK.get(a.severity) ?? 1) - (SEVERITY_RANK.get(b.severity) ?? 1)
    if (severity !== 0) return severity
    if (a.sensorId !== b.sensorId) return a.sensorId.localeCompare(b.sensorId)
    return a.key.localeCompare(b.key)
  })
  return { findings: ordered, errors }
}

export function scanWorkspaceSensors({
  database,
  models = [],
  modelBudget,
  now = Date.now(),
  env = process.env,
  pathExists = existsSync,
  sensors = SENSORS
} = {}) {
  const thresholds = resolveSensorConfig({ env })
  const snapshot = buildWorkspaceSnapshot({
    database,
    models,
    modelBudget,
    now,
    env,
    pathExists,
    thresholds
  })
  return { ...runSensorScan({ snapshot, sensors }), snapshot }
}

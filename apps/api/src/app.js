// Objective: Compose the API application from per-domain route groups behind one public entry.
// Requirements: Keep the createApp signature and behavior identical so index.js and the tests never know about the split; resolve the verifier, task worktrees, and MCP discovery lazily so the API works from any cwd inside the repository; turn every mutating request into a tool run.
// Decisions: The shared context (scheduler, job store, metrics, budget) is built here and handed to each group; the repository scope is built once and shared by repositories, files, and folders so scoping cannot drift; the JSON error handler stays with the app because it is cross-group; the request-run middleware enters an AsyncLocalStorage context so events written by async handlers stamp their own request even under concurrency, and finishes the run on response finish or close; MCP discovery resolves the repository root once and passes it as the CLI cwd because the catalog is scoped to the working directory.
// Relevant Files: apps/api/src/app.js, apps/api/src/routes/tasks.js, apps/api/src/routes/aiDrafts.js, apps/api/src/routes/repositories.js, apps/api/src/routes/runs.js, apps/api/src/routes/mcp.js
// Important Context: User file. The composition entry for the API server and the tests.
// Work State: Completed: Split into routes/ group modules as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import express from 'express'
import { execFileSync } from 'node:child_process'
import { createResourceMonitor } from './resourceMonitor.js'
import { createAdaptiveCpuLimit } from './adaptiveCpuLimit.js'
import { createModelRegistry, modelQuotaProfiles } from './modelRegistry.js'
import { createModelScheduler } from './modelScheduler.js'
import { createModelClient } from './modelClient.js'
import { createTaskJobStore } from './taskJobStore.js'
import { createModelMetrics } from './modelMetrics.js'
import { createModelBudget } from './modelBudget.js'
import { createLocalVerifier } from './localVerifier.js'
import { createTaskWorktrees } from './taskWorktrees.js'
import { discoverMcpCatalog } from './mcpDiscovery.js'
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'
import { createVerifyRouter } from './routes/verify.js'
import { createTasksRouter } from './routes/tasks.js'
import { createRepositoryScope, createRepositoriesRouter } from './routes/repositories.js'
import { createFilesRouter } from './routes/files.js'
import { createFoldersRouter } from './routes/folders.js'
import { createGitWorktreesRouter } from './routes/gitWorktrees.js'
import { createToolsRouter } from './routes/tools.js'
import { createEnvironmentsRouter } from './routes/environments.js'
import { createAiSessionsRouter } from './routes/aiSessions.js'
import { createPromptTemplatesRouter } from './routes/promptTemplates.js'
import { createModelsRouter } from './routes/models.js'
import { createAiDraftsRouter } from './routes/aiDrafts.js'
import { createRunsRouter } from './routes/runs.js'
import { createMcpRouter } from './routes/mcp.js'

loadWorkspaceEnv()

const LOCAL_AI_MIN_LOAD = Number(process.env.LOCAL_AI_MIN_LOAD ?? 0.5)
const LOCAL_AI_MAX_LOAD = Number(process.env.LOCAL_AI_MAX_LOAD ?? 1.0)
const LOCAL_AI_MIN_AVAILABLE_MEMORY_MB = Number(process.env.LOCAL_AI_MIN_AVAILABLE_MEMORY_MB ?? 1024)
const LOCAL_AI_MAX_DISK_BUSY_PERCENT = Number(process.env.LOCAL_AI_MAX_DISK_BUSY_PERCENT ?? 30)
const LOCAL_AI_TURN_COOLDOWN_MS = Number(process.env.LOCAL_AI_TURN_COOLDOWN_MS ?? 15000)
const LOCAL_AI_URL = (process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const LOCAL_AI_API_KEY = process.env.LOCAL_AI_API_KEY ?? ''

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
  mcpDiscovery,
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

  // MCP discovery runs from the repository root because the CLI scopes its
  // answer to the working directory, so project-configured servers are
  // visible; the root resolves once on first scan, and tests inject a fake
  // discovery instead of the real CLI. This runs the discovery - the route
  // awaits its result - so an injected option is called directly.
  let mcpRoot = null
  const runMcpDiscovery = () => {
    if (mcpDiscovery) return mcpDiscovery()
    if (mcpRoot === null) {
      mcpRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim()
    }
    return discoverMcpCatalog({ cwd: mcpRoot })
  }

  const repositoryScope = createRepositoryScope(database)

  app.use(express.json({ limit: '16kb' }))

  // Every mutating request becomes a tool run, and its context propagates
  // through the route handlers (including awaits), so the activity events
  // it writes point at the request that produced them. Concurrent requests
  // each carry their own run. The run finishes when the response settles.
  app.use((request, response, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next()
    const path = request.originalUrl.split('?')[0]
    const run = database.startToolRun({ kind: 'api', label: `${request.method} ${path}` })
    database.enterToolRun(run)
    const finish = () => database.finishToolRun(run.id)
    response.on('finish', finish)
    response.on('close', finish)
    next()
  })

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'api', database: 'sqlite' })
  })

  app.use(createVerifyRouter({ getVerifier }))
  app.use(createTasksRouter({ database, jobStore, getTaskWorktrees }))
  app.use(createModelsRouter({ models, modelMetrics, modelBudget, scheduler, opencodeRosterCache }))
  app.use(createAiDraftsRouter({ database, jobStore, scheduler, modelClient, modelMetrics, modelBudget }))
  app.use(createRepositoriesRouter({ database, repositoryScope }))
  app.use(createFilesRouter({ database, repositoryScope }))
  app.use(createFoldersRouter({ database, repositoryScope }))
  app.use(createGitWorktreesRouter({ database }))
  app.use(createToolsRouter({ database }))
  app.use(createEnvironmentsRouter({ database }))
  app.use(createMcpRouter({ database, discoverMcp: runMcpDiscovery }))
  app.use(createAiSessionsRouter({ database }))
  app.use(createPromptTemplatesRouter({ database }))
  app.use(createRunsRouter({ database }))

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

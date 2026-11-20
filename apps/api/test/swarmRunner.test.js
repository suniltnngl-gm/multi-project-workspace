import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { createAgentBus } from '../src/agentBus.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { createModelBudget, resolveQuotaProfiles } from '../src/modelBudget.js'
import { ModelCallError } from '../src/modelClient.js'
import { createModelMetrics } from '../src/modelMetrics.js'
import { createModelRegistry, modelQuotaProfiles } from '../src/modelRegistry.js'
import { createModelScheduler } from '../src/modelScheduler.js'
import { buildSwarmRoster, planAgentDispatch, resolveAgentModel } from '../src/providerQuota.js'
import { createSwarmRunner } from '../src/swarmRunner.js'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

function makeSampleModels() {
  return [
    {
      id: 'local-0.5b',
      label: 'Qwen2.5-0.5B',
      provider: 'local',
      backend: 'http',
      limitKind: 'resource',
      billingCategory: 'free',
      callable: true,
      autoSelect: true,
      remote: false,
      priority: 10
    },
    {
      id: 'local-1.5b',
      label: 'Qwen2.5-Coder 1.5B',
      provider: 'local',
      backend: 'http',
      limitKind: 'resource',
      billingCategory: 'free',
      callable: true,
      autoSelect: true,
      remote: false,
      priority: 20
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      provider: 'opencode',
      backend: 'opencode-cli',
      limitKind: 'provider_model',
      billingCategory: 'free',
      callable: true,
      autoSelect: true,
      remote: true,
      priority: 50,
      cli: { command: 'opencode', model: 'opencode/qwen3.6-plus-free' }
    },
    {
      id: 'colab-3b',
      label: 'Colab 3B',
      provider: 'colab',
      backend: 'colab-cli',
      limitKind: 'compute_utilization',
      billingCategory: 'free',
      callable: true,
      autoSelect: true,
      remote: true,
      priority: 40
    },
    {
      id: 'kaggle-3b',
      label: 'Kaggle 3B',
      provider: 'kaggle',
      backend: 'kaggle-cli',
      limitKind: 'compute_utilization',
      billingCategory: 'free',
      callable: true,
      autoSelect: true,
      remote: true,
      priority: 30
    },
    {
      id: 'agy',
      label: 'Antigravity CLI',
      provider: 'agy',
      backend: 'agy-cli',
      limitKind: 'provider_model',
      billingCategory: 'subscription',
      callable: true,
      autoSelect: true,
      remote: true,
      priority: 60,
      cli: { command: 'agy', model: 'gemini-2.5-flash' }
    }
  ]
}

let tempDir
let database

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'workspace-swarm-test-'))
  database = createDatabase(join(tempDir, 'swarm.sqlite'), {
    artifactDir: join(tempDir, 'artifacts')
  })
})

after(async () => {
  database?.close()
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

test('buildSwarmRoster and planSwarm distribute workers across distinct quota domains with headroom', () => {
  const models = makeSampleModels()
  const now = () => Date.parse('2026-11-13T12:00:00Z')
  const budget = createModelBudget({
    profiles: {
      'opencode@opencode/qwen3.6-plus-free': [{ unit: 'requests', limit: 1, window: 'day', reset: 'fixed' }],
      'opencode@opencode/minimax-m2.5-free': [{ unit: 'requests', limit: 10, window: 'day', reset: 'fixed' }],
      'colab-3b': [{ unit: 'requests', limit: 10, window: 'day', reset: 'fixed' }]
    },
    now
  })
  // Exhaust qwen3.6-plus-free so the roster skips it and picks healthy domains.
  budget.record('opencode', 1, 'opencode/qwen3.6-plus-free')

  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 3,
    includeReviewer: true,
    opencodeModels: ['opencode/qwen3.6-plus-free', 'opencode/minimax-m2.5-free']
  })

  assert.equal(roster.parent.name, 'parent')
  assert.equal(roster.parent.model, 'local-0.5b')
  assert.equal(roster.reviewer.name, 'reviewer')
  assert.equal(roster.workers.length, 3)

  const workerDomains = new Set(roster.workers.map((worker) => worker.groupKey))
  assert.equal(workerDomains.size, 3)
  assert.ok(!roster.workers.some((worker) => worker.model === 'opencode@opencode/qwen3.6-plus-free'))
  assert.ok(roster.workers.some((worker) => worker.model === 'opencode@opencode/minimax-m2.5-free'))
  assert.ok(roster.workers.some((worker) => worker.model === 'colab-3b'))

  const bus = createAgentBus({ database, models, modelBudget: budget })
  const runner = createSwarmRunner({ database, bus, models, modelBudget: budget })
  const plan = runner.planSwarm({
    objective: 'Refactor parser; Add unit tests; Update docs',
    opencodeModels: ['opencode/qwen3.6-plus-free', 'opencode/minimax-m2.5-free']
  })

  assert.equal(plan.slices.length, 3)
  assert.equal(plan.quotaSummary.parentModelCalls, 0)
  assert.equal(plan.quotaSummary.distinctProviderDomains, 3)
  assert.ok(plan.quotaSummary.byLimitKind.provider_model >= 1)
  assert.ok(plan.quotaSummary.byLimitKind.compute_utilization >= 1)
  assert.ok(plan.quotaSummary.byLimitKind.resource >= 1)
  assert.equal(plan.dispatchPlan.ok, true)

  // Verify resolveAgentModel keeps scoped planAgentDispatch isolated per scope.
  const dispatch = planAgentDispatch({
    models,
    modelBudget: budget,
    agents: [
      { role: 'worker', name: 'w1', model: 'opencode@opencode/qwen3.6-plus-free' },
      { role: 'worker', name: 'w2', model: 'opencode@opencode/minimax-m2.5-free' }
    ]
  })
  assert.equal(dispatch.agents[0].ok, false)
  assert.equal(dispatch.agents[1].ok, true)
  assert.equal(resolveAgentModel(models, 'opencode@opencode/minimax-m2.5-free').cli.model, 'opencode/minimax-m2.5-free')
})

test('createSwarm and executeSwarm run parallel workers with isolated sessionKey, delta #seq refs, and reviewer verdict', async () => {
  const models = makeSampleModels()
  const calls = []
  const budget = createModelBudget({ repository: database, profiles: {} })
  const bus = createAgentBus({ database, models, modelBudget: budget })

  const modelClient = {
    async complete(model, request) {
      calls.push({
        modelId: model.id,
        sessionKey: request.sessionKey,
        prompt: request.messages.map((m) => m.content).join('\n')
      })
      request.onUsage?.({ promptTokens: 15, completionTokens: 10, totalTokens: 25 })
      const userPrompt = request.messages.at(-1).content
      if (userPrompt.includes('[handoff]')) {
        return JSON.stringify({ approved: true, summary: 'Verified all slice diffs.' })
      }
      if (userPrompt.includes('long-output')) {
        return 'Detailed output: ' + 'x'.repeat(600)
      }
      return JSON.stringify({
        summary: `Completed (${model.id})`,
        status: 'done',
        details: 'All good.'
      })
    }
  }

  const runner = createSwarmRunner({ database, bus, models, modelClient, modelBudget: budget })
  const created = runner.createSwarm({
    title: 'Parallel Swarm',
    objective: 'Build API route; Build long-output tests',
    models: ['opencode@opencode/minimax-m2.5-free', 'colab-3b']
  })
  assert.equal(created.state, 'running')
  assert.equal(created.board.length, 2)
  assert.equal(created.board[0].from, '@parent')
  assert.equal(created.board[0].kind, 'assign')

  const finished = await runner.executeSwarm(created.runId, { maxSteps: 10 })
  assert.equal(finished.state, 'completed')

  // Only 2 worker calls + 1 reviewer call; 0 calls from parent coordinator.
  assert.equal(calls.length, 3)
  const workerCalls = calls.filter((entry) => entry.prompt.includes('[assign]'))
  assert.equal(workerCalls.length, 2)
  assert.notEqual(workerCalls[0].sessionKey, workerCalls[1].sessionKey)
  assert.ok(workerCalls[0].prompt.includes('#1 [assign]'))
  assert.ok(workerCalls[1].prompt.includes('#2 [assign]'))

  const reviewerCall = calls.find((entry) => entry.prompt.includes('[handoff]'))
  assert.ok(reviewerCall.prompt.includes('[handoff]'))
  assert.ok(reviewerCall.prompt.includes('#3'))
  assert.ok(reviewerCall.prompt.includes('#4'))

  const kinds = finished.board.map((entry) => entry.kind)
  assert.deepEqual(kinds, ['assign', 'assign', 'result', 'result', 'handoff', 'verdict'])
  assert.equal(finished.board.find((entry) => entry.artifactRefs.length > 0).artifactRefs.length, 1)
  assert.equal(finished.usage.calls, 3)
  assert.equal(finished.usage.totalTokens, 75)
})

test('createSwarm without reviewer completes deterministically after worker slices finish', async () => {
  const models = makeSampleModels()
  let callCount = 0
  const budget = createModelBudget({ repository: database, profiles: {} })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  const modelClient = {
    async complete(_model, request) {
      callCount += 1
      request.onUsage?.({ promptTokens: 5, completionTokens: 5, totalTokens: 10 })
      return JSON.stringify({ summary: 'Slice done', status: 'done' })
    }
  }

  const runner = createSwarmRunner({ database, bus, models, modelClient, modelBudget: budget })
  const created = runner.createSwarm({
    objective: 'Slice A; Slice B',
    includeReviewer: false,
    models: ['colab-3b', 'local-1.5b']
  })
  assert.ok(!created.agents.some((agent) => agent.role === 'reviewer'))

  const executed = await runner.executeSwarm(created.runId)
  assert.equal(executed.state, 'completed')
  assert.equal(callCount, 2)
  assert.deepEqual(executed.board.map((entry) => entry.kind), ['assign', 'assign', 'result', 'result'])
})

test('worker 429 cannot switch outside the explicit model allowlist', async () => {
  const models = makeSampleModels()
  let nowMs = Date.parse('2026-11-13T12:00:00Z')
  const budget = createModelBudget({
    repository: database,
    profiles: {},
    now: () => nowMs
  })
  const bus = createAgentBus({ database, models, modelBudget: budget, now: () => nowMs })
  const attemptedModels = []

  const modelClient = {
    async complete(model, request) {
      attemptedModels.push(model.id)
      if (model.id === 'opencode@opencode/minimax-m2.5-free') {
        throw new ModelCallError('Rate limited upstream', 429, { retryAfter: 120 })
      }
      request.onUsage?.({ promptTokens: 8, completionTokens: 7, totalTokens: 15 })
      return JSON.stringify({ summary: `Recovered on ${model.id}`, status: 'done' })
    }
  }

  const runner = createSwarmRunner({
    database,
    bus,
    models,
    modelClient,
    modelBudget: budget,
    fallbackChain: ['colab-3b', 'local-1.5b'],
    now: () => nowMs
  })

  const created = runner.createSwarm({
    objective: 'Fix single module',
    workerCount: 1,
    includeReviewer: false,
    models: ['opencode@opencode/minimax-m2.5-free']
  })
  const executed = await runner.executeSwarm(created.runId)
  assert.equal(executed.state, 'failed')
  assert.deepEqual(attemptedModels, ['opencode@opencode/minimax-m2.5-free'])

  // No cross-provider model switch is recorded when the allowlist excludes it.
  const worker = executed.agents.find((agent) => agent.role === 'worker')
  assert.equal(worker.model, 'opencode@opencode/minimax-m2.5-free')

  // observe429 recorded a cooldown on the throttled scope.
  const throttled = budget.check('opencode', 'opencode/minimax-m2.5-free')
  assert.equal(throttled.ok, false)
  assert.ok(throttled.retryAfter > 0)

  const runDetail = bus.getRun(created.runId)
  assert.ok(!runDetail.events.some((event) => event.type === 'agent_model_switched'))
})

test('HTTP swarm routes and scripts/ai-swarm.mjs CLI work end to end', async () => {
  const models = makeSampleModels()
  const modelClient = {
    async complete(model, request) {
      request.onUsage?.({ promptTokens: 4, completionTokens: 6, totalTokens: 10 })
      return JSON.stringify({ approved: true, summary: `HTTP ok (${model.id})` })
    }
  }

  const app = createApp(database, {
    models,
    modelClient,
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 5
    })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolvePromise, reject) => {
    server.once('listening', resolvePromise)
    server.once('error', reject)
  })

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    const planRes = await fetch(`${baseUrl}/api/agents/swarm/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Check API; Check CLI',
        worker_count: 2,
        include_reviewer: false
      })
    })
    assert.equal(planRes.status, 200)
    const planJson = await planRes.json()
    assert.equal(planJson.slices.length, 2)
    assert.equal(planJson.quotaSummary.parentModelCalls, 0)

    const createRes = await fetch(`${baseUrl}/api/agents/swarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Route task A; Route task B',
        models: ['colab-3b', 'local-1.5b'],
        include_reviewer: false
      })
    })
    assert.equal(createRes.status, 201)
    const createdJson = await createRes.json()
    assert.equal(createdJson.state, 'running')

    const boardRes = await fetch(`${baseUrl}/api/agents/runs/${createdJson.runId}/board`)
    assert.equal(boardRes.status, 200)
    assert.equal((await boardRes.json()).board.length, 2)

    const stepRes = await fetch(`${baseUrl}/api/agents/runs/${createdJson.runId}/step`, {
      method: 'POST'
    })
    assert.equal(stepRes.status, 200)
    const stepped = await stepRes.json()
    assert.equal(stepped.state, 'completed')
    assert.equal(stepped.board.length, 4)

    // Test immediate execute: true creation path too.
    const execCreateRes = await fetch(`${baseUrl}/api/agents/swarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Immediate execute check',
        worker_count: 1,
        include_reviewer: false,
        execute: true
      })
    })
    assert.equal(execCreateRes.status, 201)
    const execCreated = await execCreateRes.json()
    assert.equal(execCreated.state, 'completed')

    // Test POST /api/agents/runs/:id/execute endpoint.
    const executeRes = await fetch(`${baseUrl}/api/agents/runs/${execCreated.runId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_steps: 2 })
    })
    assert.equal(executeRes.status, 200)
    assert.equal((await executeRes.json()).state, 'completed')

    // Test CLI script against an isolated temporary database.
    const cliDb = join(tempDir, 'cli-swarm.sqlite')
    const cliPlan = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'ai-swarm.mjs'),
        'plan',
        'Refactor parser',
        '--slices',
        'Update parser AST;Add unit tests',
        '--database',
        cliDb,
        '--json'
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(cliPlan.status, 0, cliPlan.stderr)
    const parsedCliPlan = JSON.parse(cliPlan.stdout)
    assert.equal(parsedCliPlan.slices.length, 2)
    assert.equal(parsedCliPlan.quotaSummary.parentModelCalls, 0)

    const cliDryRun = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'ai-swarm.mjs'),
        'run',
        'Dry run objective',
        '--slices',
        'One;Two',
        '--no-reviewer',
        '--dry-run',
        '--database',
        cliDb,
        '--json'
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(cliDryRun.status, 0, cliDryRun.stderr)
    const parsedDryRun = JSON.parse(cliDryRun.stdout)
    assert.equal(parsedDryRun.dryRun, true)
    assert.equal(parsedDryRun.includeReviewer, false)

    const strictCliDryRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'run', 'Strict local objective',
        '--models', 'local-1.5b', '--dry-run', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(strictCliDryRun.status, 0, strictCliDryRun.stderr)
    const strictPlan = JSON.parse(strictCliDryRun.stdout)
    assert.ok(strictPlan.agents.every((agent) => agent.model === 'local-1.5b'))
    assert.deepEqual(strictPlan.modelAuthorization.allowedModelIds, ['local-1.5b'])
    assert.ok(strictPlan.fallbackCandidates.every((id) => id === 'local-1.5b'))

    const localOnlyDryRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'run', 'Local only objective',
        '--local-only', '--dry-run', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(localOnlyDryRun.status, 0, localOnlyDryRun.stderr)
    const localOnlyPlan = JSON.parse(localOnlyDryRun.stdout)
    assert.ok(localOnlyPlan.agents.every((agent) => agent.provider === 'local'))

    const contradictoryDryRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'run', 'Contradictory objective',
        '--models', 'local-1.5b', '--reviewer-model', 'gemini-api@gemini-2.5-flash',
        '--dry-run', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.notEqual(contradictoryDryRun.status, 0)
    assert.match(contradictoryDryRun.stderr, /outside the active swarm model allowlist|Dry-run authorization failed/)

    const unknownModelDryRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'run', 'Unknown model objective',
        '--models', 'unknown-model-xyz', '--dry-run', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.notEqual(unknownModelDryRun.status, 0)
    assert.match(unknownModelDryRun.stderr, /Unknown or non-callable model|Dry-run authorization failed/)

    const emptyAllowlistDryRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'run', 'Empty allowlist objective',
        '--models', '', '--dry-run', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.notEqual(emptyAllowlistDryRun.status, 0)
    assert.match(emptyAllowlistDryRun.stderr, /--models requires at least one non-empty model ID/)

    const cliList = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'ai-swarm.mjs'), 'list', '--database', cliDb, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(cliList.status, 0, cliList.stderr)
    assert.deepEqual(JSON.parse(cliList.stdout), [])

    // Test `board` CLI subcommand against the HTTP server's SQLite DB (`swarm.sqlite`).
    const cliBoard = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'ai-swarm.mjs'),
        'board',
        createdJson.runId,
        '--database',
        join(tempDir, 'swarm.sqlite'),
        '--json'
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(cliBoard.status, 0, cliBoard.stderr)
    const parsedCliBoard = JSON.parse(cliBoard.stdout)
    assert.equal(parsedCliBoard.runId, createdJson.runId)
    assert.equal(parsedCliBoard.state, 'completed')
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
})

test('local resource gate busy blocks local-1.5b, switches to healthy fallback, and records metrics', async () => {
  const models = makeSampleModels().map((entry) => (
    entry.remote
      ? entry
      : { ...entry, minAvailableMemoryMb: entry.id === 'local-1.5b' ? 1792 : 1024 }
  ))
  const budget = createModelBudget({
    env: {},
    repository: database,
    profiles: {
      'colab-3b': [{ unit: 'requests', limit: 10, window: 'day', reset: 'fixed' }]
    }
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  const modelMetrics = createModelMetrics()
  const scheduler = createModelScheduler({
    models,
    getResourceMetrics: async () => ({
      loadAverage: 0.2,
      // Below both local-0.5b (1024) and local-1.5b (1792), so both local lanes are busy.
      availableMemoryMb: 900,
      diskBusyPercent: 5
    }),
    getCpuLoadLimit: () => 1,
    minAvailableMemoryMb: 1024,
    maxDiskBusyPercent: 30,
    turnCooldownMs: 0,
    probeModel: async () => ({ ok: true }),
    getModelMetrics: modelMetrics.snapshot,
    getModelBudget: (entry) => budget.check(entry.id, entry.cli?.model)
  })

  const calledModels = []
  const modelClient = {
    async complete(model, request) {
      calledModels.push(model.id)
      request.onUsage?.({ promptTokens: 10, completionTokens: 12, totalTokens: 22 })
      return JSON.stringify({ summary: `Ran safely on ${model.id}`, status: 'done' })
    }
  }

  const runner = createSwarmRunner({
    database,
    bus,
    models,
    modelClient,
    modelBudget: budget,
    scheduler,
    modelMetrics
  })

  const created = runner.createSwarm({
    objective: 'Run local worker slice',
    workerCount: 1,
    includeReviewer: false,
    models: ['local-1.5b', 'colab-3b']
  })
  const executed = await runner.executeSwarm(created.runId)
  assert.equal(executed.state, 'completed')

  // Local models were blocked by the resource gate before calling modelClient.complete.
  assert.ok(!calledModels.includes('local-1.5b'))
  assert.ok(!calledModels.includes('local-0.5b'))
  assert.deepEqual(calledModels, ['colab-3b'])

  const worker = executed.agents.find((agent) => agent.role === 'worker')
  assert.equal(worker.model, 'colab-3b')

  const detail = bus.getRun(created.runId)
  assert.ok(detail.events.some(
    (event) => event.type === 'agent_model_switched'
      && event.data?.fromModel === 'local-1.5b'
      && event.data?.toModel === 'colab-3b'
      && String(event.data?.reason || '').includes('available memory')
  ))
  assert.equal(modelMetrics.snapshot('local-1.5b').failures, 1)
  assert.equal(modelMetrics.snapshot('colab-3b').requests, 1)
  assert.equal(modelMetrics.snapshot('colab-3b').failures, 0)
})

test('swarm hydrates task and worktree, tracks execution in jobStore, and syncs taskOps and proposals', async () => {
  const models = makeSampleModels()
  const worktreePath = join(tempDir, 'linked-worktree-auth')
  const task = database.createTask({
    title: 'Ship v2 auth flow',
    description: 'Implement token refresh and session revocation.',
    acceptance_criteria: '- Refresh token endpoint works\n- Revoke session endpoint works',
    relevant_files: 'apps/api/src/auth.js, apps/api/src/sessions.js'
  })
  database.linkTaskWorktree(task.id, worktreePath)

  const requests = []
  const modelClient = {
    async complete(model, request) {
      const system = request.messages?.[0]?.content ?? ''
      const user = request.messages?.[1]?.content ?? ''
      requests.push({ modelId: model.id, worktreePath: request.worktreePath, system, user })
      request.onUsage?.({ promptTokens: 5, completionTokens: 7, totalTokens: 12 })

      if (system.includes('reviewer')) {
        return JSON.stringify({
          approved: true,
          summary: 'Verified refresh and revoke endpoints.',
          proposals: [
            {
              title: 'Add auth audit log metrics',
              description: 'Track refresh/revoke failure spikes.',
              priority: 'low',
              task_type: 'chore',
              rationale: 'Observability follow-up'
            }
          ]
        })
      }
      if (user.includes('Refresh token endpoint works')) {
        return JSON.stringify({
          summary: 'Added /api/auth/refresh handler',
          status: 'done',
          proposals: [
            {
              title: 'Rotate refresh signing key quarterly',
              description: 'Automate signing key rotation schedule.',
              priority: 'high',
              task_type: 'chore',
              rationale: 'Security hardening discovered during implementation'
            }
          ]
        })
      }
      return JSON.stringify({
        summary: 'Added /api/auth/revoke handler',
        status: 'done'
      })
    }
  }

  const app = createApp(database, {
    models,
    modelClient,
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 5
    })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolvePromise, reject) => {
    server.once('listening', resolvePromise)
    server.once('error', reject)
  })

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    const missingPlanRes = await fetch(`${baseUrl}/api/agents/swarm/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 999999 })
    })
    assert.equal(missingPlanRes.status, 404)

    const planRes = await fetch(`${baseUrl}/api/agents/swarm/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id })
    })
    assert.equal(planRes.status, 200)
    const planJson = await planRes.json()
    assert.equal(planJson.taskId, task.id)
    assert.equal(planJson.worktreePath, worktreePath)
    assert.equal(planJson.slices.length, 2)
    assert.ok(planJson.title.includes('Ship v2 auth flow'))
    assert.deepEqual(planJson.slices[0].files, ['apps/api/src/auth.js', 'apps/api/src/sessions.js'])

    const createRes = await fetch(`${baseUrl}/api/agents/swarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: task.id,
        execute: true,
        complete_task: true
      })
    })
    assert.equal(createRes.status, 201)
    const executed = await createRes.json()
    assert.equal(executed.state, 'completed')
    assert.equal(executed.taskId, task.id)
    assert.equal(executed.worktreePath, worktreePath)
    assert.ok(executed.jobId)
    assert.ok(requests.length >= 3)
    assert.ok(requests.every((entry) => entry.worktreePath === worktreePath))

    const jobRes = await fetch(`${baseUrl}/api/local-ai/jobs/${executed.jobId}`)
    assert.equal(jobRes.status, 200)
    const jobJson = await jobRes.json()
    assert.equal(jobJson.state, 'done')
    assert.equal(jobJson.taskId, task.id)

    const jobsList = await (await fetch(`${baseUrl}/api/local-ai/jobs`)).json()
    assert.ok(jobsList.some((entry) => entry.id === executed.jobId))

    const updatedTask = database.getTask(task.id)
    assert.equal(updatedTask.status, 'done')
    assert.ok(updatedTask.work_completed.includes('Added /api/auth/refresh handler'))
    assert.ok(updatedTask.work_completed.includes('Added /api/auth/revoke handler'))

    const proposals = database.listTaskProposals()
    assert.ok(proposals.some((entry) => entry.title === 'Rotate refresh signing key quarterly'))
    assert.ok(proposals.some((entry) => entry.title === 'Add auth audit log metrics'))
    assert.ok(Array.isArray(executed.taskOps) && executed.taskOps.length >= 3)

    // Verify scripts/ai-swarm.mjs supports --task without positional objective and new hook flags.
    const cliTaskDbPath = join(tempDir, 'cli-task-swarm.sqlite')
    const cliTaskDb = createDatabase(cliTaskDbPath)
    const cliTask = cliTaskDb.createTask({
      title: 'CLI task hydration',
      acceptance_criteria: '- Slice alpha\n- Slice beta'
    })
    cliTaskDb.close()

    const cliTaskRun = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'ai-swarm.mjs'),
        'run',
        '--task',
        String(cliTask.id),
        '--parent-mode',
        'ai',
        '--review-rounds',
        '1',
        '--complete-task',
        '--dry-run',
        '--database',
        cliTaskDbPath,
        '--json'
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    assert.equal(cliTaskRun.status, 0, cliTaskRun.stderr)
    const parsedCliTaskRun = JSON.parse(cliTaskRun.stdout)
    assert.equal(parsedCliTaskRun.dryRun, true)
    assert.equal(parsedCliTaskRun.taskId, cliTask.id)
    assert.equal(parsedCliTaskRun.parentMode, 'ai')
    assert.equal(parsedCliTaskRun.slices.length, 2)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
})

test('in-process AI parent auto-slices, answers worker questions, and recovers from reviewer rejection round', async () => {
  const models = makeSampleModels()
  const budget = createModelBudget({
    profiles: {},
    now: () => Date.parse('2026-11-13T12:00:00Z')
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })

  let autoSliceCalls = 0
  let questionAnswerCalls = 0
  let worker1FollowupSawAnswer = false
  let reviewAttempt = 0

  const modelClient = {
    async complete(model, request) {
      const system = request.messages?.[0]?.content ?? ''
      const user = request.messages?.[1]?.content ?? ''
      request.onUsage?.({ promptTokens: 6, completionTokens: 8, totalTokens: 14 })

      if (user.includes('[auto-slice]')) {
        autoSliceCalls += 1
        return JSON.stringify({
          slices: [
            { title: 'Schema migration', goal: 'Add billing_tier column', files: ['db.sql'] },
            { title: 'Billing API', goal: 'Expose /api/billing endpoint', files: ['billing.js'] }
          ]
        })
      }

      if (user.includes('[answer-question]')) {
        questionAnswerCalls += 1
        return JSON.stringify({ answer: 'Default billing_tier to free and mark NOT NULL.' })
      }

      if (system.includes('reviewer')) {
        reviewAttempt += 1
        if (reviewAttempt === 1) {
          return JSON.stringify({
            approved: false,
            summary: 'Reject unknown billing tiers in /api/billing.',
            issues: ['Add allowlist check for billing_tier']
          })
        }
        return JSON.stringify({
          approved: true,
          summary: 'Migration and validation passed review.'
        })
      }

      if (user.includes('Add billing_tier column')) {
        if (!user.includes('Parent answer:') && !user.includes('Revision round 1')) {
          return JSON.stringify({
            status: 'question',
            summary: 'Need nullability constraint',
            question: 'Should billing_tier allow NULL values?'
          })
        }
        if (user.includes('Parent answer: Default billing_tier to free and mark NOT NULL.')) {
          worker1FollowupSawAnswer = true
        }
        return JSON.stringify({
          status: 'done',
          summary: `Schema migration done on ${model.id}`
        })
      }

      return JSON.stringify({
        status: 'done',
        summary: user.includes('Revision round 1')
          ? 'Added strict billing_tier allowlist in /api/billing'
          : `Billing API initial implementation on ${model.id}`
      })
    }
  }

  const runner = createSwarmRunner({
    database,
    bus,
    models,
    modelClient,
    modelBudget: budget
  })

  const created = runner.createSwarm({
    objective: 'Implement billing tier support',
    workerCount: 2,
    parentMode: 'ai',
    maxReviewRounds: 1,
    models: ['colab-3b', 'kaggle-3b']
  })
  assert.equal(created.state, 'running')

  const executed = await runner.executeSwarm(created.runId, { maxSteps: 10 })
  assert.equal(executed.state, 'completed')
  assert.equal(autoSliceCalls, 1)
  assert.equal(questionAnswerCalls, 1)
  assert.equal(worker1FollowupSawAnswer, true)
  assert.equal(reviewAttempt, 2)
  assert.ok(executed.board.some((entry) => entry.kind === 'question'))
  assert.ok(
    executed.board.some(
      (entry) => entry.kind === 'assign' && entry.payload?.parentAnswer === 'Default billing_tier to free and mark NOT NULL.'
    )
  )
  assert.ok(
    executed.board.some(
      (entry) => entry.kind === 'verdict' && entry.payload?.approved === false
    )
  )
  assert.ok(executed.result?.summary.includes('Migration and validation passed review.'))
})

test('context hydration and register backfill across user_files, folders, tasks, and ai_sessions', async () => {
  const models = makeSampleModels()
  const budget = createModelBudget({
    profiles: {},
    now: () => Date.parse('2026-11-13T12:00:00Z')
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  const repo = database.ensureRepository(tempDir).repository

  database.createFolder({
    repositoryId: repo.id,
    path: 'apps/api/src/billing',
    objective: 'Own subscription billing and webhook verification'
  })
  database.createUserFile({
    repositoryId: repo.id,
    path: 'apps/api/src/billing/checkout.js',
    objective: 'Create Stripe checkout sessions cleanly',
    requirements: 'Idempotent key per cart; reject zero-amount charges',
    decisions: 'Use webhooks for authoritative payment settlement',
    relevant_files: 'apps/api/src/billing/webhooks.js',
    important_context: 'Never log raw customer payment metadata'
  })
  database.createUserFile({
    repositoryId: repo.id,
    path: 'apps/api/src/billing/webhooks.js',
    objective: 'Verify webhook signatures and update plan state',
    requirements: 'Validate HMAC signature before parsing JSON body'
  })

  const task = database.createTask({
    title: 'Harden billing checkout flow',
    acceptance_criteria: '- Verify checkout and webhook handling',
    relevant_files: 'apps/api/src/billing/checkout.js'
  })

  const capturedPrompts = []
  const runner = createSwarmRunner({
    database,
    bus,
    models,
    modelBudget: budget,
    modelClient: {
      async complete(_model, request) {
        capturedPrompts.push(request.messages.map((m) => m.content).join('\n'))
        request.onUsage?.({ promptTokens: 5, completionTokens: 5, totalTokens: 10 })
        return JSON.stringify({
          summary: 'Verified checkout idempotency and webhook HMAC check',
          status: 'done',
          registers: {
            next_move: 'Add webhook replay protection tests'
          }
        })
      }
    }
  })

  const firstRun = runner.createSwarm({
    taskId: task.id,
    includeReviewer: false,
    models: ['colab-3b']
  })
  const firstExecuted = await runner.executeSwarm(firstRun.runId)
  assert.equal(firstExecuted.state, 'completed')

  // First run worker received folder objective, matched file registers, and 1-hop expanded file register.
  assert.match(capturedPrompts[0], /Own subscription billing and webhook verification/)
  assert.match(capturedPrompts[0], /Never log raw customer payment metadata/)
  assert.match(capturedPrompts[0], /apps\/api\/src\/billing\/webhooks\.js/)
  assert.match(capturedPrompts[0], /Validate HMAC signature before parsing JSON body/)

  // Blank task registers were backfilled pre-run and post-run registers (next_move) were synced via agentTaskOps.
  const updatedTask = database.getTask(task.id)
  assert.match(updatedTask.objectives, /Own subscription billing and webhook verification/)
  assert.match(updatedTask.requirements, /Idempotent key per cart/)
  assert.match(updatedTask.decisions, /Use webhooks for authoritative payment settlement/)
  assert.match(updatedTask.important_context, /Never log raw customer payment metadata/)
  assert.equal(updatedTask.next_move, 'Add webhook replay protection tests')

  // Session history was compacted and stored for the task.
  const taskSessions = database.listAiSessions().filter((entry) => Number(entry.taskId) === task.id)
  assert.equal(taskSessions.length, 1)
  assert.ok(taskSessions[0].summary.includes('Verified checkout idempotency'))

  // A subsequent swarm run for the same task warms up automatically from compacted session + next_move registers.
  const secondRun = runner.createSwarm({
    taskId: task.id,
    objective: 'Follow up with replay tests',
    includeReviewer: false,
    models: ['colab-3b']
  })
  const secondExecuted = await runner.executeSwarm(secondRun.runId)
  assert.equal(secondExecuted.state, 'completed')
  assert.match(capturedPrompts[1], /Next move: Add webhook replay protection tests/)
  assert.match(capturedPrompts[1], /Session summary:/)
})

test('single-agent routes refine-task, jobs, complete, and improve execute as multi-agent runs on agentBus', async () => {
  const models = makeSampleModels()
  const repo = database.ensureRepository(tempDir).repository
  database.createUserFile({
    repositoryId: repo.id,
    path: 'apps/api/src/routes/multiCheck.js',
    objective: 'Multi-agent HTTP route verification module',
    requirements: 'Enforce strict schema validation across routes',
    decisions: 'Route every AI call over star-topology agentBus'
  })
  const task = database.createTask({
    title: 'Multi-agent route check',
    relevant_files: 'apps/api/src/routes/multiCheck.js'
  })

  const app = createApp(database, {
    models,
    turnCooldownMs: 0,
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 5
    }),
    modelClient: {
      probe: async () => ({ ok: true }),
      async complete(_model, request) {
        const system = request.messages?.[0]?.content ?? ''
        const user = request.messages?.[1]?.content ?? ''
        request.onUsage?.({ promptTokens: 4, completionTokens: 6, totalTokens: 10 })

        if (system.includes('reviewer')) {
          return JSON.stringify({
            approved: true,
            summary: 'Reviewer approved all worker outputs.'
          })
        }
        if (system.includes('improvement assistant')) {
          if (user.includes('Worker 2/')) {
            return JSON.stringify([
              {
                title: 'Add worker 2 coverage metrics',
                description: 'Track multi-worker proposal diversity.',
                priority: 'low',
                rationale: 'Ensure broad coverage'
              }
            ])
          }
          return JSON.stringify([
            {
              title: 'Automate register header sync hook',
              description: 'Run header sync after swarm runs.',
              priority: 'medium',
              rationale: 'Keep SQLite registers fresh'
            }
          ])
        }
        if (system.includes('Refine this software task')) {
          return JSON.stringify({
            description: 'Refined task over multi-agent bus.',
            acceptance_criteria: ['Schema checks pass', 'Bus provenance recorded']
          })
        }
        const suffix = system.includes('Enforce strict schema validation across routes')
          ? 'with-context'
          : 'plain'
        return `Multi-agent complete reply (${suffix})`
      }
    }
  })

  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolvePromise, reject) => {
    server.once('listening', resolvePromise)
    server.once('error', reject)
  })

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    // 1. /api/local-ai/refine-task with multi-worker + reviewer + register backfill
    const refineRes = await fetch(`${baseUrl}/api/local-ai/refine-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: task.title,
        task_id: task.id,
        workers: 2,
        include_reviewer: true,
        backfill_registers: true
      })
    })
    assert.equal(refineRes.status, 200)
    const refineJson = await refineRes.json()
    assert.equal(refineJson.description, 'Refined task over multi-agent bus.')
    assert.ok(refineJson.agentRunId?.startsWith('run_'))

    const refineRun = await (await fetch(`${baseUrl}/api/agents/runs/${refineJson.agentRunId}`)).json()
    assert.equal(refineRun.state, 'completed')
    assert.ok(refineRun.agents.some((agent) => agent.name === 'worker-2'))
    assert.ok(refineRun.agents.some((agent) => agent.role === 'reviewer'))
    assert.ok(refineRun.messages.some((message) => message.kind === 'handoff'))
    assert.ok(refineRun.messages.some((message) => message.kind === 'verdict'))

    const backfilledTask = database.getTask(task.id)
    assert.match(backfilledTask.requirements, /Enforce strict schema validation across routes/)
    assert.match(backfilledTask.decisions, /Route every AI call over star-topology agentBus/)

    // 2. /api/local-ai/jobs preserves Drafting result shape and creates a completed agentRun
    const runsBeforeJob = database.listAgentRuns({ limit: 50 }).length
    const jobRes = await fetch(`${baseUrl}/api/local-ai/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Batch multi-agent draft',
        model: 'local-0.5b',
        task_id: task.id
      })
    })
    assert.equal(jobRes.status, 202)
    const submittedJob = await jobRes.json()
    let polledJob
    for (let attempt = 0; attempt < 200; attempt += 1) {
      polledJob = await (await fetch(`${baseUrl}/api/local-ai/jobs/${submittedJob.id}`)).json()
      if (['done', 'error', 'cancelled'].includes(polledJob.state)) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(polledJob.state, 'done')
    assert.equal(polledJob.result.description, 'Refined task over multi-agent bus.')
    assert.equal(database.listAgentRuns({ limit: 50 }).length, runsBeforeJob + 1)

    // 3. /api/ai/complete with multi-worker fan-out and workspace register context
    const completeRes = await fetch(`${baseUrl}/api/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Summarize validation requirements',
        task_id: task.id,
        workers: 2,
        include_context: true
      })
    })
    assert.equal(completeRes.status, 200)
    const completeJson = await completeRes.json()
    assert.equal(completeJson.content, 'Multi-agent complete reply (with-context)')
    assert.ok(completeJson.agentRunId?.startsWith('run_'))

    const completeRun = await (await fetch(`${baseUrl}/api/agents/runs/${completeJson.agentRunId}`)).json()
    assert.equal(completeRun.state, 'completed')
    assert.equal(completeRun.messages.filter((message) => message.kind === 'result').length, 2)

    // 4. /api/ai/improve with 2 workers merges proposals and stamps originAgentRunId
    const improveRes = await fetch(`${baseUrl}/api/ai/improve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: 2 })
    })
    assert.equal(improveRes.status, 200)
    const improveJson = await improveRes.json()
    assert.ok(improveJson.agentRunId?.startsWith('run_'))
    assert.equal(improveJson.proposals.length, 2)
    assert.ok(improveJson.proposals.every((proposal) => proposal.originAgentRunId === improveJson.agentRunId))

    const improveRun = await (await fetch(`${baseUrl}/api/agents/runs/${improveJson.agentRunId}`)).json()
    assert.equal(improveRun.state, 'completed')
    assert.equal(improveRun.messages.filter((message) => message.kind === 'result').length, 2)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
})

test('parallel self-improvement runs by default, detects portability gaps, deduplicates proposals, and can be disabled', async () => {
  const models = makeSampleModels()
  const budget = createModelBudget({
    profiles: {},
    now: () => Date.parse('2026-11-13T12:00:00Z')
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  database.ensureRepository('/nonexistent/portable-missing-repo-path')

  const modelClient = {
    async complete() {
      return JSON.stringify({
        summary: 'Completed primary slice.',
        status: 'done',
        proposals: [
          {
            title: 'Standardize env overrides across scripts',
            description: 'Reuse shared helper for env defaults.',
            priority: 'medium',
            task_type: 'chore',
            rationale: 'Portable configuration hygiene'
          },
          {
            title: 'Standardize env overrides across scripts',
            description: 'Duplicate entry that should be deduplicated.',
            priority: 'low',
            task_type: 'chore'
          }
        ]
      })
    }
  }

  const runner = createSwarmRunner({
    database,
    bus,
    models,
    modelClient,
    modelBudget: budget
  })

  const defaultPlan = runner.planSwarm({
    objective: 'Slice 1; Slice 2',
    models: ['colab-3b', 'kaggle-3b']
  })
  assert.equal(defaultPlan.selfImprove, true)
  assert.equal(defaultPlan.selfImprovementPlan.strategy, 'parallel')

  const created = runner.createSwarm({
    objective: 'Slice 1; Slice 2',
    includeReviewer: false,
    autoProposeSelfImprovement: true,
    models: ['colab-3b', 'kaggle-3b']
  })
  const executed = await runner.executeSwarm(created.runId)
  assert.equal(executed.state, 'completed')
  assert.equal(executed.selfImprove, true)
  assert.equal(executed.selfImprovement.strategy, 'parallel')
  assert.equal(executed.selfImprovement.portabilityOk, false)
  assert.ok(executed.selfImprovement.sensorFindingsCount >= 1)
  assert.ok(
    executed.selfImprovement.recommendations.some((line) => line.includes('portability'))
  )

  const proposals = database.listTaskProposals()
  assert.equal(
    proposals.filter((entry) => entry.title === 'Standardize env overrides across scripts').length,
    1
  )
  assert.ok(
    proposals.some((entry) => entry.title === 'Repair non-portable repository or worktree paths')
  )

  const disabledCreated = runner.createSwarm({
    objective: 'Disabled self-improve slice',
    includeReviewer: false,
    selfImprove: false,
    models: ['colab-3b']
  })
  const disabledExecuted = await runner.executeSwarm(disabledCreated.runId)
  assert.equal(disabledExecuted.state, 'completed')
  assert.equal(disabledExecuted.selfImprove, false)
  assert.equal(disabledExecuted.selfImprovement.strategy, 'disabled')
})

test('swarm planSwarm and CLI distribute across AGY 3 weekly pools and rotate-model supports AGY pools', () => {
  const models = makeSampleModels().map((entry) => (
    entry.id === 'agy' ? { ...entry, billingCategory: 'free' } : entry
  ))
  const budget = createModelBudget({
    env: {
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '50',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '20',
      AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '20'
    },
    now: () => Date.parse('2026-11-13T12:00:00Z')
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  const runner = createSwarmRunner({ database, bus, models, modelBudget: budget })

  const agyPlan = runner.planSwarm({
    objective: 'Slice A; Slice B; Slice C',
    includeReviewer: false,
    agyModels: ['gemini-3.8-flash-medium', 'claude-sonnet-5-5-medium', 'gemini-4-argon-medium']
  })
  const agyWorkers = agyPlan.agents.filter((agent) => agent.role === 'worker')
  const agyDomains = new Set(agyWorkers.map((agent) => agent.groupKey))
  assert.ok(agyDomains.has('agy:gemini'))
  assert.ok(agyDomains.has('agy:claude-gpt'))
  assert.ok(agyDomains.has('agy:gemini-4-argon'))

  const cliPlan = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'ai-swarm.mjs'),
    'plan',
    'Slice A; Slice B',
    '--agy-models',
    'gemini-3.8-flash-medium,claude-sonnet-5-5-medium,gemini-4-argon-medium',
    '--database',
    join(tempDir, 'cli-agy-plan.sqlite'),
    '--json'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  assert.equal(cliPlan.status, 0, cliPlan.stderr)
  const parsedPlan = JSON.parse(cliPlan.stdout)
  assert.ok(Array.isArray(parsedPlan.agents))

  const rotated = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'rotate-model.mjs'),
    '--backend',
    'agy',
    '--pool',
    'claude-gpt',
    '--dry-run'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  assert.equal(rotated.status, 0, rotated.stderr)
  assert.match(rotated.stdout, /agy \[claude-gpt\] model:/)
})

test('planSwarm and --dry-run compute token/call and USD exposure estimates across free vs paid escalation lanes', () => {
  const paidModel = {
    id: 'gemini-api-paid',
    label: 'Gemini API CLI (Prepay Tier-1)',
    provider: 'gemini-api-paid',
    backend: 'gemini-api-cli',
    limitKind: 'provider_model',
    billingCategory: 'payg',
    escalationOnly: true,
    allowProModels: true,
    callable: true,
    autoSelect: false,
    remote: true,
    priority: 99,
    cli: { command: 'gemini-api', model: 'gemini-4-argon', allowProModels: true }
  }
  const models = [...makeSampleModels(), paidModel]
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '100',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '50',
      GEMINI_API_PAID_PREPAY_BALANCE_USD: '5'
    }
  })
  const bus = createAgentBus({ database, models, modelBudget: budget })
  const runner = createSwarmRunner({ database, bus, models, modelBudget: budget })

  const freePlan = runner.planSwarm({
    objective: 'Task 1; Task 2',
    includeReviewer: false
  })
  assert.equal(freePlan.quotaSummary.paidEscalationActive, false)
  assert.equal(freePlan.quotaSummary.estimatedPaidUsd, 0)
  assert.ok(freePlan.quotaSummary.estimatedCalls >= 2)
  assert.ok(freePlan.quotaSummary.estimatedTokens > 0)
  assert.equal(freePlan.quotaSummary.agentEstimates.every((entry) => entry.estimatedUsd === 0), true)

  const paidPlan = runner.planSwarm({
    objective: 'Hard debug slice',
    includeReviewer: false,
    geminiApiPaidModels: ['gemini-4-argon']
  })
  assert.equal(paidPlan.quotaSummary.paidEscalationActive, true)
  assert.ok(paidPlan.quotaSummary.estimatedPaidUsd > 0)
  const paidAgentEst = paidPlan.quotaSummary.agentEstimates.find((entry) => entry.provider === 'gemini-api-paid')
  assert.ok(paidAgentEst)
  assert.ok(paidAgentEst.estimatedUsd > 0)
  assert.equal(paidAgentEst.remainingPoolUsd, 4)

  const dryRunCli = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'ai-swarm.mjs'),
    'run',
    'Slice 1; Slice 2',
    '--gemini-api-paid-models',
    'gemini-4-argon',
    '--database',
    join(tempDir, 'cli-dry-run-estimate.sqlite'),
    '--json',
    '--dry-run'
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_API_PAID_PREPAY_BALANCE_USD: '5',
      GEMINI_API_PAID_NO_KEYRING: 'true'
    },
    encoding: 'utf8'
  })
  assert.equal(dryRunCli.status, 0, dryRunCli.stderr)
  const dryRunJson = JSON.parse(dryRunCli.stdout)
  assert.equal(dryRunJson.dryRun, true)
  assert.equal(dryRunJson.quotaSummary.paidEscalationActive, true)
  assert.ok(dryRunJson.quotaSummary.estimatedPaidUsd > 0)
})

test('planSwarm and createSwarm surface syncAudit drift warnings when an AGY window has expired', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'swarm-sync-audit-'))
  const db = createDatabase(join(tempDir, 'workspace.sqlite'))
  try {
    const binDir = join(tempDir, 'bin')
    await mkdir(binDir)
    const agyCommand = join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    await writeFile(agyCommand, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') await chmod(agyCommand, 0o755)

    const agyEnv = {
      PATH: binDir,
      AGY_AI_GEMINI_MAX_REQUESTS_PER_5H: '100',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '500'
    }
    const models = createModelRegistry({ env: agyEnv })
    const profiles = resolveQuotaProfiles({ env: agyEnv, profiles: modelQuotaProfiles(models) })
    let clockMs = Date.parse('2026-11-14T12:00:00Z')
    const budget = createModelBudget({
      repository: db,
      profiles,
      now: () => clockMs
    })
    budget.syncPoolState('agy', {
      scope: 'gemini-3.8-flash-medium',
      weeklyRemainingPercent: 80,
      weeklyResetSeconds: 150 * 3600,
      sessionRemainingPercent: 60,
      sessionResetSeconds: 10 * 60
    })

    // Advance past the 10-minute 5-hour session window
    clockMs += 15 * 60_000

    const runner = createSwarmRunner({
      database: db,
      bus: createAgentBus({ database: db }),
      models,
      modelBudget: budget,
      modelClient: { generate: async () => ({ text: 'ok' }) },
      rootDir: tempDir
    })

    const plan = runner.planSwarm({
      objective: 'Slice 1; Slice 2',
      agyModels: ['gemini-3.8-flash-medium']
    })
    assert.equal(plan.quotaSummary.syncAudit.needsSync, true)
    assert.ok(plan.quotaSummary.syncAudit.expiredResets.includes('agy@gemini'))
    assert.ok(plan.quotaSummary.syncAudit.warnings.some((w) => /agy@gemini: synced 5h window reset timer elapsed/.test(w)))

    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const created = runner.createSwarm({
        objective: 'Slice 1; Slice 2',
        agyModels: ['gemini-3.8-flash-medium']
      })
      assert.ok(created.runId)
    } finally {
      console.warn = origWarn
    }
    assert.ok(warnings.some((w) => /\[swarm pre-flight\] Quota calibration drift: agy@gemini: synced 5h window reset timer elapsed/.test(w)))
  } finally {
    db.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('isolateWorktrees provisions per-worker Git worktrees and cleans them up on finalization', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const tempDir = await mkdtemp(join(tmpdir(), 'swarm-worktree-'))
  const repoDir = join(tempDir, 'repo')
  const db = createDatabase(join(tempDir, 'workspace.sqlite'))
  try {
    execFileSync('git', ['init', repoDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' })

    const seenWorktrees = []
    const runner = createSwarmRunner({
      database: db,
      bus: createAgentBus({ database: db }),
      models: makeSampleModels(),
      modelBudget: createModelBudget(),
      modelClient: {
        generate: async () => ({ text: 'ok' }),
        complete: async (_model, req) => {
          if (req.worktreePath) seenWorktrees.push(req.worktreePath)
          return JSON.stringify({
            summary: 'done',
            status: 'done',
            approved: true,
            verdict: 'approved'
          })
        }
      },
      rootDir: repoDir
    })

    const created = runner.createSwarm({
      objective: 'Slice 1; Slice 2',
      isolateWorktrees: true,
      worktreePath: repoDir,
      includeReviewer: false
    })
    assert.ok(created.runId)
    const worker1Wt = created.checkpoint.workerWorktrees['worker-1'].worktreePath
    const worker2Wt = created.checkpoint.workerWorktrees['worker-2'].worktreePath
    assert.notEqual(worker1Wt, worker2Wt)
    assert.equal(existsSync(worker1Wt), true)
    assert.equal(existsSync(worker2Wt), true)

    const executed = await runner.executeSwarm(created.runId, { maxSteps: 10 })
    assert.equal(executed.state, 'completed')
    assert.ok(seenWorktrees.includes(worker1Wt))
    assert.ok(seenWorktrees.includes(worker2Wt))
    assert.equal(existsSync(worker1Wt), false)
    assert.equal(existsSync(worker2Wt), false)
  } finally {
    db.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('isolateWorktrees feeds worktreeDiffs to reviewer and merges approved branches when mergeWorktrees is true', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync, writeFileSync } = await import('node:fs')
  const tempDir = await mkdtemp(join(tmpdir(), 'swarm-merge-wt-'))
  const repoDir = join(tempDir, 'repo')
  const db = createDatabase(join(tempDir, 'workspace.sqlite'))
  try {
    execFileSync('git', ['init', repoDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' })

    let reviewerSawDiff = false
    const runner = createSwarmRunner({
      database: db,
      bus: createAgentBus({ database: db }),
      models: makeSampleModels(),
      modelBudget: createModelBudget(),
      modelClient: {
        generate: async () => ({ text: 'ok' }),
        complete: async (_model, req) => {
          const userMsg = req.messages.find((m) => m.role === 'user')?.content || ''
          if (req.worktreePath && !userMsg.includes('Review')) {
            writeFileSync(join(req.worktreePath, 'worker-output.txt'), 'hello from isolated worktree\n')
          }
          if (userMsg.includes('worktreeDiffs') && userMsg.includes('worker-output.txt')) {
            reviewerSawDiff = true
          }
          return JSON.stringify({
            summary: 'done',
            status: 'done',
            approved: true,
            verdict: 'approved'
          })
        }
      },
      rootDir: repoDir
    })

    const created = runner.createSwarm({
      objective: 'Create worker-output.txt',
      isolateWorktrees: true,
      mergeWorktrees: true,
      worktreePath: repoDir,
      includeReviewer: true
    })
    const executed = await runner.executeSwarm(created.runId, { maxSteps: 10 })
    assert.equal(executed.state, 'completed')
    assert.equal(reviewerSawDiff, true)
    assert.equal(existsSync(join(repoDir, 'worker-output.txt')), true)
  } finally {
    db.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

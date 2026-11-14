import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelBudget } from '../src/modelBudget.js'
import { createModelRegistry } from '../src/modelRegistry.js'
import { createModelScheduler } from '../src/modelScheduler.js'
import {
  buildSwarmRoster,
  groupModelsByProvider,
  modelProviderKey,
  planAgentDispatch,
  providerSnapshots,
  resolveAgentModel
} from '../src/providerQuota.js'

const MINUTE = 60000

function clockAt(iso) {
  let now = Date.parse(iso)
  return {
    now: () => now,
    advance(ms) { now += ms }
  }
}

function model(overrides) {
  return {
    id: 'model-a',
    label: 'Model A',
    provider: 'provider-a',
    backend: 'http',
    callable: true,
    autoSelect: true,
    remote: true,
    priority: 10,
    billingCategory: 'free',
    ...overrides
  }
}

test('provider grouping keeps generic slots in separate quota domains', () => {
  const models = [
    model({ id: 'local-0.5b', provider: 'local', backend: 'http' }),
    model({ id: 'local-1.5b', provider: 'local', backend: 'http' }),
    model({ id: 'slot-a', provider: 'serverless', backend: 'http' }),
    model({ id: 'slot-b', provider: 'serverless', backend: 'http' }),
    model({ id: 'opencode', provider: 'opencode', backend: 'opencode-cli', cli: { model: 'free/model' } })
  ]

  assert.equal(modelProviderKey(models[0]), 'local')
  assert.equal(modelProviderKey(models[2]), 'serverless:slot-a')
  assert.equal(modelProviderKey(models[4]), 'opencode')

  const groups = groupModelsByProvider(models)
  assert.equal(groups.length, 4)
  assert.equal(groups.find((group) => group.groupKey === 'local').models.length, 2)
  assert.equal(
    groups.filter((group) => group.provider === 'serverless').length,
    2
  )
})

test('provider snapshots prefer a model with quota headroom', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      'model-a': [{ unit: 'requests', limit: 2, window: 'minute', reset: 'rolling' }],
      'model-b': [{ unit: 'requests', limit: 1, window: 'minute', reset: 'rolling' }]
    },
    now: clock.now
  })
  budget.record('model-a')
  budget.record('model-b')

  const models = [
    model({ id: 'model-a', label: 'Model A', priority: 10 }),
    model({ id: 'model-b', label: 'Model B', priority: 20 })
  ]
  const snapshots = providerSnapshots({ models, modelBudget: budget })
  assert.equal(snapshots.length, 1)
  const [provider] = snapshots
  assert.equal(provider.provider, 'provider-a')
  assert.equal(provider.ok, true)
  assert.equal(provider.preferredModel, 'model-a')
  assert.equal(provider.headroom, 0.5)
  assert.equal(provider.availableCount, 1)
  assert.equal(provider.models.find((entry) => entry.id === 'model-b').ok, false)

  // With both slots spent, the provider reports the earliest reset instead of
  // pretending a model is available.
  budget.record('model-a')
  const blocked = providerSnapshots({ models, modelBudget: budget })[0]
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, 60)
  assert.equal(blocked.headroom, 0)
})

test('dispatch plans serialize agents that share a provider', () => {
  const models = [
    model({ id: 'model-a', provider: 'provider-a' }),
    model({ id: 'model-b', provider: 'provider-b' })
  ]
  const agents = [
    { id: 'agt_1', name: 'parent', role: 'parent', model: 'model-a' },
    { id: 'agt_2', name: 'worker-a', role: 'worker', model: 'model-a' },
    { id: 'agt_3', name: 'worker-b', role: 'worker', model: 'model-b' }
  ]

  const plan = planAgentDispatch({
    models,
    agents,
    parallelLimit: 1,
    activeAssignments: [{ toAgentId: 'agt_2', state: 'delivered' }]
  })
  const providerA = plan.providers.find((provider) => provider.provider === 'provider-a')
  const providerB = plan.providers.find((provider) => provider.provider === 'provider-b')
  assert.equal(providerA.ok, false)
  assert.match(providerA.reason, /active assignment/)
  assert.equal(providerB.ok, true)
  assert.equal(plan.ok, false)

  const free = planAgentDispatch({ models, agents, parallelLimit: 1 })
  assert.equal(free.ok, true)
})

test('reservations gate concurrent dispatches and settle usage once', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [
        { policy: 'rpm', unit: 'requests', limit: 1, window: 'minute', reset: 'rolling' },
        { policy: 'tpm', unit: 'tokens', limit: 100, window: 'minute', reset: 'rolling' }
      ]
    },
    now: clock.now
  })

  const first = budget.reserve('api', { calls: 1, tokens: 60 })
  assert.equal(first.ok, true)
  assert.equal(budget.headroom('api').ratio, 0)
  assert.equal(budget.snapshot('api').remaining, 0)

  const second = budget.reserve('api', { calls: 1, tokens: 10 })
  assert.equal(second.ok, false)
  assert.equal(second.retryAfter, 60)

  // A settlement records both the call and the real token usage exactly once.
  const settled = budget.settle(first.reservationId, {
    usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 }
  })
  assert.equal(settled.settled, true)
  const snapshot = budget.snapshot('api')
  assert.equal(snapshot.limiters.find((limiter) => limiter.policy === 'rpm').used, 1)
  assert.equal(snapshot.limiters.find((limiter) => limiter.policy === 'tpm').used, 50)
  assert.equal(snapshot.remaining, 0)
  assert.equal(budget.settle(first.reservationId).settled, false)

  clock.advance(MINUTE)
  const next = budget.reserve('api', { calls: 1, tokens: 50 })
  assert.equal(next.ok, true)
})

test('released and expired reservations stop blocking a provider', () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      api: [{ unit: 'requests', limit: 1, window: 'minute', reset: 'rolling' }]
    },
    now: clock.now
  })

  const released = budget.reserve('api', { ttlMs: 1000 })
  assert.equal(budget.check('api').ok, false)
  assert.equal(budget.release(released.reservationId), true)
  assert.equal(budget.check('api').ok, true)

  const expired = budget.reserve('api', { ttlMs: 1000 })
  assert.equal(budget.check('api').ok, false)
  clock.advance(1001)
  assert.equal(budget.check('api').ok, true)
  assert.equal(budget.release(expired.reservationId), false)
})

test('automatic selection skips a provider with no quota headroom', async () => {
  const clock = clockAt('2026-01-15T10:00:00Z')
  const budget = createModelBudget({
    profiles: {
      'model-a': [{ unit: 'requests', limit: 1, window: 'day', reset: 'fixed' }]
    },
    now: clock.now
  })
  budget.record('model-a')

  const models = [
    model({ id: 'model-a', label: 'Model A', provider: 'provider-a', priority: 10 }),
    model({ id: 'model-b', label: 'Model B', provider: 'provider-b', priority: 5 })
  ]
  const scheduler = createModelScheduler({
    models,
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 10
    }),
    getCpuLoadLimit: () => 1,
    minAvailableMemoryMb: 1024,
    maxDiskBusyPercent: 30,
    turnCooldownMs: 0,
    probeModel: async () => ({ ok: true }),
    getModelBudget: (entry) => budget.check(entry.id, entry.cli?.model)
  })

  const selected = await scheduler.select()
  assert.equal(selected.error, undefined)
  assert.equal(selected.model.id, 'model-b')
  selected.release({ inferenceStarted: false })
})

test('scoped billing overrides propagate and scheduler prefers free over subscription/payg', async () => {
  const models = createModelRegistry({
    env: {
      OPENCODE_AI_MODEL: 'opencode/qwen3.6-plus-free',
      AI_BILLING_CATEGORIES: JSON.stringify({
        opencode: 'free',
        'opencode@paid/pro-model': 'payg',
        'agy@claude': 'subscription'
      })
    }
  })

  const opencodeDefault = resolveAgentModel(models, 'opencode')
  assert.equal(opencodeDefault.billingCategory, 'free')

  const opencodePaid = resolveAgentModel(models, 'opencode@paid/pro-model')
  assert.equal(opencodePaid.billingCategory, 'payg')

  const agyClaude = resolveAgentModel(models, 'agy@claude')
  assert.equal(agyClaude.billingCategory, 'subscription')

  const candidates = [
    model({ id: 'paid-fast', provider: 'paid', billingCategory: 'payg', priority: 100 }),
    model({ id: 'sub-model', provider: 'sub', billingCategory: 'subscription', priority: 80 }),
    model({ id: 'free-model', provider: 'free', billingCategory: 'free', priority: 5 })
  ]
  const scheduler = createModelScheduler({
    models: candidates,
    getResourceMetrics: async () => ({
      loadAverage: 0.1,
      availableMemoryMb: 4096,
      diskBusyPercent: 5
    }),
    getCpuLoadLimit: () => 1,
    minAvailableMemoryMb: 1024,
    maxDiskBusyPercent: 30,
    turnCooldownMs: 0,
    probeModel: async () => ({ ok: true })
  })

  const selected = await scheduler.select()
  assert.equal(selected.error, undefined)
  assert.equal(selected.model.id, 'free-model')
  selected.release({ inferenceStarted: false })
})

test('local resource gate busy state marks local snapshots and dispatch plans blocked', () => {
  const models = [
    model({
      id: 'local-1.5b',
      provider: 'local',
      remote: false,
      limitKind: 'resource',
      billingCategory: 'free',
      priority: 20
    }),
    model({
      id: 'colab-3b',
      provider: 'colab',
      remote: true,
      limitKind: 'compute_utilization',
      billingCategory: 'free',
      priority: 8
    })
  ]

  const resourceStatus = {
    models: [
      {
        id: 'local-1.5b',
        state: 'busy',
        available: false,
        busyReasons: ['available memory 900 MB is below 1792 MB']
      },
      {
        id: 'colab-3b',
        state: 'ready',
        available: true
      }
    ]
  }

  const snapshots = providerSnapshots({ models, resourceStatus })
  const localProvider = snapshots.find((entry) => entry.provider === 'local')
  assert.equal(localProvider.ok, false)
  assert.equal(localProvider.headroom, 0)
  assert.equal(localProvider.models[0].resourceBlocked, true)

  const plan = planAgentDispatch({
    models,
    resourceStatus,
    agents: [
      { id: 'a1', role: 'worker', name: 'worker-1', model: 'local-1.5b' },
      { id: 'a2', role: 'worker', name: 'worker-2', model: 'colab-3b' }
    ]
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.agents[0].ok, false)
  assert.equal(plan.agents[0].resourceBlocked, true)
  assert.equal(plan.agents[1].ok, true)
})

test('buildSwarmRoster prefers configured free live pools over batch or unprofiled remote optimism', () => {
  const models = [
    model({
      id: 'kaggle-3b',
      provider: 'kaggle',
      execution: 'batch',
      autoSelect: false,
      limitKind: 'compute_utilization',
      priority: 90
    }),
    model({
      id: 'unprofiled-remote',
      provider: 'other',
      execution: 'live',
      autoSelect: true,
      limitKind: 'provider_model',
      priority: 80
    }),
    model({
      id: 'colab-3b',
      provider: 'colab',
      execution: 'live',
      autoSelect: true,
      limitKind: 'compute_utilization',
      priority: 10
    })
  ]

  const budget = createModelBudget({
    profiles: {
      'colab-3b': [{ unit: 'requests', limit: 10, window: 'day', reset: 'fixed' }]
    }
  })

  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 1,
    includeReviewer: false
  })
  assert.equal(roster.workers.length, 1)
  assert.equal(roster.workers[0].model, 'colab-3b')
})

test('buildSwarmRoster separates AGY 3 weekly pools, prioritizes Tier 0 workers, and assigns Tier 1 reviewer', () => {
  const clock = clockAt('2026-01-12T08:00:00Z') // Monday UTC
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '40',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '40',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '40',
      AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '40'
    },
    now: clock.now
  })

  const models = [
    model({
      id: 'opencode',
      provider: 'opencode',
      backend: 'opencode-cli',
      limitKind: 'provider_model',
      cli: { command: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }
    }),
    model({
      id: 'agy',
      provider: 'agy',
      backend: 'agy-cli',
      limitKind: 'provider_model',
      cli: { command: 'agy', model: 'gemini-3.8-flash-medium' }
    })
  ]

  const gemHigh = resolveAgentModel(models, 'agy@gemini-3.8-flash-high')
  const claude = resolveAgentModel(models, 'agy@claude-sonnet-5-5-medium')
  const gpt = resolveAgentModel(models, 'agy@gpt-oss-120b-medium')
  const argon = resolveAgentModel(models, 'agy@gemini-4-argon-medium')

  assert.equal(modelProviderKey(gemHigh), 'agy:gemini')
  assert.equal(modelProviderKey(claude), 'agy:claude-gpt')
  assert.equal(modelProviderKey(gpt), 'agy:claude-gpt')
  assert.equal(modelProviderKey(argon), 'agy:gemini-4-argon')
  assert.equal(modelProviderKey(resolveAgentModel(models, 'agy@google/gemini-3.8-flash-high')), 'agy:gemini')
  assert.equal(modelProviderKey(resolveAgentModel(models, 'agy@anthropic/claude-opus-4-1-high')), 'agy:claude-gpt')

  // Spend routine daily/flash headroom slightly ahead or equal: Tier 0 carries workers while
  // Tier 1 (claude-gpt / gemini-4-argon) serves as high-reasoning reviewer.
  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 2,
    includeReviewer: true,
    opencodeModels: ['opencode/deepseek-v4.1-flash-free'],
    agyModels: [
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium',
      'gemini-4-argon-medium'
    ]
  })

  assert.equal(roster.workers.length, 2)
  assert.deepEqual(
    roster.workers.map((worker) => worker.groupKey).sort(),
    ['agy:gemini', 'opencode:opencode/deepseek-v4.1-flash-free']
  )
  assert.equal(roster.reviewer.groupKey, 'agy:claude-gpt')

  // When workerCount=4, workers fan out across all 3 AGY weekly pools plus OpenCode without colliding.
  const wideRoster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 4,
    includeReviewer: false,
    opencodeModels: ['opencode/deepseek-v4.1-flash-free'],
    agyModels: [
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium',
      'gemini-4-argon-medium'
    ]
  })
  assert.deepEqual(
    wideRoster.workers.map((worker) => worker.groupKey).sort(),
    ['agy:claude-gpt', 'agy:gemini', 'agy:gemini-4-argon', 'opencode:opencode/deepseek-v4.1-flash-free']
  )

  // Ahead-of-pace weekly pool steps back behind on-pace Tier 1 weekly pool.
  budget.record('agy', 20, 'gemini-3.8-flash-medium') // 50% on Monday morning -> aheadOfPace
  const pacedRoster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 2,
    includeReviewer: false,
    opencodeModels: ['opencode/deepseek-v4.1-flash-free'],
    agyModels: [
      'gemini-3.8-flash-medium',
      'claude-sonnet-5-5-medium',
      'gemini-4-argon-medium'
    ]
  })
  assert.ok(!pacedRoster.workers.some((worker) => worker.groupKey === 'agy:gemini'))
  assert.ok(
    pacedRoster.workers.some((worker) => worker.groupKey === 'opencode:opencode/deepseek-v4.1-flash-free')
  )
})

test('buildSwarmRoster keeps on-pace Tier 0 AGY workers ahead of fresher Tier 1 pools', () => {
  const clock = clockAt('2026-01-16T20:00:00Z') // Friday UTC, late in the quota week
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '40',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '40',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '40',
      AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '40'
    },
    now: clock.now
  })
  const models = [
    model({
      id: 'opencode',
      provider: 'opencode',
      backend: 'opencode-cli',
      limitKind: 'provider_model',
      cli: { command: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }
    }),
    model({
      id: 'agy',
      provider: 'agy',
      backend: 'agy-cli',
      limitKind: 'provider_model',
      cli: { command: 'agy', model: 'gemini-3.8-flash-medium' }
    })
  ]

  // Tier 0 gemini has less raw headroom than the untouched Tier 1 pools but is
  // still on pace for the week, so workers should spend it before them.
  budget.record('agy', 30, 'gemini-3.8-flash-medium')
  const gemini = budget.snapshot('agy', 'gemini-3.8-flash-medium')
  assert.equal(gemini.pacing.aheadOfPace, false)
  assert.ok(gemini.pacedHeadroom < 1)

  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 2,
    includeReviewer: false,
    opencodeModels: ['opencode/deepseek-v4.1-flash-free'],
    agyModels: [
      'gemini-3.8-flash-medium',
      'claude-sonnet-5-5-medium',
      'gemini-4-argon-medium'
    ]
  })
  assert.ok(roster.workers.some((worker) => worker.groupKey === 'agy:gemini'))
  assert.ok(
    roster.workers.some((worker) => worker.groupKey === 'opencode:opencode/deepseek-v4.1-flash-free')
  )
  assert.ok(!roster.workers.some((worker) => worker.groupKey === 'agy:claude-gpt'))
  assert.ok(!roster.workers.some((worker) => worker.groupKey === 'agy:gemini-4-argon'))
})

test('buildSwarmRoster prefers harvestable 5h session pools and demotes ahead-of-pace argon after syncPoolState', () => {
  const clock = clockAt('2026-11-14T06:35:00Z')
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '100',
      AGY_AI_SESSION_HOURS: '5',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_5H: '45',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '200',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_5H: '40',
      AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK: '200',
      AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK: '100'
    },
    now: clock.now
  })
  budget.syncPoolState('agy', {
    scope: 'gemini-3.8-flash-medium',
    weeklyRemainingPercent: 91.81,
    weeklyResetSeconds: (163 * 3600) + (15 * 60),
    sessionRemainingPercent: 71.33,
    sessionResetSeconds: 15 * 60
  })
  budget.syncPoolState('agy', {
    scope: 'claude-sonnet-5-5-medium',
    weeklyRemainingPercent: 99.95,
    weeklyResetSeconds: (138 * 3600) + (36 * 60),
    sessionRemainingPercent: 100
  })
  budget.syncPoolState('agy', {
    scope: 'gemini-4-argon-medium',
    weeklyRemainingPercent: 57.19,
    weeklyResetSeconds: (163 * 3600) + (10 * 60)
  })

  const models = [
    model({
      id: 'opencode',
      provider: 'opencode',
      backend: 'opencode-cli',
      limitKind: 'provider_model',
      cli: { command: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }
    }),
    model({
      id: 'agy',
      provider: 'agy',
      backend: 'agy-cli',
      limitKind: 'provider_model',
      cli: { command: 'agy', model: 'gemini-3.8-flash-medium' }
    })
  ]

  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 2,
    includeReviewer: true,
    opencodeModels: ['opencode/deepseek-v4.1-flash-free'],
    agyModels: [
      'gemini-3.8-flash-medium',
      'claude-sonnet-5-5-medium',
      'gemini-4-argon-medium'
    ]
  })

  assert.ok(roster.workers.some((worker) => worker.groupKey === 'agy:gemini'))
  assert.ok(!roster.workers.some((worker) => worker.groupKey === 'agy:gemini-4-argon'))
  assert.equal(roster.reviewer?.groupKey, 'agy:claude-gpt')
})

test('console-google API key models share one GCP project domain while running concurrently with agy OAuth', () => {
  const clock = clockAt('2026-11-14T07:00:00Z')
  const budget = createModelBudget({
    env: {
      OPENCODE_AI_GOOGLE_MAX_REQUESTS_PER_DAY: '50',
      OPENCODE_AI_MAX_REQUESTS_PER_DAY: '100',
      AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK: '200'
    },
    now: clock.now
  })

  const models = [
    model({
      id: 'opencode',
      provider: 'opencode',
      backend: 'opencode-cli',
      limitKind: 'provider_model',
      cli: { command: 'opencode', model: 'console-google/gemini-3.8-flash' }
    }),
    model({
      id: 'agy',
      provider: 'agy',
      backend: 'agy-cli',
      limitKind: 'provider_model',
      cli: { command: 'agy', model: 'gemini-3.8-flash-medium' }
    })
  ]

  const g38 = resolveAgentModel(models, 'opencode@console-google/gemini-3.8-flash')
  const g25 = resolveAgentModel(models, 'opencode@console-google/gemini-2.5-flash')
  const agyGem = resolveAgentModel(models, 'agy@gemini-3.8-flash-medium')
  const deepseek = resolveAgentModel(models, 'opencode@opencode/deepseek-v4.1-flash-free')

  assert.equal(modelProviderKey(g38), 'opencode:console-google')
  assert.equal(modelProviderKey(g25), 'opencode:console-google')
  assert.equal(modelProviderKey(agyGem), 'agy:gemini')
  assert.equal(modelProviderKey(deepseek), 'opencode:opencode/deepseek-v4.1-flash-free')

  // Only one worker is scheduled onto opencode:console-google even with multiple console-google models
  // listed, while agy:gemini runs in parallel because OAuth and API key quotas are independent.
  const roster = buildSwarmRoster({
    models,
    modelBudget: budget,
    workerCount: 2,
    includeReviewer: false,
    opencodeModels: ['console-google/gemini-3.8-flash', 'console-google/gemini-2.5-flash'],
    agyModels: ['gemini-3.8-flash-medium']
  })

  const groupKeys = roster.workers.map((worker) => worker.groupKey).sort()
  assert.deepEqual(groupKeys, ['agy:gemini', 'opencode:console-google'])
})

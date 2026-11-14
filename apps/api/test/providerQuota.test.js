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

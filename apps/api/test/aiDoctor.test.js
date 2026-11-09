import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkQuotaConfiguration,
  checkServerlessConfiguration,
  describeQuotaLimiter
} from '../../../scripts/ai-doctor-checks.mjs'

test('quota diagnostics report configured slot windows and missing limits', () => {
  const models = [
    {
      id: 'slot-a',
      label: 'Slot A',
      remote: true,
      quotaLimits: [
        { unit: 'requests', limit: 30, window: 'minute', reset: 'rolling' },
        { unit: 'tokens', limit: 6000, window: 'minute', reset: 'rolling' },
        { unit: 'requests', limit: 100, window: 'session', reset: 'fixed', hours: 5 }
      ]
    },
    { id: 'slot-b', label: 'Slot B', remote: true },
    { id: 'local', label: 'Local model', remote: false }
  ]

  const checks = checkQuotaConfiguration(models, { env: {} })

  assert.equal(checks.length, 2)
  assert.equal(checks[0].level, 'ok')
  assert.match(checks[0].message, /30 requests per rolling minute/)
  assert.match(checks[0].message, /6000 tokens per rolling minute/)
  assert.match(checks[0].message, /100 requests per 5h session/)
  assert.equal(checks[1].level, 'warn')
  assert.match(checks[1].message, /Slot B has no quota profile or daily request limit/)
})

test('quota diagnostics read legacy daily limits for every remote model', () => {
  const models = [
    { id: 'serverless', label: 'Serverless', remote: true },
    { id: 'colab-3b', label: 'Colab', remote: true },
    { id: 'kaggle-3b', label: 'Kaggle', remote: true }
  ]

  const checks = checkQuotaConfiguration(models, {
    env: {
      SERVERLESS_AI_MAX_REQUESTS_PER_DAY: '20',
      COLAB_AI_MAX_REQUESTS_PER_DAY: '10',
      KAGGLE_AI_MAX_REQUESTS_PER_DAY: '5'
    }
  })

  assert.deepEqual(checks.map((check) => check.level), ['ok', 'ok', 'ok'])
  assert.match(checks[0].message, /20 requests per fixed day \(UTC\)/)
  assert.match(checks[1].message, /10 requests per fixed day \(UTC\)/)
  assert.match(checks[2].message, /5 requests per fixed day \(UTC\)/)
})

test('quota diagnostics honor AI_QUOTA_PROFILES and describe pools', () => {
  const models = [{ id: 'slot-a', label: 'Slot A', remote: true }]
  const checks = checkQuotaConfiguration(models, {
    env: {
      AI_QUOTA_PROFILES: JSON.stringify({
        'slot-a': [{
          unit: 'tokens',
          limit: 1000,
          window: 'week',
          reset: 'fixed',
          timezone: 'America/New_York'
        }]
      })
    }
  })

  assert.equal(checks[0].level, 'ok')
  assert.match(checks[0].message, /1000 tokens per fixed week \(America\/New_York\)/)
  assert.equal(
    describeQuotaLimiter({ unit: 'compute_seconds', limit: 10, reset: 'pool' }),
    '10 compute seconds in a depleting pool'
  )
})

test('quota diagnostics report invalid profiles as errors', () => {
  const checks = checkQuotaConfiguration([
    {
      id: 'slot-a',
      label: 'Slot A',
      remote: true,
      quotaLimits: [{ unit: 'nonsense', limit: 1 }]
    }
  ], { env: {} })

  assert.equal(checks.length, 1)
  assert.equal(checks[0].level, 'error')
  assert.equal(checks[0].area, 'quota')
  assert.match(checks[0].message, /unknown unit/)
})

test('serverless diagnostics flag incomplete slots and report wire shape', () => {
  const models = [
    {
      id: 'serverless',
      label: 'Serverless',
      provider: 'serverless',
      apiKeyEnv: 'SERVERLESS_AI_API_KEY',
      chatPath: '/v1/chat/completions',
      healthPath: '/v1/models',
      supportsJsonMode: false,
      autoSelect: false
    },
    {
      id: 'slot-a',
      label: 'Slot A',
      provider: 'serverless',
      apiModel: 'provider/model-a',
      apiKey: 'secret',
      apiKeyEnv: 'SLOT_A_KEY',
      chatPath: '/chat/completions',
      healthPath: '/models',
      supportsJsonMode: true,
      autoSelect: true
    },
    { id: 'local', label: 'Local model', provider: 'local' }
  ]

  const checks = checkServerlessConfiguration(models)
  const warnings = checks.filter((check) => check.level === 'warn')
  const oks = checks.filter((check) => check.level === 'ok')

  assert.equal(checks.length, 4)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0].message, /no apiModel configured/)
  assert.match(warnings[1].message, /SERVERLESS_AI_API_KEY is not set/)
  assert.equal(oks.length, 2)
  assert.match(
    oks[0].message,
    /chat \/v1\/chat\/completions, health \/v1\/models, JSON mode prompt-enforced.*auto-select off/
  )
  assert.match(
    oks[1].message,
    /chat \/chat\/completions, health \/models, JSON mode enabled, auto-select on/
  )
})

test('serverless diagnostics warn when no key source is configured', () => {
  const checks = checkServerlessConfiguration([{
    id: 'slot-a',
    label: 'Slot A',
    provider: 'serverless',
    apiModel: 'provider/model-a',
    chatPath: '/v1/chat/completions',
    healthPath: '/v1/models',
    supportsJsonMode: false,
    autoSelect: false
  }])

  assert.equal(checks[0].level, 'warn')
  assert.match(checks[0].message, /no API key or apiKeyEnv configured/)
})

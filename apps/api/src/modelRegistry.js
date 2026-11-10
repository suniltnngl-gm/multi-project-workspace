import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Local model definitions. Each local model runs as its own llama.cpp server,
 * so both can be available at the same time when memory and CPU limits allow.
 */
export const LOCAL_MODEL_DEFINITIONS = Object.freeze([
  {
    id: 'local-0.5b',
    label: 'Qwen2.5-Coder 0.5B (local)',
    provider: 'local',
    execution: 'live',
    backend: 'http',
    callable: true,
    remote: false,
    launchKey: '0.5b',
    priority: 10,
    defaultPort: 8080,
    portEnv: 'LOCAL_AI_0_5B_PORT',
    urlEnv: 'LOCAL_AI_0_5B_URL',
    fallbackUrlEnv: 'LOCAL_AI_URL',
    modelFileEnv: 'LOCAL_AI_0_5B_MODEL',
    defaultModelFile: 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf',
    defaultMinAvailableMemoryMb: 1024,
    minMemoryEnv: 'LOCAL_AI_MIN_AVAILABLE_MEMORY_MB',
    timeoutEnv: 'LOCAL_AI_TIMEOUT_MS',
    defaultTimeoutMs: 120000
  },
  {
    id: 'local-1.5b',
    label: 'Qwen2.5-Coder 1.5B (local)',
    provider: 'local',
    execution: 'live',
    backend: 'http',
    callable: true,
    remote: false,
    launchKey: '1.5b',
    priority: 20,
    defaultPort: 8081,
    portEnv: 'LOCAL_AI_1_5B_PORT',
    urlEnv: 'LOCAL_AI_1_5B_URL',
    modelFileEnv: 'LOCAL_AI_1_5B_MODEL',
    defaultModelFile: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
    defaultMinAvailableMemoryMb: 1792,
    minMemoryEnv: 'LOCAL_AI_1_5B_MIN_AVAILABLE_MEMORY_MB',
    timeoutEnv: 'LOCAL_AI_TIMEOUT_MS',
    defaultTimeoutMs: 120000
  }
])

const SERVERLESS_SLOTS_ENV = 'SERVERLESS_AI_SLOTS'
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * A provider-agnostic OpenAI-compatible slot. The provider slug and endpoint
 * stay in environment variables so no vendor-specific branch enters the code.
 * It is registered only when SERVERLESS_AI_URL is set. Additional slots can be
 * declared as JSON in SERVERLESS_AI_SLOTS; the legacy variables keep working.
 */
export const SERVERLESS_MODEL_DEFINITION = Object.freeze({
  id: 'serverless',
  label: 'Serverless API model',
  provider: 'serverless',
  execution: 'live',
  backend: 'http',
  callable: true,
  remote: true,
  priority: 9,
  urlEnv: 'SERVERLESS_AI_URL',
  apiKeyEnv: 'SERVERLESS_AI_API_KEY',
  apiModelEnv: 'SERVERLESS_AI_MODEL',
  timeoutEnv: 'SERVERLESS_AI_TIMEOUT_MS',
  autoSelectEnv: 'SERVERLESS_AI_AUTO_SELECT',
  jsonModeEnv: 'SERVERLESS_AI_SUPPORTS_JSON_MODE',
  chatPathEnv: 'SERVERLESS_AI_CHAT_PATH',
  healthPathEnv: 'SERVERLESS_AI_HEALTH_PATH',
  defaultTimeoutMs: 60000,
  minAvailableMemoryMb: 0,
  notes: 'OpenAI-compatible endpoint configured by SERVERLESS_AI_URL; set SERVERLESS_AI_MODEL to the provider model slug.'
})

/**
 * Web models call the Colab/Kaggle CLIs by default. Setting an HTTP URL opts
 * the model into a faster live endpoint instead; the CLI backend is skipped.
 */
export const EXTERNAL_MODEL_DEFINITIONS = Object.freeze([
  {
    id: 'colab-3b',
    label: 'Qwen2.5-Coder 3B (Colab)',
    provider: 'colab',
    execution: 'live',
    backend: 'colab-cli',
    callable: true,
    remote: true,
    priority: 8,
    urlEnv: 'COLAB_AI_URL',
    apiKeyEnv: 'COLAB_AI_API_KEY',
    timeoutEnv: 'COLAB_AI_TIMEOUT_MS',
    autoSelectEnv: 'COLAB_AI_AUTO_SELECT',
    defaultTimeoutMs: 900000,
    minAvailableMemoryMb: 0,
    notes: 'Calls a reusable Colab session through the colab CLI; set COLAB_AI_URL for a faster HTTP endpoint.'
  },
  {
    id: 'kaggle-3b',
    label: 'Qwen2.5-Coder 3B (Kaggle)',
    provider: 'kaggle',
    execution: 'batch',
    backend: 'kaggle-cli',
    callable: true,
    remote: true,
    priority: 7,
    urlEnv: 'KAGGLE_AI_URL',
    apiKeyEnv: 'KAGGLE_AI_API_KEY',
    timeoutEnv: 'KAGGLE_AI_TIMEOUT_MS',
    autoSelectEnv: 'KAGGLE_AI_AUTO_SELECT',
    defaultTimeoutMs: 3600000,
    minAvailableMemoryMb: 0,
    notes: 'Submits a private Kaggle notebook through the kaggle CLI; set KAGGLE_AI_URL for a faster HTTP endpoint.'
  },
  {
    id: 'opencode',
    label: 'OpenCode headless',
    provider: 'opencode',
    execution: 'live',
    backend: 'opencode-cli',
    callable: true,
    remote: true,
    priority: 6,
    urlEnv: 'OPENCODE_AI_URL',
    apiKeyEnv: 'OPENCODE_AI_API_KEY',
    timeoutEnv: 'OPENCODE_AI_TIMEOUT_MS',
    autoSelectEnv: 'OPENCODE_AI_AUTO_SELECT',
    defaultTimeoutMs: 300000,
    minAvailableMemoryMb: 0,
    notes: 'Runs OpenCode in headless mode; set OPENCODE_AI_MODEL to choose a provider/model.'
  }
])

function readNumber(env, key, fallback) {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number.`)
  }
  return parsed
}

function readText(env, key, fallback) {
  const value = env[key]
  return value === undefined || value === '' ? fallback : value
}

function readBoolean(env, key, fallback) {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

function readList(env, key, fallback = []) {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function trimUrl(url) {
  return url.replace(/\/+$/, '')
}

function resolvePort(definition, env, url) {
  const explicitPort = definition.portEnv
    ? readNumber(env, definition.portEnv, undefined)
    : undefined
  if (explicitPort !== undefined) return explicitPort
  if (url) {
    try {
      const parsedPort = Number(new URL(url).port)
      if (Number.isInteger(parsedPort) && parsedPort > 0) return parsedPort
    } catch {
      // A malformed URL surfaces through the API's reachability check.
    }
  }
  return definition.defaultPort
}

function readPath(env, key, fallback) {
  const value = readText(env, key, fallback)
  return value.startsWith('/') ? value : `/${value}`
}

function readUrl(env, key) {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${key} must be a valid http(s) URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${key} must be a valid http(s) URL.`)
  }
  return trimUrl(value)
}

function createCliConfig(env) {
  const colabGpus = readList(
    env,
    'COLAB_AI_GPUS',
    [readText(env, 'COLAB_AI_GPU', 'T4')]
  )
  return {
    colab: {
      command: 'colab',
      probeArgs: ['sessions'],
      session: readText(env, 'COLAB_AI_SESSION', 'workspace-qwen'),
      auditDir: readText(env, 'COLAB_AI_AUDIT_DIR', ''),
      // `gpu` stays for compatibility; `gpus` is the ordered fallback list.
      gpu: colabGpus[0] ?? 'T4',
      gpus: colabGpus.length > 0 ? colabGpus : ['T4'],
      newRetries: readNumber(env, 'COLAB_AI_NEW_RETRIES', 1),
      retryBackoffMs: readNumber(env, 'COLAB_AI_RETRY_BACKOFF_MS', 15000),
      port: readNumber(env, 'COLAB_AI_PORT', 8765),
      modelId: readText(env, 'COLAB_AI_MODEL', 'Qwen/Qwen2.5-Coder-3B-Instruct'),
      bootstrapTimeoutMs: readNumber(env, 'COLAB_AI_BOOTSTRAP_TIMEOUT_MS', 1800000)
    },
    kaggle: {
      command: 'kaggle',
      probeArgs: ['config', 'view'],
      python: readText(env, 'KAGGLE_AI_PYTHON', 'python3'),
      pollIntervalSeconds: readNumber(env, 'KAGGLE_AI_POLL_INTERVAL_SECONDS', 30),
      cancelFallback: readText(env, 'KAGGLE_AI_CANCEL_FALLBACK', 'none')
    },
    opencode: {
      command: 'opencode',
      probeArgs: ['--version'],
      model: readText(env, 'OPENCODE_AI_MODEL', 'opencode/beam-free'),
      agent: readText(env, 'OPENCODE_AI_AGENT', ''),
      auditDir: readText(env, 'OPENCODE_AI_AUDIT_DIR', ''),
      timeoutMs: readNumber(env, 'OPENCODE_AI_TIMEOUT_MS', 300000)
    }
  }
}

function readSlotUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a valid http(s) URL.`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be a valid http(s) URL.`)
  }
  return trimUrl(value.trim())
}

function readSlotNumber(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`)
  }
  return parsed
}

function readSlotBoolean(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
  }
  throw new Error(`${label} must be a boolean.`)
}

function readSlotPath(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a path string.`)
  }
  return value.startsWith('/') ? value : `/${value}`
}

function readSlotText(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`)
  }
  const text = value.trim()
  return text === '' ? undefined : text
}

function buildServerlessModel(definition, config) {
  return {
    id: config.id,
    label: config.label,
    provider: definition.provider,
    execution: definition.execution,
    backend: definition.backend,
    callable: true,
    remote: true,
    priority: config.priority,
    url: config.url,
    // An explicitly configured serverless endpoint is still opt-in: a missing
    // model does not silently spend a third-party quota.
    autoSelect: config.autoSelect,
    timeoutMs: config.timeoutMs,
    minAvailableMemoryMb: 0,
    // Existing local/HTTP models keep JSON mode by default; a new provider
    // opts in explicitly because not every API supports response_format.
    supportsJsonMode: config.supportsJsonMode,
    chatPath: config.chatPath,
    healthPath: config.healthPath,
    notes: config.notes ?? definition.notes,
    ...(config.apiModel ? { apiModel: config.apiModel } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.quotaLimits ? { quotaLimits: config.quotaLimits } : {})
  }
}

function createServerlessModel(env) {
  const definition = SERVERLESS_MODEL_DEFINITION
  const url = readUrl(env, definition.urlEnv)
  if (!url) return null

  return buildServerlessModel(definition, {
    id: definition.id,
    label: definition.label,
    priority: definition.priority,
    url,
    apiModel: readText(env, definition.apiModelEnv, ''),
    apiKey: env[definition.apiKeyEnv],
    apiKeyEnv: definition.apiKeyEnv,
    timeoutMs: readNumber(env, definition.timeoutEnv, definition.defaultTimeoutMs),
    autoSelect: readBoolean(env, definition.autoSelectEnv, false),
    supportsJsonMode: readBoolean(env, definition.jsonModeEnv, false),
    chatPath: readPath(env, definition.chatPathEnv, '/v1/chat/completions'),
    healthPath: readPath(env, definition.healthPathEnv, '/v1/models')
  })
}

function createServerlessSlots(env) {
  const raw = env[SERVERLESS_SLOTS_ENV]
  if (raw === undefined || raw === '') return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SERVERLESS_SLOTS_ENV} must be valid JSON.`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${SERVERLESS_SLOTS_ENV} must be a JSON array of slot objects.`)
  }

  const seen = new Set()
  return parsed.map((entry, index) => {
    const at = `${SERVERLESS_SLOTS_ENV}[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object.`)
    }

    const id = readSlotText(entry.id, `${at}.id`)
    if (!id) {
      throw new Error(`${at} needs a non-empty string id.`)
    }
    if (!MODEL_ID_PATTERN.test(id)) {
      throw new Error(`${at}.id "${id}" may contain only letters, numbers, dot, underscore, and dash.`)
    }
    if (seen.has(id)) {
      throw new Error(`${at} duplicates the serverless slot id "${id}".`)
    }
    seen.add(id)

    const apiKeyEnv = readSlotText(entry.apiKeyEnv, `${at}.apiKeyEnv`)
    const apiKey = apiKeyEnv ? env[apiKeyEnv] : entry.apiKey
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new Error(`${at}.apiKey must be a string.`)
    }
    if (entry.limits !== undefined && !Array.isArray(entry.limits)) {
      throw new Error(`${at}.limits must be an array of quota limiters.`)
    }

    return buildServerlessModel(SERVERLESS_MODEL_DEFINITION, {
      id,
      label: readSlotText(entry.label, `${at}.label`) ?? `Serverless ${id}`,
      priority: readSlotNumber(entry.priority, `${at}.priority`, SERVERLESS_MODEL_DEFINITION.priority),
      url: readSlotUrl(entry.url, `${at}.url`),
      apiModel: readSlotText(entry.apiModel, `${at}.apiModel`),
      apiKey: apiKey || undefined,
      apiKeyEnv,
      notes: 'OpenAI-compatible endpoint configured by SERVERLESS_AI_SLOTS.',
      timeoutMs: readSlotNumber(
        entry.timeoutMs,
        `${at}.timeoutMs`,
        SERVERLESS_MODEL_DEFINITION.defaultTimeoutMs
      ),
      autoSelect: readSlotBoolean(entry.autoSelect, `${at}.autoSelect`, false),
      supportsJsonMode: readSlotBoolean(
        entry.supportsJsonMode,
        `${at}.supportsJsonMode`,
        false
      ),
      chatPath: readSlotPath(
        entry.chatPath,
        `${at}.chatPath`,
        '/v1/chat/completions'
      ),
      healthPath: readSlotPath(entry.healthPath, `${at}.healthPath`, '/v1/models'),
      quotaLimits: entry.limits
    })
  })
}

/**
 * Build the registry consumed by the API and the workspace launcher.
 * `localAiUrl` is kept for compatibility with older callers and tests that
 * only configured a single local endpoint.
 */
export function createModelRegistry({ env = process.env, localAiUrl } = {}) {
  const cli = createCliConfig(env)
  const localModels = LOCAL_MODEL_DEFINITIONS.map((definition) => {
    const explicitPort = readNumber(env, definition.portEnv, undefined)
    const assumedPort = explicitPort ?? definition.defaultPort
    const explicitUrl = definition.urlEnv ? env[definition.urlEnv] : undefined
    const fallbackUrl = definition.fallbackUrlEnv ? env[definition.fallbackUrlEnv] : undefined
    const compatibilityUrl = definition.id === 'local-0.5b' ? localAiUrl : undefined
    const rawUrl = explicitUrl || compatibilityUrl || fallbackUrl || `http://127.0.0.1:${assumedPort}`
    const url = trimUrl(rawUrl)

    return {
      ...definition,
      execution: 'live',
      backend: 'http',
      callable: true,
      autoSelect: true,
      port: resolvePort(definition, env, url),
      url,
      timeoutMs: readNumber(env, definition.timeoutEnv, definition.defaultTimeoutMs),
      minAvailableMemoryMb: readNumber(
        env,
        definition.minMemoryEnv,
        definition.defaultMinAvailableMemoryMb
      )
    }
  })

  const externalModels = EXTERNAL_MODEL_DEFINITIONS.map((definition) => {
    const url = readUrl(env, definition.urlEnv)
    const apiKey = definition.apiKeyEnv ? env[definition.apiKeyEnv] : undefined
    const backend = url ? 'http' : definition.backend
    const model = {
      ...definition,
      execution: url ? 'live' : definition.execution,
      backend,
      callable: true,
      // CLI-backed models opt out of implicit selection so a request without
      // a model does not unexpectedly spend Colab/Kaggle quota. A configured
      // HTTP endpoint is treated like any other live endpoint.
      autoSelect: readBoolean(env, definition.autoSelectEnv, Boolean(url)),
      timeoutMs: readNumber(env, definition.timeoutEnv, definition.defaultTimeoutMs),
      minAvailableMemoryMb: definition.minAvailableMemoryMb ?? 0,
      ...(url ? { url } : {}),
      ...(apiKey ? { apiKey } : {})
    }

    if (backend === 'colab-cli') model.cli = cli.colab
    if (backend === 'kaggle-cli') model.cli = cli.kaggle
    if (backend === 'opencode-cli') model.cli = cli.opencode
    return model
  })

  const legacyServerless = createServerlessModel(env)
  const serverlessModels = [
    ...(legacyServerless ? [legacyServerless] : []),
    ...createServerlessSlots(env)
  ]
  const models = [
    ...localModels,
    ...serverlessModels,
    ...externalModels
  ]

  const seen = new Set()
  for (const model of models) {
    if (seen.has(model.id)) {
      throw new Error(`Model id "${model.id}" is registered more than once.`)
    }
    seen.add(model.id)
  }
  return models
}

/**
 * Collect per-slot quota limiters from the registry. The budget receives these
 * as explicit profiles, so a slot can carry its own quota shape without a
 * second environment variable keyed by id.
 */
export function modelQuotaProfiles(models) {
  return Object.fromEntries(
    models
      .filter((model) => Array.isArray(model.quotaLimits) && model.quotaLimits.length > 0)
      .map((model) => [model.id, model.quotaLimits])
  )
}

/**
 * Resolve which local model servers the launcher should start. The result is
 * pure data so it can be tested without spawning llama-server.
 */
export function planLocalModelLaunches({
  env = process.env,
  requested = 'all',
  homeDir = os.homedir(),
  availableMemoryMb = Infinity,
  fileExists = existsSync
} = {}) {
  const selected = requested === 'all'
    ? LOCAL_MODEL_DEFINITIONS
    : LOCAL_MODEL_DEFINITIONS.filter((definition) => definition.launchKey === requested)

  if (selected.length === 0) {
    throw new Error(`Unknown local model "${requested}". Use all, 0.5b, or 1.5b.`)
  }

  let reservedMemoryMb = 0
  return selected.map((definition) => {
    const configuredUrl = (definition.urlEnv && env[definition.urlEnv])
      || (definition.fallbackUrlEnv && env[definition.fallbackUrlEnv])
    const port = resolvePort(definition, env, configuredUrl)
    const modelPath = readText(
      env,
      definition.modelFileEnv,
      path.join(homeDir, '.local/share/llama.cpp/models', definition.defaultModelFile)
    )
    const minAvailableMemoryMb = readNumber(
      env,
      definition.minMemoryEnv,
      definition.defaultMinAvailableMemoryMb
    )
    const exists = fileExists(modelPath)
    const fits = availableMemoryMb - reservedMemoryMb >= minAvailableMemoryMb
    if (exists && fits) reservedMemoryMb += minAvailableMemoryMb

    return {
      ...definition,
      port,
      modelPath,
      minAvailableMemoryMb,
      exists,
      fits
    }
  })
}

export function publicModelDefinition(model) {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    execution: model.execution,
    backend: model.backend,
    callable: model.callable,
    autoSelect: model.autoSelect ?? true,
    priority: model.priority,
    ...(model.minAvailableMemoryMb !== undefined
      ? { minAvailableMemoryMb: model.minAvailableMemoryMb }
      : {}),
    ...(model.notes ? { notes: model.notes } : {})
  }
}

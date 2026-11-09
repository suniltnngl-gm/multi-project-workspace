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
    launchKey: '0.5b',
    priority: 10,
    defaultPort: 8080,
    portEnv: 'LOCAL_AI_0_5B_PORT',
    urlEnv: 'LOCAL_AI_0_5B_URL',
    fallbackUrlEnv: 'LOCAL_AI_URL',
    modelFileEnv: 'LOCAL_AI_0_5B_MODEL',
    defaultModelFile: 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf',
    defaultMinAvailableMemoryMb: 1024,
    minMemoryEnv: 'LOCAL_AI_MIN_AVAILABLE_MEMORY_MB'
  },
  {
    id: 'local-1.5b',
    label: 'Qwen2.5-Coder 1.5B (local)',
    provider: 'local',
    execution: 'live',
    launchKey: '1.5b',
    priority: 20,
    defaultPort: 8081,
    portEnv: 'LOCAL_AI_1_5B_PORT',
    urlEnv: 'LOCAL_AI_1_5B_URL',
    modelFileEnv: 'LOCAL_AI_1_5B_MODEL',
    defaultModelFile: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
    defaultMinAvailableMemoryMb: 1792,
    minMemoryEnv: 'LOCAL_AI_1_5B_MIN_AVAILABLE_MEMORY_MB'
  }
])

/**
 * Web models default to manual/batch. Setting a URL (for example a
 * user-managed tunnel to an OpenAI-compatible server in the notebook) opts the
 * model into live calls; without one the API never contacts it.
 */
export const EXTERNAL_MODEL_DEFINITIONS = Object.freeze([
  {
    id: 'colab-3b',
    label: 'Qwen2.5-Coder 3B (Colab)',
    provider: 'colab',
    execution: 'manual',
    defaultExecution: 'manual',
    remote: true,
    priority: 8,
    urlEnv: 'COLAB_AI_URL',
    apiKeyEnv: 'COLAB_AI_API_KEY',
    minAvailableMemoryMb: 0,
    notes: 'Run notebooks/colab-qwen-coder-free-tier.ipynb in Colab, or set COLAB_AI_URL to a live endpoint.'
  },
  {
    id: 'kaggle-3b',
    label: 'Qwen2.5-Coder 3B (Kaggle)',
    provider: 'kaggle',
    execution: 'batch',
    defaultExecution: 'batch',
    remote: true,
    priority: 7,
    urlEnv: 'KAGGLE_AI_URL',
    apiKeyEnv: 'KAGGLE_AI_API_KEY',
    minAvailableMemoryMb: 0,
    notes: 'Submit notebooks/kaggle-qwen-coder.ipynb with scripts/kaggle_run.py, or set KAGGLE_AI_URL to a live endpoint.'
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

/**
 * Build the registry consumed by the API and the workspace launcher.
 * `localAiUrl` is kept for compatibility with older callers and tests that
 * only configured a single local endpoint.
 */
export function createModelRegistry({ env = process.env, localAiUrl } = {}) {
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
      port: resolvePort(definition, env, url),
      url,
      minAvailableMemoryMb: readNumber(
        env,
        definition.minMemoryEnv,
        definition.defaultMinAvailableMemoryMb
      )
    }
  })

  const externalModels = EXTERNAL_MODEL_DEFINITIONS.map((definition) => {
    const url = readUrl(env, definition.urlEnv)
    if (!url) {
      return {
        ...definition,
        execution: definition.defaultExecution,
        minAvailableMemoryMb: definition.minAvailableMemoryMb ?? 0
      }
    }
    const apiKey = definition.apiKeyEnv ? env[definition.apiKeyEnv] : undefined
    return {
      ...definition,
      execution: 'live',
      url,
      ...(apiKey ? { apiKey } : {}),
      minAvailableMemoryMb: definition.minAvailableMemoryMb ?? 0
    }
  })

  return [...localModels, ...externalModels]
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
    priority: model.priority,
    ...(model.minAvailableMemoryMb !== undefined
      ? { minAvailableMemoryMb: model.minAvailableMemoryMb }
      : {}),
    ...(model.notes ? { notes: model.notes } : {})
  }
}

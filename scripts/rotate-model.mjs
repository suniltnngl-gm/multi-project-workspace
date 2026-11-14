#!/usr/bin/env node
// Objective: Rotate OpenCode (4+1 providers) or Antigravity (agy) headless models daily so one exhausted quota does not block the workspace.
// Requirements: Update OPENCODE_AI_MODEL or AGY_AI_MODEL in .env when rotating; support all 4+1 OpenCode providers and agy; never rotate a key into the database or git.
// Decisions: Rotation state lives in the OS temp directory (WORKSPACE_TMP_DIR override) because it is local scheduling state, not workspace data; .env is the only sink so the server sees the model after restart.
// Relevant Files: scripts/rotate-model.mjs, scripts/model-study.mjs, scripts/opencode-console.mjs, workspace, .env
// Important Context: User file. .env is gitignored; supports OpenCode's 4+1 providers (console-google, console-groq, console-nvidia, console-openrouter, opencode) and agy.
// Work State: Completed: Updated for OpenCode 4+1 providers and agy headless; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  GEMINI_API_FREE_TIER_MODELS,
  isProOnlyGeminiModel
} from '../apps/api/src/modelRegistry.js'
import { workspaceTmpDir } from './env.mjs'

export const OPENCODE_PROVIDERS = {
  'console-groq': [
    'console-groq/openai/gpt-oss-120b',
    'console-groq/qwen/qwen3.8-27b',
    'console-groq/openai/gpt-oss-20b',
    'console-groq/allam-2-7b'
  ],
  'console-nvidia': [
    'console-nvidia/deepseek-ai/deepseek-v4.1-flash',
    'console-nvidia/nvidia/nemotron-3-ultra-550b-a55b',
    'console-nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
    'console-nvidia/minimaxai/minimax-m3.1-flash',
    'console-nvidia/z-ai/glm-5.3-flash'
  ],
  'console-openrouter': [
    'console-openrouter/openrouter/free',
    'console-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'console-openrouter/nvidia/nemotron-3.5-lightning:free',
    'console-openrouter/google/gemma-4-31b-it:free',
    'console-openrouter/cohere/north-mini-code:free'
  ],
  opencode: [
    'opencode/big-pickle',
    'opencode/deepseek-v4.1-flash-free',
    'opencode/glm-5.3-flash-free',
    'opencode/minimax-m3.1-flash-free',
    'opencode/nemotron-3.5-lightning-free',
    'opencode/beam-free'
  ]
}

export const OPENCODE_PROVIDER_ORDER = Object.freeze([
  'console-groq',
  'console-nvidia',
  'console-openrouter',
  'opencode'
])

export const AGY_POOLS = {
  gemini: [
    'gemini-3.8-flash-medium',
    'gemini-4-hydrogen-medium',
    'gemini-3.8-flash-high'
  ],
  'claude-gpt': [
    'claude-sonnet-5-5-medium',
    'claude-opus-5-5-medium',
    'gpt-oss-120b-medium'
  ],
  'gemini-4-argon': [
    'gemini-4-argon-medium',
    'gemini-4-argon-high'
  ]
}

export const AGY_POOL_ORDER = Object.freeze(['gemini', 'claude-gpt', 'gemini-4-argon'])

export const AGY_MODELS = AGY_POOL_ORDER.flatMap((pool) => AGY_POOLS[pool])

export const GEMINI_API_MODELS = GEMINI_API_FREE_TIER_MODELS

function parseOptions(argv) {
  let backend = 'opencode'
  let provider = ''
  let pool = ''
  let model = ''
  let dryRun = false
  let list = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--list') {
      list = true
    } else if (arg === '--backend' && argv[index + 1]) {
      backend = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--backend=')) {
      backend = arg.slice('--backend='.length)
    } else if (arg === '--provider' && argv[index + 1]) {
      provider = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length)
    } else if (arg === '--pool' && argv[index + 1]) {
      pool = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--pool=')) {
      pool = arg.slice('--pool='.length)
    } else if (arg === '--model' && argv[index + 1]) {
      model = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length)
    } else if (!arg.startsWith('-') && !model && (backend === 'gemini-api' || provider === 'gemini-api')) {
      model = arg
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (provider === 'agy') backend = 'agy'
  if (provider === 'gemini-api') backend = 'gemini-api'
  if (backend === 'agy' && !pool && provider && provider !== 'agy') {
    pool = provider
  }
  if (backend === 'gemini-api' && !model && provider && provider !== 'gemini-api') {
    model = provider
  }
  if (!['opencode', 'agy', 'gemini-api'].includes(backend)) {
    throw new Error(`Unsupported backend "${backend}". Use opencode, agy, or gemini-api.`)
  }
  if (backend === 'opencode' && provider && !Object.hasOwn(OPENCODE_PROVIDERS, provider)) {
    throw new Error(
      `Unknown OpenCode provider "${provider}". Available: ${OPENCODE_PROVIDER_ORDER.join(', ')}`
    )
  }
  if (backend === 'agy' && pool && !Object.hasOwn(AGY_POOLS, pool)) {
    throw new Error(
      `Unknown Antigravity weekly pool "${pool}". Available: ${AGY_POOL_ORDER.join(', ')}`
    )
  }
  if (backend === 'gemini-api' && model) {
    if (isProOnlyGeminiModel(model)) {
      throw new Error(
        `Model "${model}" requires a paid tier and is blocked on the Free-tier gemini-api lane; use --backend agy --pool gemini-4-argon instead.`
      )
    }
    if (!GEMINI_API_MODELS.includes(model)) {
      throw new Error(
        `Unknown gemini-api Free-tier model "${model}". Available: ${GEMINI_API_MODELS.join(', ')}`
      )
    }
  }
  return { backend, provider, pool, model, dryRun, list }
}

function updateEnvKey(envPath, key, value) {
  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  if (pattern.test(env)) {
    env = env.replace(pattern, `${key}=${value}`)
  } else {
    const prefix = env && !env.endsWith('\n') ? '\n' : ''
    env += `${prefix}${key}=${value}\n`
  }
  writeFileSync(envPath, env)
}

function main() {
  const { backend, provider, pool: agyPool, model: explicitModel, dryRun, list } = parseOptions(process.argv.slice(2))

  if (list) {
    if (backend === 'gemini-api') {
      console.log('gemini-api (keyring Free-tier roster):')
      for (const entry of GEMINI_API_MODELS) console.log(`  - ${entry}`)
      return
    }
    if (backend === 'agy') {
      const targetPools = agyPool ? [agyPool] : AGY_POOL_ORDER
      for (const entry of targetPools) {
        console.log(`agy weekly pool [${entry}]:`)
        for (const model of AGY_POOLS[entry]) console.log(`  - ${model}`)
      }
      return
    }
    const targetProviders = provider ? [provider] : OPENCODE_PROVIDER_ORDER
    for (const entry of targetProviders) {
      console.log(`${entry}:`)
      for (const model of OPENCODE_PROVIDERS[entry]) console.log(`  - ${model}`)
    }
    return
  }

  const tmpDir = workspaceTmpDir()
  const stateFile = join(tmpDir, 'rotation-state.json')
  let state = {
    day: 0,
    providerIndex: 0,
    indices: Object.fromEntries(OPENCODE_PROVIDER_ORDER.map((name) => [name, 0])),
    agyDay: 0,
    agyIndex: 0,
    agyPoolIndex: 0,
    agyIndices: Object.fromEntries(AGY_POOL_ORDER.map((name) => [name, 0])),
    geminiApiDay: 0,
    geminiApiIndex: 0
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      state = {
        ...state,
        ...parsed,
        indices: { ...state.indices, ...(parsed.indices || {}) },
        agyIndices: { ...state.agyIndices, ...(parsed.agyIndices || {}) }
      }
    }
  } catch {
    // Use initial state when no state file exists yet.
  }

  const today = Math.floor(Date.now() / 86400000)
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')

  if (backend === 'gemini-api') {
    const nextState = { ...state }
    const dayAdvanced = nextState.geminiApiDay !== today
    let index = Number(nextState.geminiApiIndex || 0) % GEMINI_API_MODELS.length
    if (explicitModel) {
      index = GEMINI_API_MODELS.indexOf(explicitModel)
      nextState.geminiApiDay = today
    } else if (dayAdvanced) {
      nextState.geminiApiDay = today
      index = (index + 1) % GEMINI_API_MODELS.length
    }
    nextState.geminiApiIndex = index
    const targetModel = GEMINI_API_MODELS[index]
    if (!dryRun) {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify(nextState, null, 2))
      updateEnvKey(envPath, 'GEMINI_API_MODEL', targetModel)
    }
    console.log(`${dryRun ? '[dry-run] Would rotate' : 'Rotated'} gemini-api model: ${targetModel}`)
    console.log(`   State: day=${today}, index=${index}`)
    return
  }

  if (backend === 'agy') {
    const nextState = {
      ...state,
      agyIndices: { ...state.agyIndices }
    }
    const dayAdvanced = nextState.agyDay !== today
    const activePool = agyPool || AGY_POOL_ORDER[
      dayAdvanced
        ? (Number(nextState.agyPoolIndex || 0) + 1) % AGY_POOL_ORDER.length
        : Number(nextState.agyPoolIndex || 0) % AGY_POOL_ORDER.length
    ]
    const poolModels = AGY_POOLS[activePool]
    if (dayAdvanced) {
      nextState.agyDay = today
      if (!agyPool) {
        nextState.agyPoolIndex = (Number(nextState.agyPoolIndex || 0) + 1) % AGY_POOL_ORDER.length
      }
      nextState.agyIndices[activePool] = (Number(nextState.agyIndices[activePool] || 0) + 1) % poolModels.length
    }
    const index = Number(nextState.agyIndices[activePool] || 0) % poolModels.length
    const model = poolModels[index]
    nextState.agyIndex = Math.max(0, AGY_MODELS.indexOf(model))
    if (!dryRun) {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify(nextState, null, 2))
      updateEnvKey(envPath, 'AGY_AI_MODEL', model)
    }
    console.log(`${dryRun ? '[dry-run] Would rotate' : 'Rotated'} agy [${activePool}] model: ${model}`)
    console.log(`   State: day=${today}, pool=${activePool}, index=${index}`)
    return
  }

  const nextState = {
    ...state,
    indices: { ...state.indices }
  }
  const activeProvider = provider || OPENCODE_PROVIDER_ORDER[
    nextState.day !== today
      ? (Number(nextState.providerIndex || 0) + 1) % OPENCODE_PROVIDER_ORDER.length
      : Number(nextState.providerIndex || 0) % OPENCODE_PROVIDER_ORDER.length
  ]
  if (nextState.day !== today) {
    nextState.day = today
    if (!provider) {
      nextState.providerIndex = (Number(nextState.providerIndex || 0) + 1) % OPENCODE_PROVIDER_ORDER.length
    }
    const pool = OPENCODE_PROVIDERS[activeProvider]
    nextState.indices[activeProvider] = (Number(nextState.indices[activeProvider] || 0) + 1) % pool.length
  }

  const pool = OPENCODE_PROVIDERS[activeProvider]
  const index = Number(nextState.indices[activeProvider] || 0) % pool.length
  const model = pool[index]

  if (!dryRun) {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(stateFile, JSON.stringify(nextState, null, 2))
    updateEnvKey(envPath, 'OPENCODE_AI_MODEL', model)
  }

  console.log(`${dryRun ? '[dry-run] Would rotate' : 'Rotated'} to ${activeProvider} model: ${model}`)
  console.log(`   State: day=${today}, provider=${activeProvider}, index=${index}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
}
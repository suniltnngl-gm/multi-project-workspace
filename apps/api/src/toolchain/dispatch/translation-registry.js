/**
 * SWARM-TRANSLATION-REG-001 (#241) — $0 Two-Layer Translation & Alias Pre-Processor.
 *
 * Layer 1 (0 ms, $0 Deterministic Dictionary):
 *   Resolves canonical aliases from `statePaths().translationRegistryPath`
 *   (`~/.local/state/curl-ai-bridge/translation-registry.json`) merged over built-in
 *   defaults for pool names (`opencode-versal-ai-gateway` -> `opencode-vercel-ai-gateway`),
 *   sibling aliases (`agy` -> `antigravity`), common operator typos (`orgestration` ->
 *   `orchestration`), and `#<taskId>` extraction.
 *
 * Layer 2 ($0 Tier-0 Local `llama.cpp` 0.5b/1.5b GGUF -> Remote Colab/Kaggle Fallback):
 *   Optional prompt normalizer that converts noisy/complex prompts into structured
 *   `{ intent, canonicalTerms, targetPools, taskIds, constraints }`. Fails gracefully
 *   back to Layer 1 deterministic output whenever local/remote inference is offline —
 *   never blocking and never burning paid or Tier-1 quota.
 */
import { existsSync, readFileSync } from 'node:fs'
import { protectedWriteFile } from './mutation-guard.js'
import { statePaths } from '../../../../../scripts/swarm-state-paths.mjs'

export const TRANSLATION_REGISTRY_SCHEMA = 'translation-registry/v1'

export const DEFAULT_ALIASES = Object.freeze({
  pools: Object.freeze({
    'opencode-versal-ai-gateway': 'opencode-vercel-ai-gateway',
    'opencode-vercel': 'opencode-vercel-ai-gateway',
    'opencode-google': 'opencode-console-google',
    'opencode-nvidia': 'opencode-console-nvidia',
    'opencode-openrouter': 'opencode-console-openrouter',
    'opencode-groq': 'opencode-console-groq',
    'direct-cf': 'cloudflare-workers-ai',
    'direct-vercel': 'vercel-ai-gateway',
    codex: 'codex-exec',
    copilot: 'github-copilot'
  }),
  siblings: Object.freeze({
    agy: 'antigravity',
    antigravity: 'agy',
    'local-llama': 'local',
    'llama.cpp': 'local'
  }),
  terms: Object.freeze({
    orgestration: 'orchestration',
    orvhestration: 'orchestration',
    haulicination: 'hallucination',
    sessiom: 'session',
    versal: 'vercel'
  })
})

export function resolveTranslationRegistryPath(env = process.env) {
  return statePaths(env).translationRegistryPath
}

export function loadTranslationRegistry({ registryPath = null, env = process.env } = {}) {
  const path = registryPath || resolveTranslationRegistryPath(env)
  let persisted = null
  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object') persisted = parsed
    } catch {
      persisted = null
    }
  }
  return {
    schema: TRANSLATION_REGISTRY_SCHEMA,
    path,
    pools: { ...DEFAULT_ALIASES.pools, ...(persisted?.pools || {}) },
    siblings: { ...DEFAULT_ALIASES.siblings, ...(persisted?.siblings || {}) },
    terms: { ...DEFAULT_ALIASES.terms, ...(persisted?.terms || {}) }
  }
}

export function saveTranslationAlias(category, alias, canonical, { registryPath = null, env = process.env } = {}) {
  if (!['pools', 'siblings', 'terms'].includes(category)) {
    throw new Error(`invalid_translation_category:${category}`)
  }
  const key = String(alias || '').trim().toLowerCase()
  const val = String(canonical || '').trim()
  if (!key || !val) throw new Error('translation_alias_and_canonical_required')

  const reg = loadTranslationRegistry({ registryPath, env })
  reg[category][key] = val
  const payload = {
    schema: TRANSLATION_REGISTRY_SCHEMA,
    updatedAt: new Date().toISOString(),
    pools: reg.pools,
    siblings: reg.siblings,
    terms: reg.terms
  }
  protectedWriteFile(reg.path, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Layer 1: Deterministic 0 ms / $0 normalization & entity extraction.
 */
export function translatePromptDeterministic(prompt, { registry = null, registryPath = null, env = process.env } = {}) {
  const reg = registry || loadTranslationRegistry({ registryPath, env })
  const raw = String(prompt || '')
  let normalized = raw
  const appliedAliases = []
  const targetPools = new Set()

  for (const [alias, canonical] of Object.entries(reg.pools)) {
    const re = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'gi')
    if (re.test(normalized)) {
      normalized = normalized.replace(re, canonical)
      appliedAliases.push({ category: 'pools', from: alias, to: canonical })
      targetPools.add(canonical)
    } else if (new RegExp(`\\b${escapeRegExp(canonical)}\\b`, 'i').test(normalized)) {
      targetPools.add(canonical)
    }
  }

  for (const [alias, canonical] of Object.entries(reg.terms)) {
    const re = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'gi')
    if (re.test(normalized)) {
      normalized = normalized.replace(re, canonical)
      appliedAliases.push({ category: 'terms', from: alias, to: canonical })
    }
  }

  const taskIds = [...new Set([...normalized.matchAll(/#(\d+)/g)].map((m) => `#${m[1]}`))]
  const canonicalTerms = [...new Set(appliedAliases.map((a) => a.to))]

  return {
    layer: 'deterministic',
    raw,
    normalized,
    intent: normalized.trim().slice(0, 240),
    canonicalTerms,
    targetPools: [...targetPools],
    taskIds,
    constraints: [],
    appliedAliases,
    fallbackUsed: false
  }
}

/**
 * Two-Layer $0 Translation Pre-Processor:
 * Runs Layer 1 deterministic normalization first, then optionally invokes Layer 2
 * ($0 local llama.cpp -> remote Colab/Kaggle fallback) when `useLocalLlm` is true.
 * Never throws or burns paid/Tier-1 quota if Layer 2 is offline.
 */
export async function translatePrompt(prompt, {
  registry = null,
  registryPath = null,
  env = process.env,
  useLocalLlm = false,
  callLocalLlama = null,
  callRemoteFallback = null
} = {}) {
  const base = translatePromptDeterministic(prompt, { registry, registryPath, env })
  if (!useLocalLlm) return base

  const tryNormalizer = async (fn, source) => {
    if (typeof fn !== 'function') return null
    try {
      const out = await fn(base.normalized, base)
      const parsed = typeof out === 'string' ? JSON.parse(out) : out
      if (parsed && typeof parsed === 'object') {
        return {
          ...base,
          layer: source,
          intent: String(parsed.intent || base.intent),
          canonicalTerms: [...new Set([...base.canonicalTerms, ...(Array.isArray(parsed.canonicalTerms) ? parsed.canonicalTerms : [])])],
          targetPools: [...new Set([...base.targetPools, ...(Array.isArray(parsed.targetPools) ? parsed.targetPools : [])])],
          taskIds: [...new Set([...base.taskIds, ...(Array.isArray(parsed.taskIds) ? parsed.taskIds : [])])],
          constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : base.constraints,
          fallbackUsed: source !== 'local-llama'
        }
      }
    } catch {
      return null
    }
    return null
  }

  const localRes = await tryNormalizer(callLocalLlama, 'local-llama')
  if (localRes) return localRes

  const remoteRes = await tryNormalizer(callRemoteFallback, 'remote-gpu-fallback')
  if (remoteRes) return remoteRes

  return { ...base, fallbackUsed: true }
}

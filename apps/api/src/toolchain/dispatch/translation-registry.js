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

/**
 * SWARM-TRANSLATION-REG-002 (W1) — Sibling Response & Message Translation.
 *
 * `translateResponse` adapts any sibling CLI's raw output into a canonical
 * `sibling-response/v1` envelope so the Decide/Measure phases consume every
 * sibling uniformly. Deterministic and $0 — no LLM anywhere.
 *
 * `translateMessage` normalizes cross-CLI handoff messages into
 * `sibling-message/v1` (a task started by one sibling, resumed by another).
 *
 * Every translation records a usage row (`translation-usage.jsonl`); the
 * aggregate (`translationUsageStats`) is the progressive-improvement signal —
 * adapters with low ok-rates are visible instead of silently lossy.
 */
import { appendFileSync } from 'node:fs'
import { statePaths as statePaths_ } from '../../../../../scripts/swarm-state-paths.mjs'

export const SIBLING_RESPONSE_SCHEMA = 'sibling-response/v1'
export const SIBLING_MESSAGE_SCHEMA = 'sibling-message/v1'

function extractJsonBlock(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

function verdictFromJson(obj) {
  const v = String(obj?.verdict || obj?.decision || '').toUpperCase()
  return v === 'ACCEPT' || v === 'REJECT' ? v : null
}

/** Per-sibling deterministic response adapters. Unknown siblings use the generic text adapter. */
export const RESPONSE_ADAPTERS = Object.freeze({
  cline: (raw) => {
    const obj = extractJsonBlock(raw)
    return {
      verdict: verdictFromJson(obj),
      findings: obj?.findings ?? null,
      failureClass: null,
      evidence: obj ? { plan: obj.plan ?? null, editedFiles: obj.editedFiles ?? null } : null
    }
  },
  vibe: (raw) => {
    const obj = extractJsonBlock(raw)
    return {
      verdict: verdictFromJson(obj),
      findings: obj?.result ?? obj?.answer ?? null,
      failureClass: obj?.status && obj.status !== 'success' ? 'real_failure' : null,
      evidence: obj ? { agent: obj.agent ?? null, usage: obj.usage ?? null } : null
    }
  },
  codex: (raw) => {
    const s = String(raw || '')
    const verdict = /VERDICT:\s*(ACCEPT|REJECT)\b/i.exec(s)?.[1]?.toUpperCase() ?? null
    const blocked = /not logged in|unauthorized|blocked before/i.test(s)
    return {
      verdict,
      findings: s.trim() ? s.trim().split(/\r?\n/).slice(-8).join('\n') : null,
      failureClass: blocked ? 'auth_failure' : /error:\s|\bexception\b/i.test(s) ? 'real_failure' : null,
      evidence: { tokensUsed: Number(/([\d,]+) tokens used/i.exec(s)?.[1]?.replace(/,/g, '')) || null }
    }
  },
  hermes: (raw) => {
    const s = String(raw || '')
    const verdict = /VERDICT:\s*(ACCEPT|REJECT)\b/i.exec(s)?.[1]?.toUpperCase() ?? null
    return { verdict, findings: s.trim() || null, failureClass: null, evidence: null }
  },
  direct: (raw) => {
    const obj = extractJsonBlock(raw)
    return {
      verdict: null,
      findings: obj?.finalAnswer ?? (typeof raw === 'string' ? raw.trim() : null),
      failureClass: obj?.ok === false ? 'real_failure' : null,
      evidence: obj ? { turns: obj.turns ?? null, durationMs: obj.durationMs ?? null } : null
    }
  }
})

export function translateResponse(sibling, raw, {
  env = process.env,
  track = true,
  usagePath = null,
  now = () => new Date().toISOString()
} = {}) {
  const t0 = Date.now()
  const siblingKey = String(sibling || '').toLowerCase()
  const adapter = RESPONSE_ADAPTERS[siblingKey] || RESPONSE_ADAPTERS[siblingKey.startsWith('direct') ? 'direct' : 'hermes']
  const unknownSibling = !RESPONSE_ADAPTERS[siblingKey]
  let core
  try {
    core = adapter(raw)
  } catch (err) {
    core = { verdict: null, findings: null, failureClass: 'real_failure', evidence: { adapterError: err.message } }
  }
  const response = {
    schema: SIBLING_RESPONSE_SCHEMA,
    sibling: siblingKey,
    adapter: unknownSibling ? 'generic-text' : siblingKey,
    ok: core.failureClass === null,
    ...core,
    rawBytes: String(raw || '').length
  }
  if (track) {
    try {
      recordTranslationUsage({
        usagePath: usagePath || statePaths_(env).translationUsagePath,
        record: { kind: 'response', sibling: siblingKey, adapter: response.adapter, ok: response.ok, latencyMs: Date.now() - t0, at: now() }
      })
    } catch (err) { console.error('TRACK_ERR', err && err.message) }
  }
  return response
}

/**
 * Cross-CLI message envelope: normalize either a canonical message or a raw
 * prompt/handoff text into `sibling-message/v1`, optionally retargeting a
 * specific sibling (prompt-shape differences live in the relay, not here).
 */
export function translateMessage({ from = null, to = null, message = null, text = '', env = process.env, track = true, usagePath = null, now = () => new Date().toISOString() } = {}) {
  const t0 = Date.now()
  const raw = message && typeof message === 'object' ? message : { text: String(text || '') }
  const msg = {
    schema: SIBLING_MESSAGE_SCHEMA,
    from: from ? String(from).toLowerCase() : null,
    to: to ? String(to).toLowerCase() : null,
    taskId: raw.taskId ?? raw.task ?? null,
    phase: raw.phase ?? null,
    context: raw.context ?? raw.summary ?? null,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    text: String(raw.text ?? text ?? '')
  }
  if (track) {
    try {
      recordTranslationUsage({
        usagePath: usagePath || statePaths_(env).translationUsagePath,
        record: { kind: 'message', sibling: msg.to || msg.from || 'unknown', adapter: 'message-envelope', ok: Boolean(msg.text || msg.context), latencyMs: Date.now() - t0, at: now() }
      })
    } catch (err) { console.error('TRACK_ERR', err && err.message) }
  }
  return msg
}

/** Append one usage row (JSONL, 0600). Never throws by design at call sites. */
export function recordTranslationUsage({ usagePath, record }) {
  if (!usagePath) throw new Error('translation_usage_path_required')
  appendFileSync(usagePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Progressive-improvement view: per {kind, adapter} totals + ok-rate. A falling
 * ok-rate on an adapter is the signal to fix it before it silently degrades
 * Discover/Decide/Measure quality.
 */
export function translationUsageStats(usagePath, { env = process.env } = {}) {
  const path = usagePath || statePaths_(env).translationUsagePath
  const stats = {}
  if (!existsSync(path)) return { schema: 'translation-usage-stats/v1', path, adapters: [] }
  for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const key = `${rec.kind || 'unknown'}:${rec.adapter || rec.sibling || 'unknown'}`
    stats[key] = stats[key] || { kind: rec.kind || 'unknown', adapter: rec.adapter || rec.sibling || 'unknown', total: 0, ok: 0 }
    stats[key].total += 1
    if (rec.ok) stats[key].ok += 1
  }
  const adapters = Object.values(stats).map((s) => ({ ...s, okRate: s.total ? s.ok / s.total : 0 }))
    .sort((a, b) => a.okRate - b.okRate || b.total - a.total)
  return { schema: 'translation-usage-stats/v1', path, adapters }
}

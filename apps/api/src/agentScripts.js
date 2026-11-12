// Objective: Resolve repetitive work to a registered deterministic script before any model call.
// Requirements: Match intents locally, prefer verified scripts, report missing required inputs, and never execute a command from this module.
// Decisions: Normalized token overlap is enough for the small local registry; the resolver is pure so it can be unit-tested without a database or shell; a missing-input result is distinct from a model fallback so callers do not spend quota asking the model to invent values.
// Relevant Files: apps/api/src/agentScripts.js, apps/api/src/db/agentScripts.js, apps/api/src/routes/agents.js
// Important Context: User file. This is the zero-token half of the script-first policy.
export const SCRIPT_COST_CLASSES = new Set(['free', 'payg', 'subscription'])
export const SCRIPT_MATCH_THRESHOLD = 0.5
export const MAX_SCRIPT_NAME_LENGTH = 50
export const MAX_SCRIPT_INTENT_LENGTH = 200
export const MAX_SCRIPT_COMMAND_LENGTH = 1000
export const MIN_SCRIPT_TIMEOUT_MS = 1000
export const MAX_SCRIPT_TIMEOUT_MS = 3600000

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with'
])

function errorResult(status, message) {
  return { error: { status, body: { error: message } } }
}

export function normalizeIntent(intent) {
  if (typeof intent !== 'string') return ''
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function intentTokens(intent) {
  return normalizeIntent(intent)
    .split(' ')
    .filter((token) => token && !STOP_WORDS.has(token))
}

/**
 * Score is token overlap plus a substring bonus. It intentionally stays
 * predictable: the same intent always resolves to the same script.
 */
export function scoreScriptIntent(scriptIntent, intent) {
  const normalizedScript = normalizeIntent(scriptIntent)
  const normalizedQuery = normalizeIntent(intent)
  if (!normalizedScript || !normalizedQuery) return 0
  if (normalizedScript === normalizedQuery) return 1

  const scriptTokens = new Set(intentTokens(scriptIntent))
  const queryTokens = intentTokens(intent)
  if (queryTokens.length === 0 || scriptTokens.size === 0) return 0

  let overlap = 0
  for (const token of queryTokens) {
    if (scriptTokens.has(token)) overlap += 1
  }
  const containment = normalizedScript.includes(normalizedQuery) || normalizedQuery.includes(normalizedScript)
    ? 0.15
    : 0
  return Math.min(1, overlap / queryTokens.length + containment)
}

function requiredInputs(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return []
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : [])
  const properties = inputSchema.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : {}
  for (const [name, definition] of Object.entries(properties)) {
    if (definition && typeof definition === 'object' && definition.required === true) {
      required.add(name)
    }
  }
  return [...required].filter((name) => typeof name === 'string' && name)
}

function missingInputs(inputSchema, input) {
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return requiredInputs(inputSchema).filter((name) => {
    const value = values[name]
    return value === undefined || value === null || (typeof value === 'string' && !value.trim())
  })
}

/**
 * Resolve one intent against a set of scripts. Verified scripts win ties; an
 * unverified script can still match so the caller can run and mark it.
 */
export function resolveScript(scripts, { intent, input } = {}) {
  if (typeof intent !== 'string' || !intent.trim()) {
    return errorResult(400, 'An intent is required.')
  }
  const candidates = (Array.isArray(scripts) ? scripts : [])
    .map((script) => ({
      script,
      score: scoreScriptIntent(script.intent, intent),
      verified: Number.isInteger(script.verifiedAt)
    }))
    .filter((candidate) => candidate.score >= SCRIPT_MATCH_THRESHOLD)
    .sort((left, right) => {
      if (left.verified !== right.verified) return left.verified ? -1 : 1
      if (left.score !== right.score) return right.score - left.score
      return right.script.version - left.script.version
    })

  if (candidates.length === 0) {
    return {
      decision: 'model',
      intent: intent.trim(),
      reason: 'No registered script matches this intent.',
      threshold: SCRIPT_MATCH_THRESHOLD
    }
  }

  const best = candidates[0]
  const missing = missingInputs(best.script.inputSchema, input)
  if (missing.length > 0) {
    return {
      decision: 'needs_input',
      intent: intent.trim(),
      script: best.script,
      score: best.score,
      verified: best.verified,
      missingInputs: missing
    }
  }
  return {
    decision: 'script',
    intent: intent.trim(),
    script: best.script,
    score: best.score,
    verified: best.verified,
    input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  }
}

export function validateScriptInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Script registration must be a JSON object.' }
  }
  if (typeof body.name !== 'string' || !/^[a-z][a-z0-9_-]{0,49}$/.test(body.name)) {
    return {
      error: `Script name must start with a lowercase letter and use at most ${MAX_SCRIPT_NAME_LENGTH} lowercase letters, digits, underscores, or hyphens.`
    }
  }
  if (typeof body.intent !== 'string' || !body.intent.trim() || body.intent.length > MAX_SCRIPT_INTENT_LENGTH) {
    return { error: `Script intent must be a non-empty string of at most ${MAX_SCRIPT_INTENT_LENGTH} characters.` }
  }
  if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > MAX_SCRIPT_COMMAND_LENGTH) {
    return { error: `Script command must be a non-empty string of at most ${MAX_SCRIPT_COMMAND_LENGTH} characters.` }
  }
  for (const field of ['input_schema', 'output_schema']) {
    const value = body[field]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      return { error: `${field} must be a JSON object.` }
    }
  }
  if (body.timeout_ms !== undefined) {
    if (!Number.isSafeInteger(body.timeout_ms)
      || body.timeout_ms < MIN_SCRIPT_TIMEOUT_MS
      || body.timeout_ms > MAX_SCRIPT_TIMEOUT_MS) {
      return {
        error: `Script timeout must be an integer between ${MIN_SCRIPT_TIMEOUT_MS} and ${MAX_SCRIPT_TIMEOUT_MS} milliseconds.`
      }
    }
  }
  if (body.cost_class !== undefined && !SCRIPT_COST_CLASSES.has(body.cost_class)) {
    return { error: `Script cost class must be one of: ${[...SCRIPT_COST_CLASSES].join(', ')}.` }
  }
  return {
    name: body.name,
    intent: body.intent.trim(),
    command: body.command.trim(),
    inputSchema: body.input_schema ?? {},
    outputSchema: body.output_schema ?? {},
    timeoutMs: body.timeout_ms ?? 60000,
    costClass: body.cost_class ?? 'free'
  }
}

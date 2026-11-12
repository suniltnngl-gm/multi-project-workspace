// Objective: Define the agent message envelope, allowed star-topology edges, and task-op validation shared by the broker and routes.
// Requirements: Keep worker-to-worker delivery impossible; cap message size and artifact refs; redact credential-shaped fields before persistence; validate task ops with the same task limits as the HTTP API.
// Decisions: The protocol is pure data plus validators so both the broker and tests can use it without a database; canonical JSON is used for idempotency comparisons and cache keys; only parent and reviewer parents exist, and workers always address the logical parent role.
// Relevant Files: apps/api/src/agentProtocol.js, apps/api/src/agentBus.js, apps/api/src/agentTaskOps.js, apps/api/src/routes/agents.js
// Important Context: User file. The broker enforces these rules; prompts never do.
export const AGENT_ROLES = new Set(['parent', 'reviewer', 'worker'])
export const AGENT_MESSAGE_KINDS = new Set([
  'assign', 'progress', 'question', 'result', 'error', 'cancel', 'verdict', 'handoff'
])
export const AGENT_RUN_STATES = new Set([
  'draft', 'planning', 'dispatching', 'running', 'reviewing', 'completed', 'failed', 'cancelled'
])
export const AGENT_AGENT_STATES = new Set([
  'idle', 'ready', 'running', 'waiting', 'done', 'failed', 'cancelled'
])
export const AGENT_MESSAGE_STATES = new Set([
  'queued', 'leased', 'delivered', 'acked', 'completed', 'failed', 'expired', 'dead_letter'
])
export const AGENT_TASK_OP_KINDS = new Set(['create_task', 'update_task', 'propose_task'])

export const MAX_MESSAGE_BYTES = 12 * 1024
export const MAX_ARTIFACT_REFS = 20
export const MAX_ARTIFACT_REF_LENGTH = 500
export const MAX_TASK_OPS_PER_BATCH = 20
export const MAX_AGENT_NAME_LENGTH = 50
export const MAX_AGENT_MODEL_LENGTH = 120
export const MAX_AGENT_BACKEND_LENGTH = 40
export const MAX_CORRELATION_LENGTH = 200
export const MAX_IDEMPOTENCY_LENGTH = 200
export const MAX_TASK_OP_ID_LENGTH = 100
export const MAX_TASK_OPS_CREATES_PER_RUN = 5

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled'])
const SECRET_KEY_PATTERN = /(^|_)(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|bearer)($|_)/i
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g
]

// Allowed edges are the contract. A worker can only reach the primary parent;
// the reviewer is parent-side and is never worker-addressable.
const EDGES = {
  assign: { from: ['parent'], to: ['worker'] },
  progress: { from: ['worker'], to: ['parent'] },
  question: { from: ['worker'], to: ['parent'] },
  result: { from: ['worker'], to: ['parent'] },
  error: { from: ['worker'], to: ['parent'] },
  cancel: { from: ['parent'], to: ['worker'] },
  verdict: { from: ['reviewer'], to: ['parent'] },
  handoff: { from: ['parent'], to: ['reviewer'] }
}

export function isTerminalRunState(state) {
  return TERMINAL_RUN_STATES.has(state)
}

export function allowedAgentEdge(kind, fromRole, toRole) {
  const edge = EDGES[kind]
  if (!edge) return false
  return edge.from.includes(fromRole) && edge.to.includes(toRole)
}

/**
 * Canonical JSON keeps idempotency comparisons stable regardless of object key
 * order. It is intentionally small: these payloads are structured work items,
 * not arbitrary graphs.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    return SECRET_VALUE_PATTERNS.reduce(
      (text, pattern) => text.replace(pattern, '[redacted]'),
      value
    )
  }
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(entry)
  }
  return result
}

export function isValidAgentName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9_-]{0,49}$/.test(name)
}

export function validateAgentSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return 'Each agent must be a JSON object.'
  }
  if (!AGENT_ROLES.has(spec.role)) {
    return `Agent role must be one of: ${[...AGENT_ROLES].join(', ')}.`
  }
  if (!isValidAgentName(spec.name)) {
    return `Agent name must start with a lowercase letter and use at most ${MAX_AGENT_NAME_LENGTH} lowercase letters, digits, underscores, or hyphens.`
  }
  if (typeof spec.model !== 'string' || !spec.model.trim() || spec.model.length > MAX_AGENT_MODEL_LENGTH) {
    return `Agent model must be a non-empty string of at most ${MAX_AGENT_MODEL_LENGTH} characters.`
  }
  if (spec.backend !== undefined) {
    if (typeof spec.backend !== 'string' || spec.backend.length > MAX_AGENT_BACKEND_LENGTH) {
      return `Agent backend must be a string of at most ${MAX_AGENT_BACKEND_LENGTH} characters.`
    }
  }
  return null
}

export function validateRunInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }
  const agents = body.agents
  if (!Array.isArray(agents) || agents.length === 0) {
    return 'Provide at least one agent.'
  }
  if (agents.length > 9) {
    return 'A run supports at most one parent, one reviewer, and six workers.'
  }
  for (const spec of agents) {
    const error = validateAgentSpec(spec)
    if (error) return error
  }
  const roles = agents.map((agent) => agent.role)
  if (roles.filter((role) => role === 'parent').length !== 1) {
    return 'A run must have exactly one parent agent.'
  }
  if (roles.filter((role) => role === 'reviewer').length > 1) {
    return 'A run supports at most one reviewer agent.'
  }
  if (roles.filter((role) => role === 'worker').length > 6) {
    return 'A run supports at most six worker agents.'
  }
  const names = agents.map((agent) => agent.name)
  if (new Set(names).size !== names.length) {
    return 'Agent names must be unique within a run.'
  }
  return null
}

/**
 * Validate a message before the broker stores it. The sender identity is never
 * part of this check; it comes from the agent token.
 */
export function validateEnvelope({
  kind,
  payload,
  artifactRefs = [],
  idempotencyKey,
  correlationId = '',
  deadlineAt
} = {}) {
  if (!AGENT_MESSAGE_KINDS.has(kind)) {
    return { error: `Message kind must be one of: ${[...AGENT_MESSAGE_KINDS].join(', ')}.` }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Message payload must be a JSON object.' }
  }
  if (!Array.isArray(artifactRefs) || artifactRefs.length > MAX_ARTIFACT_REFS) {
    return { error: `Artifact refs must be an array of at most ${MAX_ARTIFACT_REFS} entries.` }
  }
  if (artifactRefs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > MAX_ARTIFACT_REF_LENGTH)) {
    return { error: `Each artifact ref must be a non-empty string of at most ${MAX_ARTIFACT_REF_LENGTH} characters.` }
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > MAX_IDEMPOTENCY_LENGTH) {
    return { error: `Idempotency key must be a non-empty string of at most ${MAX_IDEMPOTENCY_LENGTH} characters.` }
  }
  if (typeof correlationId !== 'string' || correlationId.length > MAX_CORRELATION_LENGTH) {
    return { error: `Correlation id must be a string of at most ${MAX_CORRELATION_LENGTH} characters.` }
  }

  let deadline = null
  if (deadlineAt !== undefined && deadlineAt !== null) {
    deadline = typeof deadlineAt === 'number' ? deadlineAt : Date.parse(deadlineAt)
    if (!Number.isFinite(deadline)) {
      return { error: 'Deadline must be an ISO timestamp or epoch milliseconds.' }
    }
  }

  const cleanPayload = redactSecrets(payload)
  const cleanRefs = [...artifactRefs]
  const bytes = Buffer.byteLength(
    JSON.stringify({ payload: cleanPayload, artifactRefs: cleanRefs }),
    'utf8'
  )
  if (bytes > MAX_MESSAGE_BYTES) {
    return { error: `Message payload must be at most ${MAX_MESSAGE_BYTES} bytes.` }
  }

  return {
    kind,
    payload: cleanPayload,
    artifactRefs: cleanRefs,
    idempotencyKey: idempotencyKey.trim(),
    correlationId,
    deadlineAt: deadline
  }
}

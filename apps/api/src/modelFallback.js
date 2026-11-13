// Objective: Decide whether a failed model call may move to the next configured capability lane.
// Requirements: Fallback is opt-in, runs only for live capacity or hardware failures, never changes a session-bound request unless explicitly allowed, and records why it moved.
// Decisions: The chain is an ordered `>`-separated list of model ids; the primary id's position defines where the chain continues. Errors without an HTTP-style status (parse errors, invalid output) are not retried on another lane because a second model would not fix the input.
// Relevant Files: apps/api/src/modelFallback.js, apps/api/src/routes/aiDrafts.js, apps/api/src/modelClient.js
// Important Context: Pure functions only; selection, budget, and job retargeting stay in the route layer.

// Failure statuses that mean "this lane cannot serve right now", not "the
// request is wrong": provider rate limits, capacity/entitlement failures, and
// timeouts. A gpu_unavailable code is a local hardware mismatch that another
// lane can still serve.
const FALLBACK_STATUSES = new Set([429, 503, 504])

export function parseFallbackChain(value) {
  return [...new Set(
    String(value ?? '')
      .split('>')
      .map((id) => id.trim())
      .filter(Boolean)
  )]
}

export function fallbackCandidates(chain, primaryId) {
  const ordered = parseFallbackChain(Array.isArray(chain) ? chain.join('>') : chain)
  const index = ordered.indexOf(primaryId)
  const remainder = index === -1 ? ordered : ordered.slice(index + 1)
  return remainder.filter((id) => id !== primaryId)
}

export function isFallbackEligible(error) {
  if (!error) return false
  if (error.code === 'gpu_unavailable') return true
  return FALLBACK_STATUSES.has(Number(error.status))
}

export function describeFallback(error) {
  return String(error?.message || error || 'unknown error').slice(0, 500)
}

/**
 * A session belongs to one model: switching mid-conversation would reset the
 * provider's prompt cache and could leak a summary into a different lane, so
 * fallback is skipped for session-bound requests unless explicitly enabled.
 */
export function fallbackAllowed({ chain, sessionBound = false, allowSessions = false }) {
  return chain.length > 0 && (!sessionBound || allowSessions)
}

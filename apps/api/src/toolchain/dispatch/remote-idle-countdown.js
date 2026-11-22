/**
 * Generation-guarded idle countdown for warm remote GPU sessions (e.g. Colab).
 *
 * Guarantees:
 * - Reconnecting / starting new work increments `generation` and sets `activeWork = true`,
 *   invalidating any previously armed countdown timer.
 * - A countdown NEVER stops a session while `activeWork === true` or if its captured
 *   `expectedGeneration` is stale.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function createIdleState(sessionName, { nowMs = Date.now(), idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
  return {
    sessionName,
    generation: 1,
    activeWork: false,
    idleTimeoutMs,
    lastActivityMs: nowMs,
    expiresAtMs: nowMs + idleTimeoutMs
  }
}

/** Reconnect / start work: cancels any pending countdown by bumping generation and setting activeWork=true. */
export function markWorkStart(state, { nowMs = Date.now() } = {}) {
  return {
    ...state,
    generation: state.generation + 1,
    activeWork: true,
    lastActivityMs: nowMs,
    expiresAtMs: null
  }
}

/** Finish work: arms a fresh countdown with a new generation. */
export function markWorkEnd(state, { nowMs = Date.now(), idleTimeoutMs = state.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS } = {}) {
  return {
    ...state,
    generation: state.generation + 1,
    activeWork: false,
    idleTimeoutMs,
    lastActivityMs: nowMs,
    expiresAtMs: nowMs + idleTimeoutMs
  }
}

/**
 * Evaluate whether a firing countdown timer is allowed to run `colab stop`.
 * Fail-closed: never stops during active work or on a stale generation.
 */
export function shouldStopSession(state, { expectedGeneration, nowMs = Date.now() } = {}) {
  if (state.activeWork) {
    return { shouldStop: false, reason: 'work_in_progress' }
  }
  if (expectedGeneration !== state.generation) {
    return { shouldStop: false, reason: 'stale_countdown_reset_by_reconnect' }
  }
  if (state.expiresAtMs === null || nowMs < state.expiresAtMs) {
    return { shouldStop: false, reason: 'countdown_not_expired', remainingMs: state.expiresAtMs ? state.expiresAtMs - nowMs : null }
  }
  return { shouldStop: true, reason: 'idle_countdown_expired', command: { bin: 'colab', argv: ['stop', '-s', state.sessionName] } }
}

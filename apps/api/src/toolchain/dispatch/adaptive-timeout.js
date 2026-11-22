/**
 * 2-stage adaptive timeout controller for headless AI CLI processes.
 *
 * - Stage 1 (waiting for first output): governed by `hardTimeoutMs` so large
 *   warm-cache sessions (e.g. 425K ctx) are not killed prematurely.
 * - Stage 2 (after output begins): arms a resetting `idleAfterOutputMs` timer so
 *   interactive TUIs that finish replying and sit idle exit cleanly instead of
 *   hanging until `hardTimeoutMs`.
 */

export function createAdaptiveTimeout({
  idleAfterOutputMs = 20_000,
  hardTimeoutMs = 180_000,
  onTimeout
} = {}) {
  let settled = false
  let hasOutput = false
  let idleTimer = null

  const fire = (reason) => {
    if (settled) return
    settled = true
    clear()
    if (typeof onTimeout === 'function') onTimeout({ reason, hasOutput })
  }

  const hardTimer = setTimeout(() => fire('hard_timeout'), hardTimeoutMs)

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (settled || !idleAfterOutputMs) return
    idleTimer = setTimeout(() => fire('idle_after_output_timeout'), idleAfterOutputMs)
  }

  function markOutput() {
    if (settled) return
    hasOutput = true
    armIdle()
  }

  function clear() {
    clearTimeout(hardTimer)
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  return { markOutput, clear }
}

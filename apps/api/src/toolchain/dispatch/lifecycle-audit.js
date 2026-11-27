/**
 * LIFECYCLE AUDIT (#259) — best-effort durable event trail for split-brain guards.
 *
 * `appendLifecycleTransition(stateDir, event)` appends one JSON line to
 * `<stateDir>/lifecycle-transitions.jsonl`. It is deliberately fail-open on I/O:
 * telemetry must never block or change a guard's return contract. Consumers pass
 * `statePaths().root` so `swarm health` reads the same file the guards write.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const LIFECYCLE_TRANSITIONS_FILE = 'lifecycle-transitions.jsonl'

/** Append one lifecycle event. Returns true on success, false on any I/O failure. */
export function appendLifecycleTransition(stateDir, event) {
  try {
    const path = join(String(stateDir), LIFECYCLE_TRANSITIONS_FILE)
    appendFileSync(path, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

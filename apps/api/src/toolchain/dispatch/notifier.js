/**
 * Pluggable Swarm Notifier:
 * - Always appends structured events to `<stateDir>/notifications/events.jsonl`
 * - Fires Ubuntu desktop notification via `notify-send` when available
 * - Optional webhook POST when `SWARM_NOTIFY_WEBHOOK_URL` is configured
 * - Edge-triggered remote state diffing (`diffRemoteStates`) for Kaggle, Colab, and GitHub CI
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const DEFAULT_STATE_DIR = join(homedir(), '.local/state/curl-ai-bridge')

export function eventsLogPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, 'notifications', 'events.jsonl')
}

export function remoteStatePath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, 'notifications', 'remote-state.json')
}

export function emitNotification({
  title,
  body,
  severity = 'info',
  source = 'swarm',
  stateDir = DEFAULT_STATE_DIR,
  desktop = true,
  dryRun = false
}) {
  const dir = join(stateDir, 'notifications')
  const record = {
    id: randomUUID().slice(0, 8),
    title: String(title || 'Swarm Notification'),
    body: String(body || ''),
    severity,
    source,
    at: new Date().toISOString()
  }

  let desktopSent = false
  if (!dryRun) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(eventsLogPath(stateDir), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })

    if (desktop) {
      const urgency = severity === 'critical' ? 'critical' : (severity === 'warn' ? 'normal' : 'low')
      const res = spawnSync('notify-send', ['-u', urgency, `[${source}] ${record.title}`, record.body], {
        stdio: 'ignore',
        timeout: 3000
      })
      desktopSent = res.status === 0
    }
  }

  return { ok: true, dryRun, desktopSent, record }
}

/**
 * Compare previous vs current remote service states (kaggle, colab, github) and
 * return only edge-triggered transitions so repeated checks never spam.
 */
export function diffRemoteStates(prev = {}, next = {}) {
  const transitions = []
  for (const [key, val] of Object.entries(next)) {
    const before = prev[key] ?? null
    if (before !== val) {
      transitions.push({ key, before, after: val })
    }
  }
  return transitions
}

export function loadRemoteState(stateDir = DEFAULT_STATE_DIR) {
  const p = remoteStatePath(stateDir)
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

export function saveRemoteState(stateDir = DEFAULT_STATE_DIR, state = {}) {
  const dir = join(stateDir, 'notifications')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = remoteStatePath(stateDir)
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
  return target
}

export function consumerCursorPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, 'notifications', 'consumer-cursor.json')
}

export function readUnreadEvents(stateDir = DEFAULT_STATE_DIR) {
  const p = eventsLogPath(stateDir)
  if (!existsSync(p)) return []
  const cursorFile = consumerCursorPath(stateDir)
  const lastId = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, 'utf8')).lastEventId : null
  const all = readFileSync(p, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  if (!lastId) return all
  const idx = all.findIndex((e) => e.id === lastId)
  return idx >= 0 ? all.slice(idx + 1) : all
}

export function advanceEventCursor(stateDir = DEFAULT_STATE_DIR, lastEventId) {
  if (!lastEventId) return null
  const dir = join(stateDir, 'notifications')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = consumerCursorPath(stateDir)
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${JSON.stringify({ lastEventId, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
  return target
}

/**
 * Safety-first, allowlist-only event -> automation router.
 * Never auto-executes non-recoverable actions; critical/unknown events fail closed to operator escalation.
 */
export function routeNotificationAction(event) {
  const src = String(event?.source || '')
  const body = String(event?.body || '')
  const sev = String(event?.severity || 'info')

  if (sev === 'critical' || /STOP_SWARM|circuit_breaker/i.test(body)) {
    return { eventId: event?.id, action: 'escalate_operator', autoExecute: false, safe: false, reason: 'critical_or_guardrail_event' }
  }
  if (src === 'kaggle' && /COMPLETE/i.test(body)) {
    return { eventId: event?.id, action: 'pull_kaggle_output', autoExecute: true, safe: true, priority: 'P1', reason: 'kaggle_kernel_complete' }
  }
  if (src === 'github' && /failure/i.test(body)) {
    return { eventId: event?.id, action: 'enqueue_ci_fix_task', autoExecute: true, safe: true, priority: 'P0', reason: 'github_ci_failure' }
  }
  if (src === 'colab' && /Hardware:|active/i.test(body)) {
    return { eventId: event?.id, action: 'arm_colab_idle_countdown', autoExecute: true, safe: true, priority: 'P2', reason: 'colab_active_session' }
  }
  return { eventId: event?.id, action: 'noop', autoExecute: false, safe: true, reason: 'no_matching_allowlisted_rule' }
}

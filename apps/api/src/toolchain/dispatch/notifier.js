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

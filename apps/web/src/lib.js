export const statuses = [
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['done', 'Done']
]
export const priorities = ['low', 'medium', 'high', 'urgent']
export const taskTypes = ['feature', 'bug', 'chore', 'test', 'docs']

export function formatBusyMessage(reasons, retryAfter = 5) {
  const details = Array.isArray(reasons) && reasons.length > 0
    ? reasons.join('; ')
    : 'one or more resource limits are exceeded'
  return `Local AI paused: ${details}. Checking again in ${retryAfter} seconds.`
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'unknown'

  const seconds = Math.round(Math.max(0, now - timestamp) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 90) return '1m ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

const ACTIVITY_FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  project: 'Project',
  status: 'Status',
  priority: 'Priority',
  task_type: 'Type',
  acceptance_criteria: 'Acceptance criteria',
  objectives: 'Objectives',
  requirements: 'Requirements',
  decisions: 'Decisions',
  relevant_files: 'Relevant files',
  important_context: 'Important context',
  work_completed: 'Work completed',
  work_active: 'Active work',
  work_blocked: 'Blocked work',
  next_move: 'Next move'
}

const ACTIVITY_TEXT_FIELDS = new Set([
  'description', 'acceptance_criteria', 'objectives', 'requirements',
  'decisions', 'relevant_files', 'important_context', 'work_completed',
  'work_active', 'work_blocked', 'next_move'
])

function formatActivityValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  const text = String(value).replaceAll('_', ' ')
  const shortened = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return shortened.charAt(0).toUpperCase() + shortened.slice(1)
}

export function formatTaskActivity(event) {
  if (event.action === 'created') return 'Created'

  const label = ACTIVITY_FIELD_LABELS[event.field] ?? 'Task'
  if (!event.field || ACTIVITY_TEXT_FIELDS.has(event.field)) {
    return `${label} updated`
  }
  return `${label}: ${formatActivityValue(event.oldValue)} → ${formatActivityValue(event.newValue)}`
}

export function formatBudget(budget) {
  if (!budget) return ''
  const used = budget.used ?? 0
  const limit = budget.limit ?? 0
  const window = budget.window ?? 'day'
  const unit = budget.unit === 'compute_seconds' ? 'compute' : (budget.unit ?? 'requests')
  if (window === 'day') return `budget ${used}/${limit} today`
  if (window === 'none') return `budget ${used}/${limit} ${unit} pool`
  return `budget ${used}/${limit} ${window} ${unit}`
}

/**
 * Render one quota limiter with its unit, window, reset mode, used/limit, and
 * cooldown or usage-support state. State annotations follow the label after a
 * comma so each limiter stays one readable segment.
 */
export function formatLimiter(limiter) {
  const unit = limiter.unit === 'compute_seconds' ? 'compute' : (limiter.unit ?? 'requests')
  const reset = limiter.reset ?? 'fixed'
  const window = limiter.window ?? (reset === 'pool' ? 'none' : 'day')
  const used = limiter.used ?? 0
  const limit = limiter.limit ?? 0
  const label = reset === 'pool' || window === 'none'
    ? `${used}/${limit} ${unit} pool`
    : `${used}/${limit} ${unit} per ${window} ${reset === 'rolling' ? '(rolling)' : '(fixed)'}`
  const annotations = []
  if (limiter.ok === false) {
    if (reset === 'pool') {
      annotations.push('depleted')
    } else if (Number.isFinite(limiter.resetsInSeconds) && limiter.resetsInSeconds > 0) {
      annotations.push(`resets in ${formatDuration(limiter.resetsInSeconds * 1000)}`)
    } else {
      annotations.push('reset unknown')
    }
  }
  if (limiter.usageSupported === false) annotations.push('usage unsupported')
  return annotations.length > 0 ? `${label}, ${annotations.join(', ')}` : label
}

// A lone requests-per-day limiter with a fixed reset keeps the compact legacy
// "budget X/Y today" label; every other profile renders all its limiters.
function legacyDailyLabel(limiters) {
  if (limiters.length !== 1) return null
  const [limiter] = limiters
  const unit = limiter.unit ?? 'requests'
  const window = limiter.window ?? 'day'
  const reset = limiter.reset ?? 'fixed'
  return unit === 'requests' && window === 'day' && reset === 'fixed'
    ? formatBudget(limiter)
    : null
}

// The budget snapshot carries every configured limiter. Each limiter becomes
// one " · "-joined segment on the roster's full-width meta line, so several
// limiters stay readable by wrapping at spaces instead of truncating.
function budgetSegments(budget) {
  const limiters = Array.isArray(budget.limiters) ? budget.limiters : []
  const segments = []
  const legacy = legacyDailyLabel(limiters)
  if (legacy) {
    segments.push(legacy)
  } else if (limiters.length === 0) {
    segments.push(formatBudget(budget))
  } else {
    segments.push(...limiters.map((limiter) => formatLimiter(limiter)))
  }
  if (budget.cooldownSeconds > 0) {
    segments.push(`cooldown ${formatDuration(budget.cooldownSeconds * 1000)}`)
  }
  return segments
}

export function formatModelMeta(model) {
  const parts = []
  if (model.budget) {
    parts.push(...budgetSegments(model.budget))
  }
  if (model.sessionState) parts.push(`session ${model.sessionState}`)
  if (model.requests) {
    parts.push(`${model.requests} request${model.requests === 1 ? '' : 's'}`)
  }
  if (model.failures) {
    parts.push(`${model.failures} failed`)
  }
  if (Number.isFinite(model.lastDurationMs)) {
    parts.push(`last ${formatDuration(model.lastDurationMs)}`)
  }
  return parts.join(' · ')
}

export function formatJobProgress(job) {
  const phase = job.phase && job.phase !== job.state ? job.phase : job.state
  const elapsed = Number.isFinite(job.elapsedMs) ? ` · ${formatDuration(job.elapsedMs)}` : ''
  return `Batch job ${job.id} is ${phase}${elapsed}. Waiting…`
}

export function formatAiRun(run) {
  const parts = [run.model ?? 'unknown model']
  if (run.backend) parts.push(run.backend)
  const state = run.state ?? 'unknown'
  parts.push(run.phase && run.phase !== state ? `${state} (${run.phase})` : state)
  if (Number.isFinite(run.durationMs)) parts.push(formatDuration(run.durationMs))

  let text = parts.join(' · ')
  if (run.error) {
    text += ` — ${run.error}`
    if (run.retryAfter !== undefined) text += ` (retry in ${run.retryAfter}s)`
  }
  return text
}

export function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Draft cancelled.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException('Draft cancelled.', 'AbortError'))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function buildTaskQuery(formData) {
  const filters = new URLSearchParams()
  for (const [key, value] of formData) {
    if (value) filters.set(key, value)
  }
  return filters.toString()
}

const DRAFT_FIELDS = new Set([
  'title', 'description', 'acceptance_criteria', 'objectives', 'requirements',
  'decisions', 'relevant_files', 'important_context', 'work_completed',
  'work_active', 'work_blocked', 'next_move', 'project', 'task_type'
])

export function buildDraftInput(formData) {
  const draft = {}
  for (const [key, value] of formData) {
    if (DRAFT_FIELDS.has(key)) draft[key] = value
  }
  return draft
}

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
  important_context: 'Important context'
}

const ACTIVITY_TEXT_FIELDS = new Set([
  'description', 'acceptance_criteria', 'objectives', 'requirements',
  'decisions', 'relevant_files', 'important_context'
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

export function formatModelMeta(model) {
  const parts = []
  if (model.budget) {
    parts.push(formatBudget(model.budget))
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
  'decisions', 'relevant_files', 'important_context', 'project', 'task_type'
])

export function buildDraftInput(formData) {
  const draft = {}
  for (const [key, value] of formData) {
    if (DRAFT_FIELDS.has(key)) draft[key] = value
  }
  return draft
}

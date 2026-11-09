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

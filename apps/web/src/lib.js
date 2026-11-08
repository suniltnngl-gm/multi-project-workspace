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

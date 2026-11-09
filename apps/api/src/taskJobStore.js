/**
 * In-memory queue for long-running model calls such as Kaggle batches.
 * Jobs are intentionally ephemeral: they are lost when the API restarts.
 */
export function createTaskJobStore({ maxJobs = 50, now = Date.now } = {}) {
  const jobs = new Map()
  let nextId = 1

  function publicJob(job) {
    return {
      id: job.id,
      state: job.state,
      model: job.model,
      title: job.title,
      createdAt: job.createdAt,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.status !== undefined ? { status: job.status } : {})
    }
  }

  function prune() {
    if (jobs.size <= maxJobs) return
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) break
      if (job.state === 'done' || job.state === 'error') jobs.delete(id)
    }
  }

  function submit({ model, title, runner }) {
    const id = `job-${nextId++}`
    const job = { id, state: 'queued', model, title, createdAt: now() }
    jobs.set(id, job)

    // Defer the runner so the HTTP response is returned before a long batch
    // starts and so callers can poll immediately.
    queueMicrotask(async () => {
      job.state = 'running'
      job.startedAt = now()
      try {
        job.result = await runner()
        job.state = 'done'
      } catch (error) {
        job.state = 'error'
        job.error = error?.message || 'The batch job failed.'
        if (error?.status !== undefined) job.status = error.status
      } finally {
        job.finishedAt = now()
        prune()
      }
    })

    return publicJob(job)
  }

  function get(id) {
    const job = jobs.get(id)
    return job ? publicJob(job) : undefined
  }

  function list() {
    return [...jobs.values()].map(publicJob)
  }

  return { submit, get, list }
}

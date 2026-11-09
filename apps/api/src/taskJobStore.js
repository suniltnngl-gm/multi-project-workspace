/**
 * Queue for long-running model calls such as Kaggle batches. Jobs may be
 * persisted through an optional repository so an API restart can report them
 * instead of silently forgetting a running kernel.
 */
export function createTaskJobStore({
  maxJobs = 50,
  now = Date.now,
  repository
} = {}) {
  const jobs = new Map()
  let nextId = 1

  if (repository) {
    repository.markInterruptedJobs?.(
      'The API restarted before this job finished.',
      now()
    )
    for (const job of repository.listJobs()) {
      jobs.set(job.id, job)
      const match = /^job-(\d+)$/.exec(job.id)
      if (match) nextId = Math.max(nextId, Number(match[1]) + 1)
    }
  }

  function storedJob(job) {
    return {
      id: job.id,
      state: job.state,
      phase: job.phase,
      model: job.model,
      title: job.title,
      createdAt: job.createdAt,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.status !== undefined ? { status: job.status } : {}),
      ...(job.retryAfter !== undefined ? { retryAfter: job.retryAfter } : {})
    }
  }

  function persist(job) {
    try {
      repository?.saveJob?.(storedJob(job))
    } catch (error) {
      console.error(`Could not persist AI job ${job.id}: ${error.message}`)
    }
  }

  function publicJob(job) {
    const end = job.finishedAt ?? now()
    return {
      ...storedJob(job),
      ...(job.startedAt !== undefined
        ? { elapsedMs: Math.max(0, end - job.startedAt) }
        : {}),
      cancelable: (job.state === 'queued' || job.state === 'running')
        && !job.cancelRequested,
      ...(job.cancelRequested ? { cancelRequested: true } : {})
    }
  }

  function prune() {
    if (jobs.size <= maxJobs) return
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) break
      if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
        jobs.delete(id)
        try {
          repository?.deleteJob?.(id)
        } catch (error) {
          console.error(`Could not prune AI job ${id}: ${error.message}`)
        }
      }
    }
  }

  prune()

  function setPhase(job, phase) {
    if (typeof phase !== 'string' || !phase) return
    if (job.state !== 'queued' && job.state !== 'running') return
    if (job.cancelRequested || job.phase === phase) return
    job.phase = phase
    persist(job)
  }

  function submit({ model, title, runner }) {
    const id = `job-${nextId++}`
    const controller = new AbortController()
    const job = {
      id,
      state: 'queued',
      phase: 'queued',
      model,
      title,
      createdAt: now(),
      controller
    }
    jobs.set(id, job)
    persist(job)

    // Defer the runner so the HTTP response is returned before a long batch
    // starts and so callers can poll immediately.
    queueMicrotask(async () => {
      if (job.state !== 'queued') return
      job.state = 'running'
      job.phase = 'running'
      job.startedAt = now()
      persist(job)
      try {
        const result = await runner({
          signal: controller.signal,
          onPhase: (phase) => setPhase(job, phase)
        })
        if (job.cancelRequested) {
          job.state = 'cancelled'
          job.error = 'The job was cancelled.'
        } else {
          job.state = 'done'
          job.result = result
        }
      } catch (error) {
        if (job.cancelRequested || error?.status === 499) {
          job.state = 'cancelled'
          job.error = 'The job was cancelled.'
        } else {
          job.state = 'error'
          job.error = error?.message || 'The batch job failed.'
          if (error?.status !== undefined) job.status = error.status
          if (error?.retryAfter !== undefined) job.retryAfter = error.retryAfter
        }
      } finally {
        job.phase = 'finished'
        job.finishedAt = now()
        delete job.controller
        persist(job)
        prune()
      }
    })

    return publicJob(job)
  }

  function cancel(id) {
    const job = jobs.get(id)
    if (!job) return undefined
    if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
      return { job: publicJob(job), cancelled: false }
    }

    job.cancelRequested = true
    job.controller?.abort()
    if (job.state === 'queued') {
      job.state = 'cancelled'
      job.phase = 'finished'
      job.finishedAt = now()
      delete job.controller
    }
    persist(job)
    return { job: publicJob(job), cancelled: true }
  }

  function get(id) {
    const job = jobs.get(id)
    return job ? publicJob(job) : undefined
  }

  function list() {
    return [...jobs.values()].map(publicJob)
  }

  return { submit, get, list, cancel }
}

// Objective: Own the ai_jobs lifecycle shared by the scheduler, the job store, and the board.
// Requirements: Record every draft call including its backend and task link; mark interrupted jobs on restart; keep job history inspectable.
// Decisions: toAiRun is exported for the task-centric read in the tasks store, which matches runs by task link or drafting origin.
// Relevant Files: apps/api/src/db/aiJobs.js, apps/api/src/db/tasks.js, apps/api/src/taskJobStore.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
function toJob(row) {
  if (!row) return null
  return {
    id: row.id,
    state: row.state,
    phase: row.phase,
    model: row.model,
    title: row.title,
    createdAt: row.created_at,
    ...(row.backend !== null && row.backend !== undefined ? { backend: row.backend } : {}),
    ...(row.task_id !== null && row.task_id !== undefined ? { taskId: row.task_id } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.result !== null ? { result: JSON.parse(row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.retry_after !== null && row.retry_after !== undefined
      ? { retryAfter: row.retry_after }
      : {})
  }
}

export function toAiRun(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    model: row.model,
    ...(row.backend !== null ? { backend: row.backend } : {}),
    state: row.state,
    phase: row.phase,
    title: row.title,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.started_at !== null && row.finished_at !== null
      ? { durationMs: Math.max(0, row.finished_at - row.started_at) }
      : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.retry_after !== null ? { retryAfter: row.retry_after } : {})
  }
}

export function createAiJobsStore(connection) {
  const listJobsStatement = connection.prepare(
    'SELECT * FROM ai_jobs ORDER BY created_at ASC, rowid ASC'
  )

  const saveJobStatement = connection.prepare(`
    INSERT INTO ai_jobs (
      id, state, phase, model, backend, task_id, title, created_at, started_at,
      finished_at, result, error, status, retry_after
    ) VALUES (
      @id, @state, @phase, @model, @backend, @taskId, @title, @createdAt,
      @startedAt, @finishedAt, @result, @error, @status, @retryAfter
    )
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state,
      phase = excluded.phase,
      backend = excluded.backend,
      task_id = excluded.task_id,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      result = excluded.result,
      error = excluded.error,
      status = excluded.status,
      retry_after = excluded.retry_after
  `)
  const getJobStatement = connection.prepare('SELECT * FROM ai_jobs WHERE id = ?')
  const deleteJobStatement = connection.prepare('DELETE FROM ai_jobs WHERE id = ?')
  const interruptJobsStatement = connection.prepare(`
    UPDATE ai_jobs
    SET state = 'error', phase = 'finished', error = ?, finished_at = ?
    WHERE state IN ('queued', 'running')
  `)
  return {
    listJobs() {
      return listJobsStatement.all().map(toJob)
    },
    getJob(id) {
      return toJob(getJobStatement.get(id))
    },
    saveJob(job) {
      saveJobStatement.run({
        id: job.id,
        state: job.state,
        phase: job.phase ?? 'queued',
        model: job.model,
        backend: job.backend ?? null,
        taskId: job.taskId ?? null,
        title: job.title,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        result: job.result === undefined ? null : JSON.stringify(job.result),
        error: job.error ?? null,
        status: job.status ?? null,
        retryAfter: job.retryAfter ?? null
      })
      return toJob(getJobStatement.get(job.id))
    },
    deleteJob(id) {
      return deleteJobStatement.run(id).changes > 0
    },
    markInterruptedJobs(message, finishedAt = Date.now()) {
      return interruptJobsStatement.run(message, finishedAt).changes
    },
  }
}

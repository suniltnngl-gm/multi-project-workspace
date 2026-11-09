/**
 * Objective: Verify behavior and regressions for apps/web/src/lib.test.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/web/src/lib.test.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDraftInput,
  buildTaskQuery,
  formatAiRun,
  formatBudget,
  formatBusyMessage,
  formatDuration,
  formatJobProgress,
  formatModelMeta,
  formatRelativeTime,
  formatTaskActivity,
  waitForRetry
} from './lib.js'

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(1500)).toBe('2s')
    expect(formatDuration(90_000)).toBe('1m 30s')
    expect(formatDuration(3_726_000)).toBe('1h 2m')
  })

  it('rejects missing durations', () => {
    expect(formatDuration(undefined)).toBe('unknown')
    expect(formatDuration(-1)).toBe('unknown')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z')

  it('formats recent and older timestamps', () => {
    expect(formatRelativeTime('2026-11-09T11:59:40.000Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-11-09T11:58:30.000Z', now)).toBe('2m ago')
    expect(formatRelativeTime('2026-11-09T09:00:00.000Z', now)).toBe('3h ago')
    expect(formatRelativeTime('2026-11-06T12:00:00.000Z', now)).toBe('3d ago')
    expect(formatRelativeTime('2026-09-09T12:00:00.000Z', now)).toBe('2mo ago')
    expect(formatRelativeTime('2025-11-09T12:00:00.000Z', now)).toBe('1y ago')
  })

  it('rejects missing values', () => {
    expect(formatRelativeTime(undefined, now)).toBe('unknown')
    expect(formatRelativeTime('not a date', now)).toBe('unknown')
  })
})

describe('formatTaskActivity', () => {
  it('labels creation and readable field transitions', () => {
    expect(formatTaskActivity({ action: 'created' })).toBe('Created')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'status',
      oldValue: 'todo',
      newValue: 'in_progress'
    })).toBe('Status: Todo → In progress')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'priority',
      oldValue: 'medium',
      newValue: 'high'
    })).toBe('Priority: Medium → High')
  })

  it('summarizes long text edits without dumping the value', () => {
    expect(formatTaskActivity({
      action: 'updated',
      field: 'description',
      oldValue: '',
      newValue: 'A long description'
    })).toBe('Description updated')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'acceptance_criteria'
    })).toBe('Acceptance criteria updated')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'objectives'
    })).toBe('Objectives updated')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'relevant_files'
    })).toBe('Relevant files updated')
    expect(formatTaskActivity({
      action: 'updated',
      field: 'important_context'
    })).toBe('Important context updated')
  })
})

describe('formatModelMeta', () => {
  it('joins budget, session, and usage details', () => {
    expect(formatModelMeta({
      budget: { used: 2, limit: 10 },
      sessionState: 'absent',
      requests: 3,
      failures: 1,
      lastDurationMs: 1500
    })).toBe('budget 2/10 today · session absent · 3 requests · 1 failed · last 2s')
  })

  it('returns an empty string without details', () => {
    expect(formatModelMeta({ id: 'local' })).toBe('')
  })
})

describe('formatBudget', () => {
  it('labels daily limits as today', () => {
    expect(formatBudget({ used: 2, limit: 10, window: 'day', unit: 'requests' }))
      .toBe('budget 2/10 today')
  })

  it('names non-daily windows and units', () => {
    expect(formatBudget({ used: 1, limit: 30, window: 'minute', unit: 'requests' }))
      .toBe('budget 1/30 minute requests')
    expect(formatBudget({ used: 500, limit: 6000, window: 'hour', unit: 'tokens' }))
      .toBe('budget 500/6000 hour tokens')
  })

  it('labels depleting pools without a window', () => {
    expect(formatBudget({ used: 10, limit: 10, window: 'none', unit: 'compute_seconds' }))
      .toBe('budget 10/10 compute pool')
  })
})

describe('formatJobProgress', () => {
  it('includes the phase and elapsed time', () => {
    expect(formatJobProgress({ id: 'job-2', state: 'running', phase: 'generating', elapsedMs: 65_000 }))
      .toBe('Batch job job-2 is generating · 1m 5s. Waiting…')
  })

  it('falls back to the job state', () => {
    expect(formatJobProgress({ id: 'job-3', state: 'queued' }))
      .toBe('Batch job job-3 is queued. Waiting…')
  })
})

describe('formatBusyMessage', () => {
  it('joins resource reasons and includes the retry delay', () => {
    expect(formatBusyMessage(['CPU load high', 'memory low'], 7))
      .toBe('Local AI paused: CPU load high; memory low. Checking again in 7 seconds.')
  })

  it('falls back when no reasons are supplied', () => {
    expect(formatBusyMessage(undefined, 5))
      .toBe('Local AI paused: one or more resource limits are exceeded. Checking again in 5 seconds.')
  })
})

describe('buildTaskQuery', () => {
  it('keeps non-empty filters and encodes them', () => {
    const data = new FormData()
    data.set('search', 'release notes')
    data.set('project', '')
    data.set('status', 'in_progress')

    expect(buildTaskQuery(data)).toBe('search=release+notes&status=in_progress')
  })

  it('returns an empty string without filters', () => {
    expect(buildTaskQuery(new FormData())).toBe('')
  })
})

describe('buildDraftInput', () => {
  it('keeps draftable task fields and drops save-only fields', () => {
    const data = new FormData()
    data.set('title', 'Draft this')
    data.set('description', 'Notes')
    data.set('acceptance_criteria', 'It works')
    data.set('objectives', 'Ship a structured task')
    data.set('requirements', 'Preserve existing workflows')
    data.set('decisions', 'Use dedicated columns')
    data.set('relevant_files', 'apps/web/src/lib.js')
    data.set('important_context', 'Keep services loopback-only')
    data.set('work_completed', 'Tests pass')
    data.set('work_active', 'Reviewing')
    data.set('work_blocked', 'None')
    data.set('next_move', 'Commit')
    data.set('project', 'web')
    data.set('task_type', 'feature')
    data.set('priority', 'high')
    data.set('status', 'todo')

    expect(buildDraftInput(data)).toEqual({
      title: 'Draft this',
      description: 'Notes',
      acceptance_criteria: 'It works',
      objectives: 'Ship a structured task',
      requirements: 'Preserve existing workflows',
      decisions: 'Use dedicated columns',
      relevant_files: 'apps/web/src/lib.js',
      important_context: 'Keep services loopback-only',
      work_completed: 'Tests pass',
      work_active: 'Reviewing',
      work_blocked: 'None',
      next_move: 'Commit',
      project: 'web',
      task_type: 'feature'
    })
  })
})

describe('formatAiRun', () => {
  it('includes model, backend, state, phase, and duration', () => {
    expect(formatAiRun({
      model: 'local-0.5b',
      backend: 'http',
      state: 'done',
      phase: 'finished',
      durationMs: 2000
    })).toBe('local-0.5b · http · done (finished) · 2s')
  })

  it('includes the error and retry hint for failed runs', () => {
    expect(formatAiRun({
      model: 'kaggle-3b',
      backend: 'kaggle-cli',
      state: 'error',
      phase: 'finished',
      durationMs: 65_000,
      error: 'Kaggle runner failed.',
      retryAfter: 30
    })).toBe('kaggle-3b · kaggle-cli · error (finished) · 1m 5s — Kaggle runner failed. (retry in 30s)')
  })
})

describe('waitForRetry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the requested delay', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = waitForRetry(3000, controller.signal)
    let settled = false
    pending.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects when the signal is aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = waitForRetry(3000, controller.signal)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(waitForRetry(3000, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

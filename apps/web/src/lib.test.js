import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTaskQuery,
  formatBudget,
  formatBusyMessage,
  formatDuration,
  formatJobProgress,
  formatModelMeta,
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

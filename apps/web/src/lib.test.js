import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTaskQuery, formatBusyMessage, waitForRetry } from './lib.js'

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

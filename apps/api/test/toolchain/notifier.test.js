import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitNotification,
  diffRemoteStates,
  eventsLogPath,
  readUnreadEvents,
  advanceEventCursor,
  routeNotificationAction
} from '../../src/toolchain/dispatch/notifier.js'

test('emitNotification logs to events.jsonl and diffRemoteStates is edge-triggered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-notify-'))
  try {
    const res = emitNotification({
      title: 'Kaggle GPU complete',
      body: 'batch-responses.json ready',
      severity: 'info',
      source: 'kaggle',
      stateDir: dir,
      desktop: false
    })
    assert.strictEqual(res.ok, true)
    const logged = JSON.parse(readFileSync(eventsLogPath(dir), 'utf8').trim())
    assert.strictEqual(logged.source, 'kaggle')
    assert.strictEqual(logged.title, 'Kaggle GPU complete')

    const t1 = diffRemoteStates({ kaggleGpu: 'QUEUED', githubCi: 'ok' }, { kaggleGpu: 'COMPLETE', githubCi: 'ok' })
    assert.strictEqual(t1.length, 1)
    assert.strictEqual(t1[0].key, 'kaggleGpu')

    const t2 = diffRemoteStates({ kaggleGpu: 'COMPLETE', githubCi: 'ok' }, { kaggleGpu: 'COMPLETE', githubCi: 'ok' })
    assert.strictEqual(t2.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readUnreadEvents + advanceEventCursor + routeNotificationAction are idempotent and fail-closed on critical events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-notify-consume-'))
  try {
    const e1 = emitNotification({ title: 'kaggleGpu changed', body: 'QUEUED -> COMPLETE', source: 'kaggle', stateDir: dir, desktop: false }).record
    const e2 = emitNotification({ title: 'guardrail', body: 'circuit_breaker_open', severity: 'critical', source: 'swarm', stateDir: dir, desktop: false }).record

    const unread1 = readUnreadEvents(dir)
    assert.strictEqual(unread1.length, 2)
    assert.strictEqual(routeNotificationAction(unread1[0]).action, 'pull_kaggle_output')
    assert.strictEqual(routeNotificationAction(unread1[0]).autoExecute, true)
    assert.strictEqual(routeNotificationAction(unread1[1]).action, 'escalate_operator')
    assert.strictEqual(routeNotificationAction(unread1[1]).autoExecute, false)

    advanceEventCursor(dir, e2.id)
    assert.strictEqual(readUnreadEvents(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

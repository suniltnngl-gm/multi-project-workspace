import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitNotification,
  diffRemoteStates,
  eventsLogPath
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

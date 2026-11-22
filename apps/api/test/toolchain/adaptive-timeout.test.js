import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdaptiveTimeout } from '../../src/toolchain/dispatch/adaptive-timeout.js'
import { buildCliCommand } from '../../src/toolchain/dispatch/cli-commands.js'

test('createAdaptiveTimeout fires idle_after_output_timeout once output stops and resets on activity', async () => {
  const events = []
  const ctrl = createAdaptiveTimeout({
    idleAfterOutputMs: 40,
    hardTimeoutMs: 500,
    onTimeout: (e) => events.push(e)
  })
  ctrl.markOutput()
  await new Promise((r) => setTimeout(r, 20))
  ctrl.markOutput()
  await new Promise((r) => setTimeout(r, 70))
  ctrl.clear()
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].reason, 'idle_after_output_timeout')
  assert.strictEqual(events[0].hasOutput, true)
})

test('createAdaptiveTimeout fires hard_timeout when no output arrives', async () => {
  const events = []
  const ctrl = createAdaptiveTimeout({
    idleAfterOutputMs: 20,
    hardTimeoutMs: 50,
    onTimeout: (e) => events.push(e)
  })
  await new Promise((r) => setTimeout(r, 80))
  ctrl.clear()
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].reason, 'hard_timeout')
  assert.strictEqual(events[0].hasOutput, false)
})

test('SWARM_HERMES_SESSION_OVERRIDE temporarily attaches --resume without mutating registry', () => {
  const prev = process.env.SWARM_HERMES_SESSION_OVERRIDE
  process.env.SWARM_HERMES_SESSION_OVERRIDE = 'local-9fb94b13935fdb814bf362b8c9ca0acb53d4da35c34a2032bdd1d32d8b5b52e9'
  try {
    const cmd = buildCliCommand({
      cli: 'hermes',
      model: 'meituan/longcat-2.5:free',
      provider: 'nous',
      prompt: 'Ping',
      cwd: '/tmp'
    })
    assert.strictEqual(cmd.ok, true)
    assert.ok(cmd.argv.includes('--resume'))
    assert.ok(cmd.argv.includes('local-9fb94b13935fdb814bf362b8c9ca0acb53d4da35c34a2032bdd1d32d8b5b52e9'))
  } finally {
    if (prev === undefined) delete process.env.SWARM_HERMES_SESSION_OVERRIDE
    else process.env.SWARM_HERMES_SESSION_OVERRIDE = prev
  }
})

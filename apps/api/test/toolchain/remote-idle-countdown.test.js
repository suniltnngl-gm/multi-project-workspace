import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createIdleState,
  markWorkStart,
  markWorkEnd,
  shouldStopSession
} from '../../src/toolchain/dispatch/remote-idle-countdown.js'

test('idle countdown never stops mid-work and resets cleanly on reconnect', () => {
  const t0 = 1_000_000
  let st = createIdleState('gpu-batch', { nowMs: t0, idleTimeoutMs: 300_000 })
  const armedGen1 = st.generation

  // Reconnect & start work before countdown expires
  st = markWorkStart(st, { nowMs: t0 + 100_000 })
  // Old timer fires at t0 + 300_000 -> MUST NOT stop while work is active
  const midWork = shouldStopSession(st, { expectedGeneration: armedGen1, nowMs: t0 + 300_000 })
  assert.strictEqual(midWork.shouldStop, false)
  assert.strictEqual(midWork.reason, 'work_in_progress')

  // Work finishes -> arms fresh countdown (gen 3)
  st = markWorkEnd(st, { nowMs: t0 + 400_000 })
  const armedGen3 = st.generation

  // Stale timer (gen 1) firing later -> MUST NOT stop
  const stale = shouldStopSession(st, { expectedGeneration: armedGen1, nowMs: t0 + 500_000 })
  assert.strictEqual(stale.shouldStop, false)
  assert.strictEqual(stale.reason, 'stale_countdown_reset_by_reconnect')

  // Current timer (gen 3) before expiry -> MUST NOT stop
  assert.strictEqual(shouldStopSession(st, { expectedGeneration: armedGen3, nowMs: t0 + 699_999 }).shouldStop, false)

  // Current timer (gen 3) after expiry -> safe to stop
  const stop = shouldStopSession(st, { expectedGeneration: armedGen3, nowMs: t0 + 700_000 })
  assert.strictEqual(stop.shouldStop, true)
  assert.deepStrictEqual(stop.command, { bin: 'colab', argv: ['stop', '-s', 'gpu-batch'] })
})

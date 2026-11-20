import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateResourceGate, resolveGateConfig } from '../../src/toolchain/dispatch/resource-gate.js'

describe('sp004-resource-gate', () => {
  const config = {
    maxConcurrentProcesses: 2,
    minFreeMemoryMb: 1000,
    maxLoadAvgRatio: 1.0,
    retryAfterMs: 15000
  }

  test('admits when resources are available', () => {
    const res = evaluateResourceGate({
      activeProcesses: 0,
      telemetry: { freeMemoryMb: 2000, loadAvg1: 0.5, cpuCount: 2, platform: 'linux' },
      config,
      nowMs: Date.now()
    })
    assert.strictEqual(res.verdict, 'admitted')
  })

  test('defers when too many processes', () => {
    const res = evaluateResourceGate({
      activeProcesses: 2,
      telemetry: { freeMemoryMb: 2000, loadAvg1: 0.5, cpuCount: 2, platform: 'linux' },
      config,
      nowMs: Date.now()
    })
    assert.strictEqual(res.verdict, 'deferred')
    assert.strictEqual(res.primaryReason, 'resource_gate_busy')
  })

  test('defers on low memory', () => {
    const res = evaluateResourceGate({
      activeProcesses: 0,
      telemetry: { freeMemoryMb: 500, loadAvg1: 0.5, cpuCount: 2, platform: 'linux' },
      config,
      nowMs: Date.now()
    })
    assert.strictEqual(res.verdict, 'deferred')
    assert.strictEqual(res.primaryReason, 'resource_gate_low_memory')
  })

  test('defers on high load', () => {
    const res = evaluateResourceGate({
      activeProcesses: 0,
      telemetry: { freeMemoryMb: 2000, loadAvg1: 3.0, cpuCount: 1, platform: 'linux' },
      config,
      nowMs: Date.now()
    })
    assert.strictEqual(res.verdict, 'deferred')
    assert.strictEqual(res.primaryReason, 'resource_gate_high_load')
  })

  test('skips load on win32', () => {
    const res = evaluateResourceGate({
      activeProcesses: 0,
      telemetry: { freeMemoryMb: 2000, loadAvg1: 10.0, cpuCount: 1, platform: 'win32' },
      config,
      nowMs: Date.now()
    })
    assert.strictEqual(res.verdict, 'admitted')
    assert.ok(res.notes.includes('load_unavailable'))
  })

  test('throws on invalid config', () => {
    assert.throws(() => resolveGateConfig({ overrides: { maxConcurrentProcesses: 0 } }), RangeError)
  })
})

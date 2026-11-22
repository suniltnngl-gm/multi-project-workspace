import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  recordPoolCall,
  countPoolCallsInWindow,
  checkPoolFiveHourAdmission,
  evaluateOvernightGuard,
  killSwitchPath,
  FIVE_HOURS_MS
} from '../../src/toolchain/dispatch/overnight-supervisor.js'
import { createTask } from '../../src/toolchain/dispatch/job-queue.js'

const CLI_PATH = fileURLToPath(new URL('../../../../scripts/swarm-overnight.mjs', import.meta.url))

test('persistent 5-hour pool ledger enforces copilot=1/5h, agy=4/5h, and expires old calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overnight-ledger-'))
  try {
    const t0 = 10_000_000_000
    assert.strictEqual(checkPoolFiveHourAdmission(dir, 'github-copilot', { nowMs: t0 }).admitted, true)
    recordPoolCall(dir, { quotaPool: 'github-copilot', taskId: 't1', nowMs: t0 })
    assert.strictEqual(checkPoolFiveHourAdmission(dir, 'github-copilot', { nowMs: t0 + 1000 }).admitted, false)
    // After 5h + 1s, call expires and copilot is admitted again
    assert.strictEqual(checkPoolFiveHourAdmission(dir, 'github-copilot', { nowMs: t0 + FIVE_HOURS_MS + 1000 }).admitted, true)

    for (let i = 0; i < 4; i++) {
      recordPoolCall(dir, { quotaPool: 'agy-gemini', taskId: `a${i}`, nowMs: t0 + i * 1000 })
    }
    assert.strictEqual(countPoolCallsInWindow(dir, 'agy-gemini', { nowMs: t0 + 10_000 }), 4)
    assert.strictEqual(checkPoolFiveHourAdmission(dir, 'agy-gemini', { nowMs: t0 + 10_000 }).admitted, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluateOvernightGuard honors kill-switch, maxTicks, maxDurationMs, and circuit breaker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overnight-guard-'))
  try {
    const t0 = 1_000_000
    assert.strictEqual(evaluateOvernightGuard({ stateDir: dir, startedAtMs: t0, nowMs: t0 + 1000 }).continue, true)
    assert.strictEqual(evaluateOvernightGuard({ stateDir: dir, startedAtMs: t0, nowMs: t0 + 1000, ticksCompleted: 5, maxTicks: 5 }).reason, 'max_ticks_reached:5/5')
    assert.match(evaluateOvernightGuard({ stateDir: dir, startedAtMs: t0, nowMs: t0 + 60_000, maxDurationMs: 30_000 }).reason, /max_duration_reached/)
    assert.strictEqual(evaluateOvernightGuard({ stateDir: dir, startedAtMs: t0, nowMs: t0 + 1000, consecutiveFailures: 3, maxConsecutiveFailures: 3 }).reason, 'circuit_breaker_open:3/3')

    writeFileSync(killSwitchPath(dir), 'stop\n', 'utf8')
    assert.strictEqual(evaluateOvernightGuard({ stateDir: dir, startedAtMs: t0, nowMs: t0 + 1000 }).reason, 'kill_switch_present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('swarm-overnight.mjs --dry-run runs bounded ticks and writes atomic overnight-report.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overnight-cli-'))
  try {
    const stateDir = join(dir, 'state')
    const queueDir = join(dir, 'queue')
    createTask(queueDir, { taskId: 't-overnight-1', priority: 'P1', costTier: 'local', jobs: [{ type: 'plan' }] })

    const out = execFileSync(
      process.execPath,
      [CLI_PATH, '--state-dir', stateDir, '--queue-dir', queueDir, '--max-ticks', '2', '--dry-run', '--json'],
      { encoding: 'utf8' }
    )
    const parsed = JSON.parse(out)
    assert.strictEqual(parsed.ok, true)
    assert.strictEqual(parsed.mode, 'dry-run')
    assert.strictEqual(parsed.ticksExecuted, 2)
    assert.strictEqual(parsed.stopReason, 'max_ticks_reached:2/2')
    assert.ok(parsed.reportPath.endsWith('overnight-report.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

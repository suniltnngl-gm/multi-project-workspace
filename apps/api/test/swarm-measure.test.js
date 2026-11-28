// SOLVE-003-MEASURE: the Measure phase of the Discover -> Decide -> Measure loop.
// For every resolved case, measure verifies the decision against recorded evidence,
// appends to a durable decision-outcome ledger, and marks the case measured.
// It also aggregates relay attempt telemetry (failureClass from #278) into the
// same report so sibling health is measured alongside decision outcomes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCase } from '../../../apps/api/src/toolchain/dispatch/case-registry.js'
import { measureResolvedCases, aggregateRelayTelemetry } from '../../../scripts/swarm-measure.mjs'

const MEASURE_CLI = resolve(new URL('../../../scripts/swarm-measure.mjs', import.meta.url).pathname)
const DISCOVER_CLI = resolve(new URL('../../../scripts/swarm-discover.mjs', import.meta.url).pathname)
const CASE_SOLVE_CLI = resolve(new URL('../../../scripts/swarm-case-solve.mjs', import.meta.url).pathname)

function seedResolvedCase(dir, { id = 'case-measure-check', score = 55 } = {}) {
  const casesDir = join(dir, 'queue', 'cases')
  mkdirSync(casesDir, { recursive: true })
  mkdirSync(join(dir, 'queue', 'active'), { recursive: true })
  const seed = {
    multi_option_cases: [{
      id,
      title: 'Measured case',
      state: 'open_case',
      priority: 'P3',
      options: [{ id: 'opt-1', label: 'Recommended safe option' }, { id: 'opt-2', label: 'Alternative safe option' }],
      findings: {}
    }]
  }
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed))
  const reg = spawnSync(process.execPath, [DISCOVER_CLI, '--mode', 'discover', '--queue-dir', join(dir, 'queue', 'active'), '--case-dir', casesDir, '--seed-json', join(dir, 'seed.json'), '--apply'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
  assert.equal(reg.status, 0, reg.stderr)
  const solve = spawnSync(process.execPath, [CASE_SOLVE_CLI, '--sandbox', '--apply', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
  assert.equal(solve.status, 0, solve.stderr)
  return casesDir
}

test('MEASURE: measures a resolved case into the ledger and marks it measured (apply)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-'))
  try {
    const casesDir = seedResolvedCase(dir)
    const res = await measureResolvedCases(casesDir, { apply: true })
    assert.equal(res.measuredCount, 1)
    assert.equal(res.measured[0].caseId, 'case-measure-check')
    assert.equal(res.measured[0].selectedOption, 'opt-1')
    assert.ok(existsSync(res.ledgerPath), 'ledger must be persisted')
    const row = JSON.parse(readFileSync(res.ledgerPath, 'utf8').trim().split('\n').pop())
    assert.equal(row.caseId, 'case-measure-check')
    assert.equal(row.decision, 'resolved')
    assert.equal(typeof row.measuredAt, 'string')

    // Idempotent: an already-measured case is not measured twice.
    const again = await measureResolvedCases(casesDir, { apply: true })
    assert.equal(again.measuredCount, 0)

    // The case history records the measurement.
    const rec = readCase(casesDir, 'case-measure-check')
    assert.ok((rec.history || []).some((h) => h.event === 'measured_by_swarm'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MEASURE: dry-run measures nothing and persists no ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-dry-'))
  try {
    const casesDir = seedResolvedCase(dir)
    const res = await measureResolvedCases(casesDir, { apply: false })
    assert.equal(res.measuredCount, 1, 'dry-run still reports what would be measured')
    assert.equal(res.ledgerPath, null)
    const rec = readCase(casesDir, 'case-measure-check')
    assert.ok(!(rec.history || []).some((h) => h.event === 'measured_by_swarm'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MEASURE: aggregateRelayTelemetry sums failureClass distribution from relay reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-tel-'))
  try {
    const reportsDir = join(dir, 'reports')
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(join(reportsDir, 'relay-pipeline-a.json'), JSON.stringify({
      windows: [{ attemptedModels: [{ model: 'gemini-3.8-flash', status: 'exit_1', failureClass: 'rpm_throttled' }] }]
    }))
    writeFileSync(join(reportsDir, 'relay-pipeline-b.json'), JSON.stringify({
      windows: [
        { attemptedModels: [{ model: 'gemini-2.5-flash', status: 'exit_1', failureClass: 'real_failure' }] },
        { attemptedModels: [{ model: 'hermes', status: 'ok' }] }
      ]
    }))
    const agg = aggregateRelayTelemetry(reportsDir)
    assert.equal(agg.attemptsTotal, 3)
    assert.equal(agg.failureClasses.rpm_throttled, 1)
    assert.equal(agg.failureClasses.real_failure, 1)
    assert.equal(agg.ok, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MEASURE: swarm measure CLI runs read-only against an isolated state dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-cli-'))
  try {
    seedResolvedCase(dir)
    const res = spawnSync(process.execPath, [MEASURE_CLI, '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.measuredCount, 1, 'dry-run reports what would be measured')
    assert.equal(out.ledgerPath, null, 'dry-run persists no ledger')
    const rec = readCase(join(dir, 'queue', 'cases'), 'case-measure-check')
    assert.ok(!(rec.history || []).some((h) => h.event === 'measured_by_swarm'), 'dry-run must not mark measured')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

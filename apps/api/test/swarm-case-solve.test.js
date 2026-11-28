import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCase } from '../../../apps/api/src/toolchain/dispatch/case-registry.js'

const CLI = resolve(new URL('../../../scripts/swarm-case-solve.mjs', import.meta.url).pathname)

function readCaseState(casesDir, id) {
  return readCase(casesDir, id)?.state ?? null
}

test('SOLVE-002: --sandbox gathers findings and auto-resolves a clear winner on --apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-sandbox-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    const seed = {
      multi_option_cases: [{
        id: 'case-sandbox-check',
        title: 'Sandbox-decided case',
        state: 'open_case',
        priority: 'P3',
        options: [{ id: 'opt-1', label: 'Recommended safe option' }, { id: 'opt-2', label: 'Alternative safe option' }],
        findings: {}
      }]
    }
    writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed))
    const discover = resolve(new URL('../../../scripts/swarm-discover.mjs', import.meta.url).pathname)
    const reg = spawnSync(process.execPath, [discover, '--mode', 'discover', '--queue-dir', join(dir, 'queue', 'active'), '--case-dir', casesDir, '--seed-json', join(dir, 'seed.json'), '--apply'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(reg.status, 0, reg.stderr)

    // Dry-run: decision previewed, nothing persisted.
    const dry = spawnSync(process.execPath, [CLI, '--sandbox', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(dry.status, 0, dry.stderr)
    const dryOut = JSON.parse(dry.stdout)
    assert.equal(dryOut.sandboxEnabled, true)
    assert.equal(dryOut.scanned, 1)
    const dryRecord = readCase(casesDir, 'case-sandbox-check')
    assert.equal(dryRecord.state, 'open_case', 'dry-run must not persist')
    assert.deepEqual(dryRecord.findings?.opt_1 ?? dryRecord.findings?.['opt-1'] ?? {}, {}, 'dry-run must not persist findings')

    // Apply: findings recorded for every option, winner resolved with history.
    const applied = spawnSync(process.execPath, [CLI, '--sandbox', '--apply', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(applied.status, 0, applied.stderr)
    const out = JSON.parse(applied.stdout)
    assert.equal(out.resolvedCount, 1)
    const rec = readCase(casesDir, 'case-sandbox-check')
    assert.equal(rec.state, 'resolved')
    assert.equal(rec.selectedOption, 'opt-1', `expected first-ranked winner: ${JSON.stringify(rec.findings)}`)
    const findingKeys = Object.keys(rec.findings || {})
    assert.ok(findingKeys.length >= 2, `findings must cover all options: ${findingKeys}`)
    assert.ok((rec.history || []).some((h) => h.event === 'auto_resolved_by_swarm'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SOLVE-002: --sandbox pauses on unrecoverable options and records the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-sandbox-ur-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    const seed = {
      multi_option_cases: [{
        id: 'case-unrecoverable-check',
        title: 'Case with an unrecoverable option',
        state: 'open_case',
        priority: 'P3',
        options: [{ id: 'opt-1', label: 'safe option' }, { id: 'opt-2', label: 'clean up by running rm -rf / on the build host' }],
        findings: {}
      }]
    }
    writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed))
    const discover = resolve(new URL('../../../scripts/swarm-discover.mjs', import.meta.url).pathname)
    const reg = spawnSync(process.execPath, [discover, '--mode', 'discover', '--queue-dir', join(dir, 'queue', 'active'), '--case-dir', casesDir, '--seed-json', join(dir, 'seed.json'), '--apply'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(reg.status, 0, reg.stderr)

    const applied = spawnSync(process.execPath, [CLI, '--sandbox', '--apply', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(applied.status, 0, applied.stderr)
    const out = JSON.parse(applied.stdout)
    assert.equal(out.pausedCount, 1)
    assert.match(out.paused[0].reason, /unrecoverable_option_detected/)
    const rec = readCase(casesDir, 'case-unrecoverable-check')
    assert.equal(rec.state, 'open_case', 'a paused case must stay open')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MC-206+: case-solve scans open cases from the sqlite case registry (and resolves on --apply)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-registry-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    const seed = { id: 'case-registry-check', title: 'Registry-backed case', state: 'open_case', priority: 'P3', options: [{ id: 'opt-1', label: 'Only safe option' }, { id: 'opt-2', label: 'Alternative safe option' }], findings: {} }
    writeFileSync(join(dir, 'seed.json'), JSON.stringify({ multi_option_cases: [seed] }))
    // Register it through the discover CLI so it lands in cases.sqlite the canonical way.
    const discover = resolve(new URL('../../../scripts/swarm-discover.mjs', import.meta.url).pathname)
    const reg = spawnSync(process.execPath, [discover, '--mode', 'discover', '--queue-dir', join(dir, 'queue', 'active'), '--case-dir', casesDir, '--seed-json', join(dir, 'seed.json'), '--apply'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(reg.status, 0, reg.stderr)

    const dry = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(dry.status, 0, dry.stderr)
    const dryOut = JSON.parse(dry.stdout)
    assert.equal(dryOut.scanned, 1, `registry case not scanned: ${dry.stdout}`)
    // Dry-run previews the decision but must not persist it.
    assert.equal(readCaseState(casesDir, 'case-registry-check'), 'open_case', 'dry-run persisted a resolution')

    const applied = spawnSync(process.execPath, [CLI, '--apply', '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(applied.status, 0, applied.stderr)
    const out = JSON.parse(applied.stdout)
    assert.equal(out.scanned, 1)
    assert.equal(out.resolvedCount, 1)
    assert.equal(out.resolved[0].id, 'case-registry-check')

    const recheck = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env: { ...process.env, SWARM_STATE_DIR: dir } })
    assert.equal(JSON.parse(recheck.stdout).scanned, 0, 'resolved case must leave the open set')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#233: case-solve scans cases under SWARM_STATE_DIR, not the default state root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-solve-state-override-'))
  try {
    const casesDir = join(dir, 'queue', 'cases')
    mkdirSync(casesDir, { recursive: true })
    writeFileSync(join(casesDir, 'case-override-check.json'), JSON.stringify({
      id: 'case-override-check',
      title: 'Isolated case',
      state: 'open_case',
      options: [{ id: 'opt-1', label: 'Only option' }],
      findings: {}
    }))
    const res = spawnSync(process.execPath, [CLI, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_STATE_DIR: dir }
    })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.scanned, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SOLVE-005: the default runner penalizes options referencing siblings with recent throttled failures', async () => {
  const { solveCaseWithSandbox } = await import('../../../scripts/swarm-case-solve.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'case-tel-'))
  try {
    const reportsDir = join(dir, 'reports')
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(join(reportsDir, 'relay-pipeline-tel.json'), JSON.stringify({
      windows: [{ attemptedModels: [{ model: 'gemini-3.8-flash', status: 'exit_1', failureClass: 'rpm_throttled' }] }]
    }))
    const caseObj = {
      id: 'case-tel-check',
      state: 'open_case',
      options: [
        { id: 'opt-1', label: 'Retry with gemini-api directly' },
        { id: 'opt-2', label: 'Retry with hermes instead' }
      ],
      findings: {}
    }
    const verdict = await solveCaseWithSandbox(caseObj, { reportsDir })
    assert.equal(verdict.action, 'select_winner')
    assert.equal(verdict.selectedOption, 'opt-2', 'the throttled-sibling option must lose to clean telemetry: ' + JSON.stringify(verdict.results))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('W3 (#290): cold-start lesson penalty — a previously failed option class loses with zero telemetry', async () => {
  const { solveCaseWithSandbox } = await import('../../../scripts/swarm-case-solve.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'case-lesson-'))
  try {
    const lessonsDir = join(dir, 'lessons')
    mkdirSync(lessonsDir, { recursive: true })
    writeFileSync(join(lessonsDir, 'decision-lessons.jsonl'), `${JSON.stringify({
      lessonId: 'LES-DECISION-CASE-X-OPT-1', category: 'decision-reopen', caseId: 'case-x',
      failedOption: 'opt-1', failedLabel: 'Retry with gemini-api directly',
      tags: ['gemini-api', 'retry'], recordedAt: '2026-11-28T00:00:00.000Z'
    })}\n`)
    const caseObj = {
      id: 'case-lesson-cold',
      state: 'open_case',
      options: [
        { id: 'opt-1', label: 'Retry with gemini-api directly' },
        { id: 'opt-2', label: 'Switch to hermes lane' }
      ],
      findings: {}
    }
    const verdict = await solveCaseWithSandbox(caseObj, { reportsDir: join(dir, 'no-reports'), lessonsDir })
    assert.equal(verdict.action, 'select_winner')
    assert.equal(verdict.selectedOption, 'opt-2', 'the lesson-failed sibling must lose on lessons alone: ' + JSON.stringify(verdict.results))
    const notes = verdict.caseRecord?.findings?.['opt-1']?.notes || ''
    assert.match(notes, /lesson_penalty\(15\)/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

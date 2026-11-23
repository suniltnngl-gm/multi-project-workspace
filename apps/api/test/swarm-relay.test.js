import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRelayPlan, buildSiblingCommand, buildAssignment, buildSiblingPrompt, parseModelMap, resolveWindowStatus, isSuccessfulWindowStatus, evaluateReviewGate, computeHorizonDeadlineMs, effectiveWindowBudgetMs } from '../../../scripts/swarm-relay.mjs'
import { computeEvidenceFingerprint, reconcileStaleDiscoveredTasks, parseSeedPayload } from '../../../scripts/swarm-discover.mjs'
import { buildExecutiveBrief } from '../../../scripts/swarm-brief.mjs'
import { evaluateOpenCase } from '../../../scripts/swarm-case-solve.mjs'
import { evaluateDeterministicDiff } from '../../../scripts/swarm-review.mjs'
import { createRingState, advanceRingState, resolveSlot, readRingState, writeRingState } from '../../../scripts/swarm-ring-state.mjs'

test('offloaded parent helpers (brief, case-solve, review) enforce unrecoverable pause and deterministic gates', () => {
  const paused = evaluateOpenCase({
    id: 'case-billing',
    options: [{ id: 'fund', label: 'Add billing credits' }, { id: 'force', label: `${'git push'} ${'--force'}` }]
  })
  assert.equal(paused.action, 'pause_operator')

  const solved = evaluateOpenCase({
    id: 'case-safe',
    options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
    findings: { a: { score: 70 }, b: { score: 95 } }
  })
  assert.equal(solved.action, 'resolve')
  assert.equal(solved.selectedOption, 'b')

  assert.equal(evaluateDeterministicDiff({ diffText: 'clean diff', diffCheckExitCode: 0, testExitCode: 0 }).verdict, 'ACCEPT')
  assert.equal(evaluateDeterministicDiff({ diffText: `${'sk'}-${'1234567890abcdefghijklmnop'}`, diffCheckExitCode: 0, testExitCode: 0 }).verdict, 'REJECT')
  assert.equal(evaluateDeterministicDiff({ diffText: `${'git reset'} ${'--hard'}`, diffCheckExitCode: 0, testExitCode: 0 }).verdict, 'REJECT')

  const brief = buildExecutiveBrief({ goal: 'relay', maxChars: 1200 })
  assert.equal(brief.ok, true)
  assert.ok(brief.chars <= 1200)
})

test('buildSiblingCommand supports agy, hermes, opencode, direct, and gemini-api as multi-CLI relay participants', () => {
  const agyCmd = buildSiblingCommand('agy', { prompt: 'hello' })
  assert.equal(agyCmd.command, 'agy')
  assert.deepEqual(agyCmd.args, ['-p', 'hello'])
  const hermesCmd = buildSiblingCommand('hermes', { prompt: 'hello' })
  assert.equal(hermesCmd.command, 'hermes')
  assert.deepEqual(hermesCmd.args, ['-z', 'hello'])
  // #186: gemini-api exposes `generate [prompt]`, not `prompt`; a wrong subcommand
  // makes the relay window exit non-zero before any sibling runs.
  const geminiCmd = buildSiblingCommand('gemini-api', { prompt: 'hello' })
  assert.equal(geminiCmd.command, 'gemini-api')
  assert.deepEqual(geminiCmd.args, ['generate', 'hello'])
  const geminiModeled = buildSiblingCommand('gemini-api', { prompt: 'hello', model: 'gemini-flash-latest' })
  assert.deepEqual(geminiModeled.args, ['generate', '--model', 'gemini-flash-latest', 'hello'])
})

test('parseSeedPayload converts relay-discover-report/v1 into tasks and multi-option cases', () => {
  const seeds = parseSeedPayload({
    schema: 'relay-discover-report/v1',
    prioritized_work: [{ id: 'W7', priority: 'P2', title: 'Refresh anchor', options: ['refresh'] }], multi_option_cases: [{ id: 'CASE-E', title: 'Relay rotation', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }]
  })
  assert.equal(seeds.length, 2)
  assert.equal(seeds[0].taskId, 'w7')
  assert.equal(seeds[0].options.length, 0)
  assert.equal(seeds[1].taskId, 'case-e')
  assert.equal(seeds[1].options.length, 2)
})

test('computeEvidenceFingerprint is deterministic and reconcileStaleDiscoveredTasks archives stale disc-* tasks', () => {
  const fp1 = computeEvidenceFingerprint({ source: 'git_diff', summary: 'dirty 2 files', headSha: 'abc1234' })
  const fp2 = computeEvidenceFingerprint({ source: 'git_diff', summary: 'dirty 2 files', headSha: 'abc1234' })
  assert.equal(fp1, fp2)
  assert.equal(fp1.length, 16)

  const root = mkdtempSync(join(tmpdir(), 'disc-reconcile-'))
  try {
    const qDir = join(root, 'active')
    const aDir = join(root, 'archive')
    execFileSync('mkdir', ['-p', qDir])
    writeFileSync(join(qDir, 'disc-dirty-tracked.json'), JSON.stringify({ taskId: 'disc-dirty-tracked', state: 'parked', priority: 'P1', jobs: [] }))
    writeFileSync(join(qDir, 'disc-todo-1.json'), JSON.stringify({ taskId: 'disc-todo-1', state: 'building', priority: 'P2', jobs: [] }))
    const res = reconcileStaleDiscoveredTasks(qDir, [], { apply: true })
    assert.deepEqual(res.expired, ['disc-dirty-tracked'])
    assert.equal(existsSync(join(qDir, 'disc-dirty-tracked.json')), false)
    assert.equal(existsSync(join(aDir, 'disc-dirty-tracked.json')), true)
    assert.equal(existsSync(join(qDir, 'disc-todo-1.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildRelayPlan enforces round-robin parent promotion and sibling demotion ring across 4 windows', () => {
  const plan = buildRelayPlan({
    mode: 'discover',
    siblings: ['hermes', 'direct', 'opencode'],
    windows: 4,
    softWindowSec: 300,
    reportDir: '/tmp/relay-ring'
  })
  // Window 1: sibling1 (hermes), no parent yet, promoted to parent1
  assert.equal(plan.assignments[0].siblingSlot, 'sibling1')
  assert.equal(plan.assignments[0].parentSlot, null)
  assert.equal(plan.assignments[0].promotedToParentSlot, 'parent1')
  assert.equal(plan.assignments[0].demotedFromParentSlot, null)

  // Window 2: sibling2 (direct), parent is parent1 (hermes), promoted to parent2
  assert.equal(plan.assignments[1].siblingSlot, 'sibling2')
  assert.equal(plan.assignments[1].parentSlot, 'parent1')
  assert.equal(plan.assignments[1].parentSibling, 'hermes')
  assert.equal(plan.assignments[1].promotedToParentSlot, 'parent2')

  // Window 3: sibling3 (opencode), parent is parent2 (direct), promoted to parent3
  assert.equal(plan.assignments[2].siblingSlot, 'sibling3')
  assert.equal(plan.assignments[2].parentSlot, 'parent2')
  assert.equal(plan.assignments[2].parentSibling, 'direct')
  assert.equal(plan.assignments[2].promotedToParentSlot, 'parent3')

  // Window 4 (wrap-around): parent1 demoted back to sibling1 (hermes), while parent3 (opencode) is its parent
  assert.equal(plan.assignments[3].siblingSlot, 'sibling1')
  assert.equal(plan.assignments[3].demotedFromParentSlot, 'parent1')
  assert.equal(plan.assignments[3].parentSlot, 'parent3')
  assert.equal(plan.assignments[3].parentSibling, 'opencode')
})

test('buildRelayPlan alternates hermes -> opencode -> hermes with noHardKill: true', () => {
  const plan = buildRelayPlan({
    mode: 'discover',
    siblings: ['hermes', 'opencode'],
    windows: 3,
    softWindowSec: 300,
    reportDir: '/tmp/relay-test'
  })
  assert.equal(plan.mode, 'discover')
  assert.equal(plan.noHardKill, true)
  assert.equal(plan.hardKill, false)
  assert.equal(plan.assignments.length, 3)
  assert.deepEqual(
    plan.assignments.map((a) => a.sibling),
    ['hermes', 'opencode', 'hermes']
  )
  assert.ok(plan.assignments[0].reportPath.endsWith('relay-discover-w1-hermes.json'))
  assert.ok(plan.assignments[0].findingsPath.endsWith('relay-discover-w1-hermes-findings.json'))
  assert.ok(plan.assignments[1].reportPath.endsWith('relay-discover-w2-opencode.json'))
  assert.ok(plan.assignments[2].reportPath.endsWith('relay-discover-w3-hermes.json'))
})

test('swarm-relay.mjs --dry-run --json exits 0 with relay-plan/v1', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const out = execFileSync(process.execPath, [scriptPath, '--dry-run', '--json'], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  const plan = parsed.plan || parsed
  assert.equal(plan.version, 'relay-plan/v1')
  assert.equal(plan.noHardKill, true)
  assert.equal(plan.assignments.length, 3)
})

test('relay rounds and assignments: round wraps at K and carries model/pool', () => {
  const plan = buildRelayPlan({ preset: 'tier1-ring', windows: 4, rounds: 2, modelMap: { hermes: 'm/hermes' }, reportDir: '/tmp/relay-rounds' })
  assert.equal(plan.rounds, 2)
  assert.equal(plan.modelMap.hermes, 'm/hermes')
  assert.equal(plan.assignments[0].model, 'm/hermes')
  assert.equal(plan.assignments[0].pool, 'nous-hermes-free')

  const first = buildAssignment({ list: plan.siblings, index: 0, dir: plan.reportDir, planMode: 'discover', softSec: 300, models: plan.modelMap })
  assert.equal(first.round, 1)
  const wrapped = buildAssignment({ list: plan.siblings, index: 4, dir: plan.reportDir, planMode: 'discover', softSec: 300, models: plan.modelMap })
  assert.equal(wrapped.round, 2)
  assert.equal(wrapped.window, 5)
  assert.equal(wrapped.demotedFromParentSlot, 'parent1')
  assert.equal(wrapped.parentSlot, 'parent4')
  assert.equal(plan.assignments.length, 8)
})

test('model map parsing and per-sibling --model wiring', () => {
  assert.deepEqual(parseModelMap('hermes=a/b,direct=c/d'), { hermes: 'a/b', direct: 'c/d' })
  assert.deepEqual(parseModelMap('{"hermes":"a/b"}'), { hermes: 'a/b' })
  assert.throws(() => parseModelMap('hermes'), /model_map_pair_invalid/)

  const withModel = buildSiblingCommand('hermes', { prompt: 'hi', model: 'm/x' })
  assert.deepEqual(withModel.args, ['-z', '--model', 'm/x', 'hi'])
  const agyWithModel = buildSiblingCommand('agy', { prompt: 'hi', model: 'm/y' })
  assert.deepEqual(agyWithModel.args, ['-p', '--model', 'm/y', 'hi'])
  const geminiWithModel = buildSiblingCommand('gemini-api', { prompt: 'hi', model: 'm/z' })
  assert.deepEqual(geminiWithModel.args, ['generate', '--model', 'm/z', 'hi'])
  const directNoFlag = buildSiblingCommand('direct', { prompt: 'hi', model: 'm/z' })
  assert.equal(directNoFlag.args.includes('--model'), false)
})

test('sibling prompt carries the cooperative deadline and parent-scoped query', () => {
  const prompt = buildSiblingPrompt({
    mode: 'discover', window: 2, windows: 4, sibling: 'direct', siblingSlot: 'sibling2',
    promotedToParentSlot: 'parent2', parentSibling: 'hermes', parentSlot: 'parent1',
    parentFindingsPath: '/tmp/p1.json', softWindowSec: 300, reportPath: '/tmp/w2.json',
    deadlineIso: '2026-11-23T10:05:00.000Z'
  })
  assert.match(prompt, /Window deadline 2026-11-23T10:05:00\.000Z/)
  assert.match(prompt, /swarm ask --parent-slot parent1 <question>/)
  assert.match(prompt, /promoted to parent2/)
  assert.doesNotMatch(prompt, /SIGTERM/)
})

test('ring ledger round-trips through protectedWriteFile and resolves parent slots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-state-'))
  try {
    assert.equal(readRingState(dir), null)
    let state = createRingState({ siblings: ['hermes', 'direct', 'gemini-api', 'opencode'], mode: 'discover', nowIso: '2026-11-23T10:00:00.000Z' })
    state = advanceRingState(state, {
      window: 1, sibling: 'hermes', siblingSlot: 'sibling1',
      promotedToParentSlot: 'parent1', demotedFromParentSlot: null, parentSlot: null
    }, { model: 'm/1', pool: 'nous-hermes-free', findingsPath: '/tmp/w1-hermes-findings.json' }, { nowIso: '2026-11-23T10:01:00.000Z' })
    writeRingState(dir, state)
    const loaded = readRingState(dir)
    assert.equal(loaded.schema, 'ring-state/v1')
    assert.equal(loaded.generation, 1)
    assert.equal(loaded.slots.sibling1.role, 'parent')
    assert.equal(loaded.slots.sibling1.promotedAs, 'parent1')
    assert.equal(resolveSlot(loaded, 'parent1').findingsPath, '/tmp/w1-hermes-findings.json')
    assert.equal(resolveSlot(loaded, 'hermes').key, 'sibling1')

    const wrapped = advanceRingState(loaded, {
      window: 5, sibling: 'hermes', siblingSlot: 'sibling1',
      promotedToParentSlot: 'parent1', demotedFromParentSlot: 'parent1', parentSlot: 'parent4'
    }, { model: 'm/2', pool: 'nous-hermes-free', findingsPath: '/tmp/w5-hermes-findings.json' }, { nowIso: '2026-11-23T10:25:00.000Z' })
    assert.equal(wrapped.round, 2)
    assert.equal(wrapped.slots.sibling1.role, 'sibling')
    assert.equal(wrapped.slots.sibling1.parentSlot, 'parent4')
    assert.equal(wrapped.slots.sibling1.promotedAs, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('window status separates ok_no_findings from failure and counts as success', () => {
  assert.equal(resolveWindowStatus({ exitCode: 0, findingsWritten: true }), 'ok')
  assert.equal(resolveWindowStatus({ exitCode: 0, findingsWritten: false }), 'ok_no_findings')
  assert.equal(resolveWindowStatus({ exitCode: 2, findingsWritten: false }), 'failed')
  assert.equal(resolveWindowStatus({ error: { code: 'ENOENT' }, exitCode: null, findingsWritten: false }), 'spawn_error')
  assert.equal(resolveWindowStatus({ stallKilled: true, exitCode: null, findingsWritten: false }), 'stall_killed')

  assert.equal(isSuccessfulWindowStatus('ok'), true)
  assert.equal(isSuccessfulWindowStatus('ok_no_findings'), true)
  assert.equal(isSuccessfulWindowStatus('ok_after_failover'), true)
  assert.equal(isSuccessfulWindowStatus('failed'), false)
  assert.equal(isSuccessfulWindowStatus('deferred_quota'), false)
})

test('execute: sibling exit 0 without a findings artifact records ok_no_findings, never silent ok', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-findings-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const fakeBin = join(root, 'fake-sibling.mjs')
    writeFileSync(fakeBin, [
      'import { writeFileSync, mkdirSync } from "node:fs"',
      'import { dirname } from "node:path"',
      'const prompt = process.argv[process.argv.length - 1] || ""',
      'const m = prompt.match(/(\\/(?:[^\\s"]+)-findings\\.json)/)',
      'if (m && process.env.FAKE_WRITE_FINDINGS === "1") { mkdirSync(dirname(m[1]), { recursive: true }); writeFileSync(m[1], "{}\\n") }',
      'process.exit(0)'
    ].join('\n'))

    const run = (extraEnv) => JSON.parse(execFileSync(
      process.execPath,
      [scriptPath, '--mode', 'discover', '--siblings', 'hermes', '--windows', '1', '--execute', '--report-dir', reports, '--ring-state-dir', ring, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, SWARM_RELAY_HERMES_BIN: `${process.execPath} ${fakeBin}`, ...extraEnv } }
    ))

    const missing = run({})
    assert.equal(missing.ok, true)
    assert.equal(missing.windows.length, 1)
    assert.equal(missing.windows[0].status, 'ok_no_findings')
    assert.equal(missing.windows[0].exitCode, 0)
    assert.equal(missing.windows[0].findingsWritten, false)
    assert.ok(missing.windows[0].findingsPath.endsWith('relay-discover-w1-hermes-findings.json'))

    const written = run({ FAKE_WRITE_FINDINGS: '1' })
    assert.equal(written.ok, true)
    assert.equal(written.windows[0].status, 'ok')
    assert.equal(written.windows[0].findingsWritten, true)
    assert.equal(existsSync(written.windows[0].findingsPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('swarm ask fails closed with exit 1 on missing value or unknown parent-slot, and evaluateResourceGate handles caller aliases without RangeError', async () => {
  const askScript = resolve(new URL('../../../scripts/swarm-ask.mjs', import.meta.url).pathname)
  const relayScript = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const { evaluateResourceGate } = await import('../src/toolchain/dispatch/resource-gate.js')

  // Missing value for --parent-slot must exit non-zero
  assert.throws(() => {
    execFileSync(process.execPath, [askScript, '--parent-slot', '--json'], { encoding: 'utf8', stdio: 'pipe' })
  })

  // Missing ring ledger for --parent-slot must exit non-zero
  const emptyDir = mkdtempSync(join(tmpdir(), 'empty-ring-'))
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [askScript, '--parent-slot', 'parent1', '--ring-state-dir', emptyDir, 'what?'], { encoding: 'utf8', stdio: 'pipe' })
    })
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }

  // Bare `swarm relay quota-status` (positional or flag) exits 0 and prints eligible/quotaAdmitted
  const qsOut = execFileSync(process.execPath, [relayScript, 'quota-status'], { encoding: 'utf8' })
  assert.match(qsOut, /agy-gemini: eligible=false quotaAdmitted=true conserve=true/)
  assert.match(qsOut, /agy-claude-gpt: eligible=false quotaAdmitted=false conserve=true/)

  // Regression for Hermes's RangeError repro when evaluateResourceGate defers without explicit `nowMs`
  const gateRes = evaluateResourceGate({
    telemetry: { freeMemoryMb: 1, loadAvg1: 0, cpuCount: 8 },
    activeCount: 0,
    now: new Date()
  })
  assert.equal(gateRes.verdict, 'deferred')
  assert.ok(typeof gateRes.nextEligibleAt === 'string' && gateRes.nextEligibleAt.length > 0)
})

test('swarm-relay --quota-aware --write-plan persists a 0600 schedule artifact inside the state root', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'))
  try {
    const out = execFileSync(process.execPath, [scriptPath, '--preset', 'k5-pipeline-ring', '--windows', '60', '--window-sec', '300', '--quota-aware', '--write-plan', '--dry-run', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    const parsed = JSON.parse(out)
    assert.equal(parsed.quotaAware, true)
    assert.ok(parsed.schedulePath.startsWith(join(home, '.local/state/curl-ai-bridge')))
    assert.equal(statSync(parsed.schedulePath).mode & 0o777, 0o600)
    const onDisk = JSON.parse(readFileSync(parsed.schedulePath, 'utf8'))
    assert.equal(onDisk.plan.assignments.length, 60)
    // copilot is nominal at rounds 6 and 12; runtime admission caps it to <=1/5h
    assert.equal(onDisk.plan.assignments.filter((a) => a.pool === 'github-copilot').length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('swarm-relay --write-plan rejects paths outside the state root', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'))
  const outside = mkdtempSync(join(tmpdir(), 'relay-out-'))
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [scriptPath, '--preset', 'k5-pipeline-ring', '--windows', '5', '--write-plan', join(outside, 'schedule.json'), '--dry-run', '--json'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HOME: home } })
    }, /--write-plan path outside the state dir/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('swarm-relay dry-run annotates cap-gated copilot windows', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const out = execFileSync(process.execPath, [scriptPath, '--preset', 'k5-pipeline-ring', '--windows', '60', '--window-sec', '300', '--dry-run'], { encoding: 'utf8' })
  assert.match(out, /cap-gated <=1 copilot\/5h/)
})

test('evaluateReviewGate requires artifact ACCEPT + clean deterministic gates + no head drift', () => {
  assert.equal(evaluateReviewGate({ artifactVerdict: 'ACCEPT', detOk: true, headDrift: false }).verdict, 'ACCEPT')
  assert.equal(evaluateReviewGate({ artifactVerdict: 'REJECT', detOk: true, headDrift: false }).reason, 'w4_verdict_reject')
  assert.equal(evaluateReviewGate({ artifactVerdict: 'ACCEPT', detOk: false, detReason: 'unit_tests_failed', headDrift: false }).reason, 'unit_tests_failed')
  assert.equal(evaluateReviewGate({ artifactVerdict: 'ACCEPT', detOk: true, headDrift: true }).reason, 'unexpected_head_advance_before_review')
})

test('Phase 3 horizon math: rolling pool reset pulls the deadline earlier; drift tightens the window budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-'))
  try {
    const start = Date.now()
    const fiveHours = 5 * 60 * 60 * 1000
    assert.equal(computeHorizonDeadlineMs({ relayStartMs: start }), start + fiveHours)

    const ledger = join(dir, 'pool-calls-5h.jsonl')
    writeFileSync(ledger, `${JSON.stringify({ atMs: start - 60 * 60 * 1000 })}\n`)
    assert.equal(computeHorizonDeadlineMs({ relayStartMs: start, ledgerPath: ledger }), start - 60 * 60 * 1000 + fiveHours)

    writeFileSync(ledger, '{oops\n')
    assert.equal(computeHorizonDeadlineMs({ relayStartMs: start, ledgerPath: ledger }), start + fiveHours)

    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 0, minSubTurnSec: 30 }), 300000)
    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 60000, minSubTurnSec: 30 }), 240000)
    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 400000, minSubTurnSec: 30 }), 30000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

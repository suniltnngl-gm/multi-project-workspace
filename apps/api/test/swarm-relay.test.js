import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildRelayPlan, buildSiblingCommand, buildAssignment, buildSiblingPrompt, parseModelMap, resolveWindowStatus, isSuccessfulWindowStatus, w5CleanupReportPath, headDriftReason, installForbidCommitHook, removeForbidCommitHook, evaluateReviewGate, reviewGateReason, computeHorizonDeadlineMs, effectiveWindowBudgetMs, parseSiblingVerdict, buildReviewBrief, pickFocusedTest, buildBuildBrief, applyPublishGate, roundBaseSha, resolveNextTaskId, advanceTaskAfterCheckpoint, classifyFailure, classifyFailureTail, runChild } from '../../../scripts/swarm-relay.mjs'
import { computeEvidenceFingerprint, reconcileStaleDiscoveredTasks, parseSeedPayload, discoverSplitBrainChecks, scanWorkspaceIndex, discoverExternalRoots } from '../../../scripts/swarm-discover.mjs'
import { scanExternalProjects, scanSplitBrainHazards } from '../../../apps/api/src/toolchain/dispatch/split-brain-scanner.js'
import { buildExecutiveBrief } from '../../../scripts/swarm-brief.mjs'
import { evaluateOpenCase } from '../../../scripts/swarm-case-solve.mjs'
import { evaluateDeterministicDiff } from '../../../scripts/swarm-review.mjs'
import { resolveStateRoot, statePaths } from '../../../scripts/swarm-state-paths.mjs'
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

test('buildSiblingCommand wires cline, vibe and codex with measured headless argv (#205)', () => {
  // Shapes verified live on 2026-11-24 (sibling-validation matrix + targeted probes):
  //   cline  -> --cwd <dir> --json --plan           (read-only) / --yolo (write windows)
  //   vibe   -> --workdir <dir> --output json --agent ask -p   (read-only) / --trust (write)
  //   codex  -> exec --sandbox read-only [-m <model>]          (never bare `codex <prompt>`)
  const cwd = '/tmp/relay-wiring'
  const cline = buildSiblingCommand('cline', { prompt: 'hello', cwd })
  assert.equal(cline.command, 'cline')
  assert.deepEqual(cline.args, ['--cwd', cwd, '--json', '--plan', 'hello'])
  const clineWrite = buildSiblingCommand('cline', { prompt: 'hello', cwd, readOnly: false })
  assert.deepEqual(clineWrite.args, ['--cwd', cwd, '--json', '--yolo', 'hello'])

  const vibe = buildSiblingCommand('vibe', { prompt: 'hello', cwd })
  assert.equal(vibe.command, 'vibe')
  assert.deepEqual(vibe.args, ['--workdir', cwd, '--output', 'json', '--agent', 'ask', '-p', 'hello'])
  const vibeWrite = buildSiblingCommand('vibe', { prompt: 'hello', cwd, readOnly: false })
  assert.deepEqual(vibeWrite.args, ['--workdir', cwd, '--output', 'json', '--trust', '-p', 'hello'])

  const codex = buildSiblingCommand('codex', { prompt: 'hello' })
  assert.equal(codex.command, 'codex')
  assert.deepEqual(codex.args, ['exec', '--sandbox', 'read-only', 'hello'])
  const codexModeled = buildSiblingCommand('codex', { prompt: 'hello', model: 'gpt-5-codex' })
  assert.deepEqual(codexModeled.args, ['exec', '--sandbox', 'read-only', '-m', 'gpt-5-codex', 'hello'])
  const codexWrite = buildSiblingCommand('codex', { prompt: 'hello', readOnly: false })
  assert.deepEqual(codexWrite.args, ['exec', 'hello'])

  // llm7 stays unwired: swarm-direct rejects the provider, so the bare fallback is wrong there.
  const unknown = buildSiblingCommand('llm7', { prompt: 'hello' })
  assert.deepEqual(unknown.args, ['hello'])
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
  // #206: filenames carry the run's short id so back-to-back same-round runs cannot collide.
  const stamp = plan.runIdShort
  assert.ok(stamp && stamp.length > 0)
  assert.ok(plan.assignments[0].reportPath.endsWith(`relay-discover-${stamp}-r1-w1-hermes.json`))
  assert.ok(plan.assignments[0].findingsPath.endsWith(`relay-discover-${stamp}-r1-w1-hermes-findings.json`))
  assert.ok(plan.assignments[1].reportPath.endsWith(`relay-discover-${stamp}-r1-w2-opencode.json`))
  assert.ok(plan.assignments[2].reportPath.endsWith(`relay-discover-${stamp}-r2-w3-hermes.json`))
})

test('two plans never share a run stamp, so their artifacts cannot overwrite each other (#206)', () => {
  const a = buildRelayPlan({ mode: 'discover', siblings: ['hermes'], windows: 1, reportDir: '/tmp/relay-a' })
  const b = buildRelayPlan({ mode: 'discover', siblings: ['hermes'], windows: 1, reportDir: '/tmp/relay-b' })
  assert.notEqual(a.runIdShort, b.runIdShort)
  assert.notEqual(a.assignments[0].reportPath, b.assignments[0].reportPath)
  assert.ok(a.summaryReportPath.endsWith(`relay-discover-${a.runIdShort}-summary.json`))
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

test('execute fails closed when another orchestrator holds the lock (#206)', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-lock-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    // The relay takes its lease beside the ring ledger: the --ring-state-dir passed below.
    mkdirSync(ring, { recursive: true })
    const lockPath = join(ring, 'relay-ring.lock.json')
    writeFileSync(lockPath, `${JSON.stringify({
      schema: 'orchestrator-lock/v1',
      holder: 'swarm-relay',
      runId: 'run-other',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresAtMs: Date.now() + 600_000,
      generation: 3
    }, null, 2)}\n`)

    const res = spawnSync(
      process.execPath,
      [scriptPath, '--mode', 'discover', '--siblings', 'hermes', '--windows', '1', '--execute', '--report-dir', reports, '--ring-state-dir', ring, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home } }
    )
    assert.equal(res.status, 1)
    assert.match(String(res.stderr), /orchestrator_lock_held/)
    assert.match(String(res.stderr), /runId=run-other/)
    // The live lease is untouched, and no sibling was spawned.
    assert.equal(existsSync(lockPath), true)
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).generation, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
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
    assert.ok(missing.windows[0].findingsPath.endsWith('r1-w1-hermes-findings.json'))
    assert.match(missing.windows[0].findingsPath, /relay-discover-.+-r1-w1-hermes-findings\.json$/)

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

  // Bare `swarm relay quota-status` exits 0 and keeps AGY pools CONSERVE-excluded.
  // quotaAdmitted tracks 5h caps / weekly exhaustion, so it varies with live quota.
  const qsOut = execFileSync(process.execPath, [relayScript, 'quota-status'], { encoding: 'utf8' })
  assert.match(qsOut, /^swarm relay quota-status/m)
  for (const pool of ['agy-gemini', 'agy-claude-gpt']) {
    const line = qsOut.split(/\r?\n/).find((l) => l.trim().startsWith(`${pool}:`))
    assert.ok(line, `${pool} must be listed`)
    assert.match(line, /eligible=false\b/, `${pool} must be ineligible by default`)
    assert.match(line, /conserve=true\b/, `${pool} must stay CONSERVE-excluded`)
    assert.match(line, /quotaAdmitted=(true|false)\b/, `${pool} must report quota admission`)
  }

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

test('#220: an empty round diff reports no_modified_files, never the passing deterministic reason', () => {
  assert.equal(reviewGateReason({ detReason: 'deterministic_gates_passed', modifiedCount: 0 }), 'no_modified_files')
  assert.equal(reviewGateReason({ detReason: 'deterministic_gates_passed', modifiedCount: 2 }), 'deterministic_gates_passed')
  assert.equal(reviewGateReason({ modifiedCount: 1 }), 'deterministic_gate_failed')
})

test('#278: classifyFailure distinguishes RPM throttling from real sibling failures', () => {
  assert.equal(classifyFailure({ exitCode: 1, stderr: 'Error: 429 RESOURCE_EXHAUSTED, quota exceeded' }), 'rpm_throttled')
  assert.equal(classifyFailure({ exitCode: 1, stderr: 'Too Many Requests: rate limit reached' }), 'rpm_throttled')
  assert.equal(classifyFailure({ exitCode: 1, stderr: '401 UNAUTHENTICATED: invalid api key' }), 'auth_failure')
  assert.equal(classifyFailure({ exitCode: 1, stderr: '503 UNAVAILABLE: connection reset by peer' }), 'transient')
  assert.equal(classifyFailure({ exitCode: 1, stderr: 'panic: unexpected internal state' }), 'real_failure')
  assert.equal(classifyFailure({ exitCode: 1, stderr: '' }), 'real_failure')
  assert.equal(classifyFailure({ exitCode: 0, stderr: '' }), null)
})

test('#278: runChild captures sibling stderr while still streaming it through', async () => {
  const res = await runChild({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("boom-throttle-429\\n"); process.exit(1)'],
    cwd: tmpdir(), env: { ...process.env }, stallKillSec: 10, windowStartMs: Date.now(), echoStdout: false
  })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /boom-throttle-429/)
  assert.equal(classifyFailure({ exitCode: res.status, stderr: res.stderr }), 'rpm_throttled')
})

test('#278: classifyFailureTail truncates stderr to a bounded telemetry snippet', () => {
  const long = 'x'.repeat(5000) + 'RESOURCE_EXHAUSTED'
  const tail = classifyFailureTail({ exitCode: 1, stderr: long })
  assert.ok(tail.length <= 400)
  assert.match(tail, /RESOURCE_EXHAUSTED/)
})

test('#221: W5 cleanup report path is a string, never the plan object', () => {
  assert.equal(w5CleanupReportPath({ assignment: { reportPath: '/tmp/w5.json' }, plan: { mode: 'pipeline' } }), '/tmp/w5.json')
  assert.throws(() => w5CleanupReportPath({ assignment: { reportPath: { mode: 'pipeline' } } }), /w5_cleanup_report_path_required/)
  assert.throws(() => w5CleanupReportPath({}), /w5_cleanup_report_path_required/)
})

test('#222: mid-round head drift emits an explicit reason, not a generic gate reason', () => {
  assert.equal(headDriftReason(), 'head_drift_mid_round')
  assert.equal(reviewGateReason({ detReason: 'deterministic_gates_passed', modifiedCount: 2, headDrift: true }), 'head_drift_mid_round')
  assert.equal(
    evaluateReviewGate({ artifactVerdict: 'ACCEPT', artifactReason: 'w4_sibling_stdout_accept', detOk: false, detReason: headDriftReason(), headDrift: true }).reason,
    'head_drift_mid_round'
  )
})

test('#232: resolveNextTaskId picks the next eligible in_progress/queued task ordered by priority', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-next-task-'))
  try {
    const db = join(repo, 'apps/api/data/workspace.sqlite')
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, '')
    const conn = new Database(db, { fileMustExist: true })
    conn.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority TEXT);
      INSERT INTO tasks (id, title, status, priority) VALUES (100, 'current', 'in_progress', 'P2');
      INSERT INTO tasks (id, title, status, priority) VALUES (101, 'next P1', 'in_progress', 'P1');
      INSERT INTO tasks (id, title, status, priority) VALUES (102, 'next queued', 'queued', 'P1');
      INSERT INTO tasks (id, title, status, priority) VALUES (103, 'lower', 'in_progress', 'medium');
    `)
    conn.close()
    assert.equal(resolveNextTaskId(100, repo).id, 101)
    assert.equal(resolveNextTaskId(101, repo).id, 103)  // after 101 (in_progress, P1), next is 103 (in_progress, medium)
    assert.equal(resolveNextTaskId(102, repo).id, 103)  // 102 excluded (id must be > 102); only candidate is 103
    assert.equal(resolveNextTaskId(103, repo), null)    // no tasks with id > 103
    assert.equal(resolveNextTaskId(200, repo), null)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('#232: advanceTaskAfterCheckpoint returns the next task id or null when idle', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-advance-'))
  try {
    const db = join(repo, 'apps/api/data/workspace.sqlite')
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, '')
    const conn = new Database(db, { fileMustExist: true })
    conn.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority TEXT);
      INSERT INTO tasks (id, title, status, priority) VALUES (100, 'current', 'in_progress', 'P2');
      INSERT INTO tasks (id, title, status, priority) VALUES (101, 'next', 'in_progress', 'P2');
    `)
    conn.close()
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 100, repoDir: repo }), 101)
    conn.close()
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 100, repoDir: repo }), 101)
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 101, repoDir: repo }), null)
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: null, repoDir: repo }), null)
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 999, repoDir: repo }), null)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('#232: W5 checkpoint_pushed advances the pinned task (via advanceTaskAfterCheckpoint)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-advance-w5-'))
  try {
    const db = join(repo, 'apps/api/data/workspace.sqlite')
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, '')
    const conn = new Database(db, { fileMustExist: true })
    conn.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority TEXT);
      INSERT INTO tasks (id, title, status, priority) VALUES (100, 'current', 'in_progress', 'P2');
      INSERT INTO tasks (id, title, status, priority) VALUES (101, 'next', 'in_progress', 'P2');
    `)
    conn.close()
    // Verify the advancement logic: after checkpoint_pushed for task 100, the next
    // eligible task is 101. The publish gate's job (outside this unit test) records
    // the checkpoint; here we verify the ledger-side advancement.
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 100, repoDir: repo }), 101)
    // No further task: advances to null (clean idle after the last task).
    assert.equal(advanceTaskAfterCheckpoint({ currentTaskId: 101, repoDir: repo }), null)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('#222: forbid-commit hooks install idempotently and never clobber an existing hook', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-forbid-commit-'))
  try {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    assert.equal(installForbidCommitHook(repo), true)
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    assert.equal(existsSync(hook), true)
    assert.match(readFileSync(hook, 'utf8'), /SWARM_FORBID_COMMIT/)
    assert.equal(installForbidCommitHook(repo), false, 'second install must not overwrite')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    installForbidCommitHook(repo)
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n', 'existing hook preserved')
    removeForbidCommitHook(repo)
    assert.equal(existsSync(hook), false)
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'pre-push')), false)
    removeForbidCommitHook(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
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

    // Uncapped $0 pools must not define a reset boundary...
    const capped = new Set(['github-copilot', 'agy-gemini'])
    writeFileSync(ledger, `${JSON.stringify({ quotaPool: 'nous-hermes-free', atMs: start - 60 * 60 * 1000 })}\n`)
    assert.equal(computeHorizonDeadlineMs({ relayStartMs: start, ledgerPath: ledger, cappedPools: capped }), start + fiveHours)
    // ...but capped pools (copilot / agy) do.
    writeFileSync(ledger, `${JSON.stringify({ quotaPool: 'github-copilot', atMs: start - 60 * 60 * 1000 })}\n`)
    assert.equal(computeHorizonDeadlineMs({ relayStartMs: start, ledgerPath: ledger, cappedPools: capped }), start - 60 * 60 * 1000 + fiveHours)

    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 0, minSubTurnSec: 30 }), 300000)
    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 60000, minSubTurnSec: 30 }), 240000)
    assert.equal(effectiveWindowBudgetMs({ softWindowSec: 300, windowDriftMs: 400000, minSubTurnSec: 30 }), 30000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('per-round artifact filenames and run-scoped ring ledger prevent cross-round collisions', () => {
  const plan = buildRelayPlan({ preset: 'k5-pipeline-ring', windows: 6, rounds: 2, reportDir: '/tmp/relay-roundnames' })
  const r1w1 = plan.assignments[0]
  const r2w6 = plan.assignments[5]
  assert.match(r1w1.findingsPath, /-r1-w1-/)
  assert.match(r2w6.findingsPath, /-r2-w6-/)
  assert.notEqual(r1w1.findingsPath, r2w6.findingsPath)

  const st = createRingState({ siblings: ['hermes', 'direct'], mode: 'pipeline', runId: 'run-abc' })
  assert.equal(st.runId, 'run-abc')
  assert.equal(st.generation, 0)
  assert.deepEqual(Object.keys(st.slots), ['sibling1', 'sibling2'])
})

test('W4 verdict recovery: stdout parser ignores fake tool JSON, gate falls back deterministically', () => {
  // Single-shot review CLIs print literal tool-call JSON; only an explicit line counts.
  const noisy = [
    '{"tool":"read_file","args":{"path":"/tmp/parent-findings.json"}}',
    'I cannot access the diff.',
    '{"tool":"protected_write","args":{"path":"/tmp/v.json","content":"VERDICT: ACCEPT"}}',
    'VERDICT: ACCEPT reason=w4_sibling_stdout_accept'
  ].join('\n')
  assert.equal(parseSiblingVerdict(noisy), 'ACCEPT')
  assert.equal(parseSiblingVerdict('{"tool":"protected_write","args":{"content":"VERDICT: REJECT"}}'), null)
  assert.equal(parseSiblingVerdict('no verdict here'), null)

  const dir = mkdtempSync(join(tmpdir(), 'relay-brief-'))
  try {
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'parent-findings.json'), JSON.stringify({ prioritized_work: [{ title: 'N1 open' }] }))

    const brief = buildReviewBrief({
      repoDir: dir,
      baseSha: 'HEAD',
      parentFindingsPath: join(dir, 'parent-findings.json'),
      det: { ok: true }
    })
    assert.match(brief, /## Round diff/)
    assert.match(brief, /changed/)
    assert.match(brief, /N1 open/)
    assert.match(brief, /## Deterministic gates/)
    assert.ok(brief.length <= 12000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  assert.equal(pickFocusedTest(['apps/api/test/x.test.js', 'scripts/y.mjs']), 'apps/api/test/x.test.js')
  assert.equal(pickFocusedTest(['scripts/y.mjs']), null)

  // Fail-closed fallback rules.
  assert.deepEqual(
    evaluateReviewGate({ artifactVerdict: null, detOk: true, deterministicOnly: true }),
    { verdict: 'ACCEPT', reason: 'deterministic_only_no_sibling_artifact' }
  )
  assert.deepEqual(
    evaluateReviewGate({ artifactVerdict: null, detOk: false, detReason: 'unrecoverable_pattern', deterministicOnly: true }),
    { verdict: 'REJECT', reason: 'unrecoverable_pattern' }
  )
  assert.deepEqual(
    evaluateReviewGate({ artifactVerdict: 'ACCEPT', detOk: false, detReason: 'tests_failed', deterministicOnly: true }),
    { verdict: 'REJECT', reason: 'tests_failed' }
  )
  assert.deepEqual(
    evaluateReviewGate({ artifactVerdict: 'ACCEPT', detOk: true, headDrift: true, deterministicOnly: true }),
    { verdict: 'REJECT', reason: 'unexpected_head_advance_before_review' }
  )
  assert.deepEqual(
    evaluateReviewGate({ artifactVerdict: 'ACCEPT', artifactReason: 'w4_sibling_stdout_accept', detOk: true, deterministicOnly: false }),
    { verdict: 'ACCEPT', reason: 'w4_sibling_stdout_accept' }
  )
})

test('W3 build brief pins the requested board task and is injected into the build prompt', () => {
  // #278: self-seed two in_progress tasks in an isolated board instead of
  // depending on live board state (a reconcile to zero in_progress broke this).
  const workspaceCli = resolve(fileURLToPath(new URL('../../../workspace', import.meta.url)))
  const dbPath = join(mkdtempSync(join(tmpdir(), 'relay-pin-')), 'board.sqlite')
  const seedEnv = { ...process.env, DATABASE_PATH: dbPath }
  const seededIds = ['pin-test-a', 'pin-test-b'].map((title) => {
    const out = spawnSync(workspaceCli, ['task', 'create', title], { encoding: 'utf8', env: seedEnv, timeout: 15000 })
    return String(JSON.parse(String(out.stdout).trim()).id)
  })

  try {
    const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
    const prevDbPath = process.env.DATABASE_PATH
    process.env.DATABASE_PATH = dbPath
    let all
    try {
      all = buildBuildBrief({ repoDir: repoRoot })
    } finally {
      if (prevDbPath === undefined) delete process.env.DATABASE_PATH
      else process.env.DATABASE_PATH = prevDbPath
    }
    assert.match(all, /## Board target\(s\)/)
    assert.ok(all.length <= 5000)

    const listed = [...all.matchAll(/^#(\d+) /gm)].map((m) => m[1])
    assert.ok(listed.length >= 2, `need >=2 in-progress board targets to prove pinning, got ${listed.length}`)
    const pinnedId = listed[0]
    const otherId = listed.find((id) => id !== pinnedId)

    let pinned
    try {
      process.env.DATABASE_PATH = dbPath
      pinned = buildBuildBrief({ repoDir: repoRoot, taskId: pinnedId })
    } finally {
      if (prevDbPath === undefined) delete process.env.DATABASE_PATH
      else process.env.DATABASE_PATH = prevDbPath
    }
    assert.ok(pinned.includes(`#${pinnedId} `), `pinned task #${pinnedId} missing from brief`)
    assert.ok(!pinned.includes(`#${otherId} `), `unpinned task #${otherId} leaked into a pinned brief`)

    const prompt = buildSiblingPrompt({
      mode: 'pipeline',
      job: 'build',
      window: 3,
      windows: 5,
      sibling: 'hermes',
      reportPath: '/tmp/relay-build-findings.json',
      buildBrief: pinned
    })
    assert.match(prompt, new RegExp(`#${pinnedId} `))
    assert.match(prompt, /smallest verified fix set/)
  } finally {
    for (const id of seededIds) {
      spawnSync(workspaceCli, ['task', 'done', id, '--notes', 'pin-test cleanup'], { env: seedEnv, timeout: 15000 })
    }
  }
})

// --- gemini-api 1-hop model rotation (#203) ------------------------------------------

function writeFakeGeminiApi(binPath) {
  writeFileSync(binPath, [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"',
    'import { dirname } from "node:path"',
    'const args = process.argv.slice(2)',
    'const mi = args.indexOf("--model")',
    'const model = mi >= 0 ? args[mi + 1] : null',
    'appendFileSync(process.env.FAKE_GEMINI_LOG, `${JSON.stringify({ model })}\\n`)',
    'const mode = process.env.FAKE_GEMINI_MODE || "ok"',
    'const fail = mode === "fail_always" || (mode === "fail_primary_only" && model === process.env.FAKE_GEMINI_PRIMARY)',
    'if (!fail && process.env.FAKE_WRITE_FINDINGS === "1") {',
    '  const prompt = args[args.length - 1] || ""',
    '  const m = prompt.match(/(\\/([^\\s"]+)-findings\\.json)/)',
    '  if (m) { mkdirSync(dirname(m[1]), { recursive: true }); writeFileSync(m[1], "{}\\n") }',
    '}',
    'process.exit(fail ? 1 : 0)'
  ].join('\n'))
}

function writeFakeHermes(binPath) {
  writeFileSync(binPath, [
    'import { mkdirSync, writeFileSync } from "node:fs"',
    'import { dirname } from "node:path"',
    'const prompt = process.argv[process.argv.length - 1] || ""',
    'if (process.env.FAKE_WRITE_FINDINGS === "1") {',
    '  const m = prompt.match(/(\\/([^\\s"]+)-findings\\.json)/)',
    '  if (m) { mkdirSync(dirname(m[1]), { recursive: true }); writeFileSync(m[1], "{}\\\\n") }',
    '}',
    'process.exit(0)'
  ].join('\n'))
}

function readLedgerRows(home) {
  const file = join(home, '.local/state/curl-ai-bridge/overnight/pool-calls-5h.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function runRelayExecute({ scriptPath, home, reports, ring, siblings, windows, extraEnv = {}, quotaStatus = null }) {
  const args = [
    '--mode', 'discover',
    '--siblings', siblings.join(','),
    '--windows', String(windows),
    '--execute',
    '--report-dir', reports,
    '--ring-state-dir', ring,
    '--json'
  ]
  if (quotaStatus) args.push('--quota-status', quotaStatus)
  return JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv }
  }))
}

test('execute: gemini-api primary failure retries exactly one rotated alternate and records telemetry in report + ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-gemini-retry-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const geminiBin = join(root, 'fake-gemini.mjs')
    const hermesBin = join(root, 'fake-hermes.mjs')
    writeFakeGeminiApi(geminiBin)
    writeFakeHermes(hermesBin)
    const log = join(root, 'gemini-calls.jsonl')
    const quota = join(root, 'quota.json')
    writeFileSync(quota, JSON.stringify({ pools: {}, conservePools: [] }))

    const out = runRelayExecute({
      scriptPath, home, reports, ring, siblings: ['gemini-api'], windows: 1, quotaStatus: quota,
      extraEnv: {
        SWARM_RELAY_GEMINI_API_BIN: `${process.execPath} ${geminiBin}`,
        SWARM_RELAY_HERMES_BIN: `${process.execPath} ${hermesBin}`,
        FAKE_GEMINI_LOG: log,
        FAKE_GEMINI_MODE: 'fail_primary_only',
        FAKE_GEMINI_PRIMARY: 'gemini-3.8-flash',
        FAKE_WRITE_FINDINGS: '1'
      }
    })

    assert.equal(out.ok, true)
    const w = out.windows[0]
    assert.equal(w.sibling, 'gemini-api')
    assert.equal(w.primaryModel, 'gemini-3.8-flash')
    assert.equal(w.answeredModel, 'gemini-2.5-flash')
    assert.equal(w.status, 'ok_after_model_retry')
    assert.deepEqual(w.attemptedModels.map((a) => a.model), ['gemini-3.8-flash', 'gemini-2.5-flash'])
    assert.equal(w.attemptedModels[0].status, 'exit_1')
    assert.equal(w.attemptedModels[0].exitCode, 1)
    assert.equal(w.attemptedModels[1].status, 'ok')

    // Exactly two gemini-api calls (primary + one alternate); no hermes failover.
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(calls.map((c) => c.model), ['gemini-3.8-flash', 'gemini-2.5-flash'])

    // Ledger: one row per real CLI call, cumulative telemetry on each row.
    const ledger = readLedgerRows(home)
    assert.equal(ledger.length, 2)
    assert.equal(ledger[0].quotaPool, 'gemini-api-key')
    assert.equal(ledger[0].status, 'exit_1')
    assert.equal(ledger[0].primaryModel, 'gemini-3.8-flash')
    assert.equal(ledger[0].answeredModel, null)
    assert.equal(ledger[0].attemptedModels.length, 1)
    assert.equal(ledger[1].status, 'ok')
    assert.equal(ledger[1].answeredModel, 'gemini-2.5-flash')
    assert.equal(ledger[1].attemptedModels.length, 2)

    // Window report carries the same telemetry (#206: report names are run-stamped).
    const reportName = readdirSync(reports).find((f) => /^relay-discover-.+-r1-w1-gemini-api\.json$/.test(f))
    assert.ok(reportName, 'run-stamped gemini-api window report not found')
    const report = JSON.parse(readFileSync(join(reports, reportName), 'utf8'))
    assert.equal(report.primaryModel, 'gemini-3.8-flash')
    assert.equal(report.answeredModel, 'gemini-2.5-flash')
    assert.equal(report.attemptedModels.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('execute: gemini-api primary + alternate both failing fails over to hermes without a dead window', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-gemini-failover-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const geminiBin = join(root, 'fake-gemini.mjs')
    const hermesBin = join(root, 'fake-hermes.mjs')
    writeFakeGeminiApi(geminiBin)
    writeFakeHermes(hermesBin)
    const log = join(root, 'gemini-calls.jsonl')
    const quota = join(root, 'quota.json')
    writeFileSync(quota, JSON.stringify({ pools: {}, conservePools: [] }))

    const out = runRelayExecute({
      scriptPath, home, reports, ring, siblings: ['gemini-api'], windows: 1, quotaStatus: quota,
      extraEnv: {
        SWARM_RELAY_GEMINI_API_BIN: `${process.execPath} ${geminiBin}`,
        SWARM_RELAY_HERMES_BIN: `${process.execPath} ${hermesBin}`,
        FAKE_GEMINI_LOG: log,
        FAKE_GEMINI_MODE: 'fail_always',
        FAKE_WRITE_FINDINGS: '1'
      }
    })

    // Window is not dead: hermes answers, the run completes successfully.
    assert.equal(out.ok, true)
    assert.equal(out.stopReason, 'completed')
    const w = out.windows[0]
    assert.equal(w.status, 'ok_after_failover')
    assert.equal(w.failover.fallbackSibling, 'hermes')
    assert.equal(w.failover.status, 'ok')
    assert.equal(w.answeredModel, null)
    assert.deepEqual(w.attemptedModels.map((a) => a.model), ['gemini-3.8-flash', 'gemini-2.5-flash'])
    assert.equal(w.attemptedModels[0].status, 'exit_1')
    assert.equal(w.attemptedModels[1].status, 'exit_1')

    const ledger = readLedgerRows(home)
    assert.equal(ledger.length, 3)
    assert.equal(ledger[0].quotaPool, 'gemini-api-key')
    assert.equal(ledger[0].status, 'exit_1')
    assert.equal(ledger[1].quotaPool, 'gemini-api-key')
    assert.equal(ledger[1].status, 'exit_1')
    assert.equal(ledger[1].primaryModel, 'gemini-3.8-flash')
    assert.equal(ledger[1].answeredModel, null)
    assert.equal(ledger[2].quotaPool, 'nous-hermes-free')
    assert.equal(ledger[2].status, 'ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('execute: gemini-api rotation continues across relay restarts instead of piling onto model #1', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-gemini-restart-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const geminiBin = join(root, 'fake-gemini.mjs')
    writeFakeGeminiApi(geminiBin)
    const log = join(root, 'gemini-calls.jsonl')
    const quota = join(root, 'quota.json')
    writeFileSync(quota, JSON.stringify({ pools: {}, conservePools: [] }))
    const env = {
      SWARM_RELAY_GEMINI_API_BIN: `${process.execPath} ${geminiBin}`,
      FAKE_GEMINI_LOG: log,
      FAKE_GEMINI_MODE: 'ok',
      FAKE_WRITE_FINDINGS: '1'
    }

    // Run A (fresh rotation state): primaries #0 and #1.
    const runA = runRelayExecute({ scriptPath, home, reports, ring, siblings: ['gemini-api'], windows: 2, extraEnv: env, quotaStatus: quota })
    assert.deepEqual(runA.windows.map((w) => w.primaryModel), ['gemini-3.8-flash', 'gemini-2.5-flash'])

    // Run B is a separate process reading the same durable rotation state: #2 and #3.
    const runB = runRelayExecute({ scriptPath, home, reports, ring, siblings: ['gemini-api'], windows: 2, extraEnv: env, quotaStatus: quota })
    assert.deepEqual(runB.windows.map((w) => w.primaryModel), ['gemini-3.5-flash-lite', 'gemma-4-31b-it'])
    assert.deepEqual(runB.windows.map((w) => w.answeredModel), ['gemini-3.5-flash-lite', 'gemma-4-31b-it'])

    const rotation = JSON.parse(readFileSync(join(home, '.local/state/curl-ai-bridge/overnight/gemini-model-rotation.json'), 'utf8'))
    assert.equal(rotation.counter, 4)

    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(calls.map((c) => c.model), [
      'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b-it'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('execute: CONSERVE admission substitutes deterministically while admitted gemini-api windows still rotate', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-gemini-conserve-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  try {
    const home = join(root, 'home')
    const reports = join(root, 'reports')
    const ring = join(root, 'ring')
    mkdirSync(home, { recursive: true })
    const geminiBin = join(root, 'fake-gemini.mjs')
    const hermesBin = join(root, 'fake-hermes.mjs')
    writeFakeGeminiApi(geminiBin)
    writeFakeHermes(hermesBin)
    const quota = join(root, 'quota.json')
    writeFileSync(quota, JSON.stringify({
      pools: {
        'agy-gemini': { weeklyRemainingPct: 60 },
        'nous-hermes-free': { weeklyRemainingPct: 100 },
        'gemini-api-key': { weeklyRemainingPct: 100 }
      },
      conservePools: ['agy-gemini']
    }))
    const env = {
      SWARM_RELAY_GEMINI_API_BIN: `${process.execPath} ${geminiBin}`,
      SWARM_RELAY_HERMES_BIN: `${process.execPath} ${hermesBin}`,
      FAKE_GEMINI_LOG: join(root, 'gemini-calls.jsonl'),
      FAKE_GEMINI_MODE: 'ok',
      FAKE_WRITE_FINDINGS: '1'
    }

    const out = runRelayExecute({
      scriptPath, home, reports, ring,
      siblings: ['hermes', 'agy', 'gemini-api'], windows: 3,
      extraEnv: env, quotaStatus: quota
    })
    // agy is CONSERVE-excluded: W2 substitutes gemini-api, W3 keeps gemini-api.
    assert.deepEqual(out.windows.map((w) => w.sibling), ['hermes', 'gemini-api', 'gemini-api'])
    assert.equal(out.windows[0].model, null)
    // Rotation advances once per admitted gemini-api window, independent of substitution.
    assert.equal(out.windows[1].primaryModel, 'gemini-3.8-flash')
    assert.equal(out.windows[2].primaryModel, 'gemini-2.5-flash')
    assert.deepEqual(out.windows.map((w) => w.answeredModel), [null, 'gemini-3.8-flash', 'gemini-2.5-flash'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- #207 stdout-fallback findings persistence ----------------------------------

function runStdoutSibling({ stdout, extraEnv = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'relay-stdout-'))
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const home = join(root, 'home')
  const reports = join(root, 'reports')
  const ring = join(root, 'ring')
  mkdirSync(home, { recursive: true })
  const fakeBin = join(root, 'fake-stdout.mjs')
  writeFileSync(fakeBin, [
    'const out = process.env.FAKE_STDOUT || ""',
    'process.stdout.write(out)'
  ].join('\n'))
  const res = spawnSync(
    process.execPath,
    [scriptPath, '--mode', 'discover', '--siblings', 'hermes', '--windows', '1', '--execute',
      '--report-dir', reports, '--ring-state-dir', ring, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, SWARM_RELAY_HERMES_BIN: `${process.execPath} ${fakeBin}`, FAKE_STDOUT: stdout, ...extraEnv } }
  )
  return { res, root, reports, home }
}

test('#207 cline/vibe-style JSON stdout is persisted as a normalized finding', () => {
  const { res, root } = runStdoutSibling({
    stdout: JSON.stringify({ headline: 'found two issues', prioritized_work: [{ title: 'A' }, { title: 'B' }], multi_option_cases: [] })
  })
  try {
    const out = JSON.parse(String(res.stdout))
    assert.equal(out.ok, true)
    assert.equal(out.windows[0].status, 'ok')
    assert.equal(out.windows[0].findingsWritten, true)
    assert.equal(out.windows[0].findingsFallback, 'stdout')
    const doc = JSON.parse(readFileSync(out.windows[0].findingsPath, 'utf8'))
    assert.equal(doc.schema, 'relay-findings-normalized/v1')
    assert.equal(doc.format, 'json-envelope')
    assert.equal(doc.findings.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#207 codex-style plain text stdout is captured verbatim', () => {
  const { res, root } = runStdoutSibling({ stdout: '## Findings\n- thing one\n- thing two\n' })
  try {
    const out = JSON.parse(String(res.stdout))
    assert.equal(out.windows[0].status, 'ok')
    assert.equal(out.windows[0].findingsFallback, 'stdout')
    const doc = JSON.parse(readFileSync(out.windows[0].findingsPath, 'utf8'))
    assert.equal(doc.format, 'text')
    assert.match(doc.body, /thing one/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#207 empty stdout stays fail-closed (never disguised as findings)', () => {
  const { res, root } = runStdoutSibling({ stdout: '   \n\t\n' })
  try {
    const out = JSON.parse(String(res.stdout))
    assert.equal(out.windows[0].status, 'ok_no_findings')
    assert.equal(out.windows[0].findingsWritten, false)
    assert.equal(out.windows[0].findingsFallback, 'empty_stdout')
    assert.equal(existsSync(out.windows[0].findingsPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#207 relay report/findings paths resolve through SWARM_STATE_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-state-dir-'))
  const prev = process.env.SWARM_STATE_DIR
  try {
    process.env.SWARM_STATE_DIR = dir
    const plan = buildRelayPlan({ mode: 'discover', siblings: ['hermes'], windows: 1 })
    assert.equal(plan.reportDir, join(dir, 'reports'))
    assert.ok(plan.assignments[0].findingsPath.startsWith(join(dir, 'reports')))
  } finally {
    if (prev === undefined) delete process.env.SWARM_STATE_DIR
    else process.env.SWARM_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#233: relay kill-switch path follows SWARM_STATE_DIR at plan-build time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-killswitch-override-'))
  const prev = process.env.SWARM_STATE_DIR
  try {
    process.env.SWARM_STATE_DIR = dir
    const plan = buildRelayPlan({ preset: 'k5-pipeline-ring', windows: 1, rounds: 1 })
    assert.equal(plan.killSwitchFile, join(dir, 'overnight', 'STOP_SWARM'))
    assert.equal(plan.reportDir, join(dir, 'reports'))
  } finally {
    if (prev === undefined) delete process.env.SWARM_STATE_DIR
    else process.env.SWARM_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('swarm-review state root: SWARM_STATE_DIR takes precedence over SWARM_STATE_ROOT and default', () => {
  const defaultRoot = join(homedir(), '.local', 'state', 'curl-ai-bridge')

  // SWARM_STATE_DIR wins over SWARM_STATE_ROOT
  assert.equal(
    resolveStateRoot({ SWARM_STATE_DIR: '/custom/dir', SWARM_STATE_ROOT: '/legacy/root' }),
    '/custom/dir'
  )
  // SWARM_STATE_ROOT used when SWARM_STATE_DIR is unset
  assert.equal(resolveStateRoot({ SWARM_STATE_ROOT: '/legacy/root' }), '/legacy/root')
  // Default root when neither is set
  assert.equal(resolveStateRoot({}), defaultRoot)
  // statePaths().reportsDir follows the resolved root
  assert.equal(
    statePaths({ SWARM_STATE_DIR: '/custom/dir' }).reportsDir,
    join('/custom/dir', 'reports')
  )
  assert.equal(statePaths({}).reportsDir, join(defaultRoot, 'reports'))
})

// --- SP-009 periodic split-brain discovery + progressive workspace index --------

test('statePaths().workspaceIndexPath resolves under the state root (SWARM_STATE_DIR override)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-index-path-'))
  try {
    assert.equal(
      statePaths({ SWARM_STATE_DIR: dir }).workspaceIndexPath,
      join(dir, 'workspace-index.json')
    )
    assert.equal(
      statePaths({}).workspaceIndexPath,
      join(homedir(), '.local', 'state', 'curl-ai-bridge', 'workspace-index.json')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discoverSplitBrainChecks delegates to canonical scanSplitBrainHazards (sole authority)', () => {
  const root = mkdtempSync(join(tmpdir(), 'splitbrain-delegate-'))
  try {
    mkdirSync(join(root, 'relay'), { recursive: true })
    mkdirSync(join(root, 'queue', 'cases'), { recursive: true })
    writeFileSync(join(root, 'relay', 'ring-state.json'), JSON.stringify({
      schema: 'ring-state/v1',
      slots: {
        sibling1: { role: 'parent', path: '/home/sunilkr/.local/state/curl-ai-bridge/relay' },
        sibling2: { role: 'parent' }
      }
    }))
    writeFileSync(join(root, 'relay', 'orchestrator.lock.json'), JSON.stringify({
      schema: 'orchestrator-lock/v1', holder: 'dead-holder', expiresAtMs: 1000
    }))
    writeFileSync(join(root, 'queue', 'cases', 'legacy.json'), '{}')
    const nowMs = Date.now()
    const env = { ...process.env, SWARM_STATE_DIR: root }
    const canonical = scanSplitBrainHazards({ env, nowMs })
    const before = readdirSync(join(root, 'relay')).sort().join('|')
    const res = discoverSplitBrainChecks({ env, stateRoot: root, nowMs })

    assert.equal(res.ok, canonical.ok)
    assert.equal(res.checkCount, 3)
    assert.equal(res.findingCount, canonical.hazardCount)
    assert.deepEqual(res.hazards, canonical.hazards)
    assert.deepEqual(res.findings.map((f) => f.kind), canonical.hazards.map((h) => h.id))
    // Only the canonical three hazards exist; the removed inline-path check is gone.
    assert.equal(res.findings.some((f) => f.kind === 'inline_state_paths'), false)
    assert.equal(readdirSync(join(root, 'relay')).sort().join('|'), before, 'hazard scan must stay read-only')

    const healthy = mkdtempSync(join(tmpdir(), 'splitbrain-healthy-'))
    try {
      const clean = discoverSplitBrainChecks({ stateRoot: healthy, nowMs })
      assert.equal(clean.findingCount, 0)
      assert.deepEqual(clean.findings, [])
    } finally {
      rmSync(healthy, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanWorkspaceIndex delegates to the canonical progressive indexer and persists only on apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-index-delegate-'))
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'a.txt'), 'alpha\n')
    writeFileSync(join(repo, 'b.txt'), 'beta\n')
    const indexPath = join(root, 'workspace-index.json')

    const dry = scanWorkspaceIndex({ roots: [{ path: repo, readOnly: true }], indexPath, apply: false })
    assert.equal(dry.changed, true)
    assert.equal(dry.fileCount, 2)
    assert.equal(existsSync(indexPath), false, 'dry-run must not persist the index')

    const applied = scanWorkspaceIndex({ roots: [repo], indexPath, apply: true })
    assert.equal(applied.changed, true)
    const snap = JSON.parse(readFileSync(indexPath, 'utf8'))
    assert.equal(snap.schema, 'workspace-index/v1')
    assert.equal(snap.totalFiles, 2)
    assert.match(snap.files['a.txt'].sha256, /^[0-9a-f]{64}$/, 'canonical sha256 index shape')
    assert.equal(snap.entries, undefined, 'CLI adapter must not write a second index schema')

    const again = scanWorkspaceIndex({ roots: [repo], indexPath, apply: true })
    assert.equal(again.changed, false)
    assert.equal(again.cacheHits, 2)

    writeFileSync(join(repo, 'a.txt'), 'alpha-changed\n')
    const edited = scanWorkspaceIndex({ roots: [repo], indexPath, apply: true })
    assert.equal(edited.changed, true)
    assert.equal(edited.hashed, 1)
    const after = JSON.parse(readFileSync(indexPath, 'utf8'))
    assert.notEqual(after.files['a.txt'].sha256, snap.files['a.txt'].sha256)

    rmSync(join(repo, 'b.txt'))
    const removed = scanWorkspaceIndex({ roots: [repo], indexPath, apply: false })
    assert.equal(removed.changed, true)
    assert.equal(removed.fileCount, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discoverExternalRoots delegates to the canonical 4-bucket classifier, read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'external-root-delegate-'))
  try {
    const ext = join(root, 'projects')
    mkdirSync(join(ext, 'repo-a'), { recursive: true })
    writeFileSync(join(ext, 'repo-a', 'package.json'), '{"name":"a"}\n')
    writeFileSync(join(ext, 'swarm-note.md'), '# notes\n')
    const before = readdirSync(ext).sort().join('|')
    const canonical = scanExternalProjects(ext)

    const res = discoverExternalRoots({ externalRoots: [{ path: ext, readOnly: true }] })
    assert.equal(res.candidateCount, 1)
    assert.equal(res.inventories.length, 1)
    assert.equal(res.inventories[0].fileCount, 2)
    assert.equal(res.inventories[0].readOnly, true)
    assert.deepEqual(res.inventories[0].buckets, { merge_private: 1, extract_public: 1 })
    assert.deepEqual(canonical.items.map((i) => [i.name, i.bucket]), [
      ['repo-a', 'merge_private'],
      ['swarm-note.md', 'extract_public']
    ])

    const c = res.candidates[0]
    assert.equal(c.readOnly, true)
    assert.equal(c.kind, 'case')
    assert.equal(c.source, 'external_root')
    assert.deepEqual(c.options.map((o) => o.id), ['split', 'merge'])
    assert.match(c.summary, /read-only split\/merge consolidation/)

    assert.equal(readdirSync(ext).sort().join('|'), before, 'external root must stay untouched')
    assert.equal(existsSync(join(ext, 'cases.sqlite')), false)
    assert.equal(existsSync(join(ext, 'repo-a', 'cases.sqlite')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('direct-graphn sibling routes through swarm-direct --provider graphn', () => {
  const cmd = buildSiblingCommand('direct-graphn', { prompt: 'hello' })
  assert.equal(cmd.command, process.execPath)
  assert.ok(cmd.args[0].endsWith('swarm-direct.mjs'))
  assert.equal(cmd.args[cmd.args.indexOf('--provider') + 1], 'graphn')
  assert.equal(cmd.args[cmd.args.indexOf('--prompt') + 1], 'hello')
})

test('#300: progress-aware stall watchdog re-arms on output; silent child still killed', async () => {
  // Chatty child: emits a line every 200ms; with a 0.5s stall bound it must survive 1.2s.
  const chatty = await runChild({
    command: 'node', args: ['-e', 'setInterval(() => console.log("tick"), 200); setTimeout(() => process.exit(0), 1200)'],
    cwd: tmpdir(), env: { ...process.env }, stallKillSec: 0.5, windowStartMs: Date.now(), echoStdout: false
  })
  assert.equal(chatty.stallKilled, false, 'healthy output stream must never be stall-killed')
  assert.equal(chatty.status, 0)
  assert.ok(chatty.stdout.includes('tick'))

  // Silent child: no output at all; killed once the bound elapses.
  const silent = await runChild({
    command: 'node', args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
    cwd: tmpdir(), env: { ...process.env }, stallKillSec: 0.5, windowStartMs: Date.now(), echoStdout: false
  })
  assert.equal(silent.stallKilled, true, 'a true stall must still be killed')
  assert.ok(silent.elapsedMs < 4000, `stall kill must be prompt, took ${silent.elapsedMs}ms`)
})

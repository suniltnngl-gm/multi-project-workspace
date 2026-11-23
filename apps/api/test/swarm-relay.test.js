import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRelayPlan, buildSiblingCommand, buildAssignment, buildSiblingPrompt, parseModelMap } from '../../../scripts/swarm-relay.mjs'
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

test('buildSiblingCommand supports agy, hermes, opencode, and direct as multi-CLI relay participants', () => {
  const agyCmd = buildSiblingCommand('agy', { prompt: 'hello' })
  assert.equal(agyCmd.command, 'agy')
  assert.deepEqual(agyCmd.args, ['-p', 'hello'])
  const hermesCmd = buildSiblingCommand('hermes', { prompt: 'hello' })
  assert.equal(hermesCmd.command, 'hermes')
  assert.deepEqual(hermesCmd.args, ['-z', 'hello'])
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
  const geminiNoFlag = buildSiblingCommand('gemini-api', { prompt: 'hi', model: 'm/z' })
  assert.deepEqual(geminiNoFlag.args, ['prompt', 'hi'])
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

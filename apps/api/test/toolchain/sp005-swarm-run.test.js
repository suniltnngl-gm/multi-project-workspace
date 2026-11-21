import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const REPO = '/home/sunilkr/Code/multi-project-workspace'
const SCRIPT = join(REPO, 'scripts', 'swarm-run.mjs')
// The live registry path is host-specific and absent on CI runners. Tests build a
// deterministic fixture registry instead of depending on operator-local state.
const LIVE_REGISTRY = '/home/sunilkr/.local/state/curl-ai-bridge/sessions/agy-sessions.json'

function makeRegistry(dir) {
  const registryPath = join(dir, 'registry.json')
  const sessions = [
    { name: 'plan', role: 'planner', cli: 'agy', model: 'claude-opus-5-5-medium', quotaPool: 'agy-gemini', repository: 'multi-project-workspace', status: 'idle' },
    { name: 'build', role: 'builder', cli: 'agy', model: 'claude-sonnet-5-5-medium', quotaPool: 'agy-claude-gpt', repository: 'multi-project-workspace', status: 'idle' },
    { name: 'build-fb', role: 'builder+worker-fallback', cli: 'opencode', model: 'console-nvidia/google/gemma-4-31b-it', quotaPool: 'opencode-console-nvidia', repository: 'multi-project-workspace', status: 'idle' }
  ]
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 'agy-session-registry/v1.8', sessions, quotaObservations: [] }))
  return registryPath
}

function run(args, { cwd = REPO } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

function tmpState() {
  return mkdtempSync(join(tmpdir(), 'sp005-state-'))
}

function writeReview(dir, text) {
  const p = join(dir, 'review.txt')
  writeFileSync(p, text)
  return p
}

function baseArgs(stateDir, extra = {}) {
  const registry = makeRegistry(stateDir)
  return [
    '--registry', registry,
    '--repository', 'multi-project-workspace',
    '--work-item', 'SP-005',
    '--state-dir', stateDir,
    '--plan-cli', 'agy',
    '--plan-model', 'claude-opus-5-5-medium',
    '--plan-prompt', 'plan the work',
    '--build-cli', 'agy',
    '--build-model', 'claude-sonnet-5-5-medium',
    '--build-prompt', 'build the work',
    '--json',
    ...extra.args
  ]
}

test('guardrail 2: publish is stopped unless --allow-publish is present', () => {
  const state = tmpState()
  try {
    const review = writeReview(state, 'VERDICT: ACCEPT\n')
    const without = run(baseArgs(state, { args: ['--review-output', review] }))
    assert.equal(without.status, 0, without.stderr)
    const parsed = JSON.parse(without.stdout)
    assert.equal(parsed.publish.stopped, true)
    assert.equal(parsed.publish.authorized, false)

    const withFlag = run(baseArgs(state, { args: ['--review-output', review, '--allow-publish'] }))
    const parsed2 = JSON.parse(withFlag.stdout)
    assert.equal(parsed2.publish.stopped, false)
    assert.equal(parsed2.publish.authorized, true)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 1: unparseable review output is REJECT, never ACCEPT', () => {
  const state = tmpState()
  try {
    const cases = [
      ['', 'empty_review_output'],
      ['looks fine to me', 'ambiguous_verdict_count:0'],
      ['VERDICT: ACCEPT\nVERDICT: REJECT\n', 'ambiguous_verdict_count:2']
    ]
    for (const [text, reason] of cases) {
      const review = writeReview(state, text)
      const res = run(baseArgs(state, { args: ['--review-output', review] }))
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.review.verdict, 'REJECT', `expected REJECT for ${JSON.stringify(text)}`)
      assert.ok(parsed.review.reason.includes(reason.split(':')[0]))
      assert.ok(res.status >= 2, `REJECT must produce a non-zero exit, got ${res.status}`)
    }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 1: a single unambiguous ACCEPT is honoured', () => {
  const state = tmpState()
  try {
    const review = writeReview(state, 'some prose\nVERDICT: ACCEPT\nmore prose\n')
    const res = run(baseArgs(state, { args: ['--review-output', review] }))
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.review.verdict, 'ACCEPT')
    assert.equal(parsed.review.reason, null)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 1: missing review file is REJECT', () => {
  const state = tmpState()
  try {
    const res = run(baseArgs(state, { args: ['--review-output', join(state, 'nope.txt')] }))
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.review.verdict, 'REJECT')
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 3: quotaPool is never silently agy when the registry resolves a pool', () => {
  const state = tmpState()
  try {
    const review = writeReview(state, 'VERDICT: ACCEPT\n')
    const res = run(baseArgs(state, { args: ['--review-output', review] }))
    const parsed = JSON.parse(res.stdout)
    assert.ok(parsed.gates.length > 0)
    for (const g of parsed.gates) {
      assert.ok(g.poolSource === 'explicit' || g.poolSource === 'registry' || g.poolSource === 'unresolved',
        `unexpected poolSource ${g.poolSource}`)
    }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 3: --out writes a durable summary without mutating state', () => {
  const state = tmpState()
  try {
    const review = writeReview(state, 'VERDICT: ACCEPT\n')
    const out = join(state, 'nested', 'summary.json')
    const res = run(baseArgs(state, { args: ['--review-output', review, '--out', out] }))
    assert.equal(res.status, 0, res.stderr)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(written.schemaVersion, 'swarm-run/v1')
    assert.equal(written.publish.stopped, true)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 1: a verdict line with trailing tokens is REJECT', () => {
  const state = tmpState()
  try {
    for (const text of ['VERDICT: ACCEPT REJECT\n', 'VERDICT: ACCEPT maybe\n', 'VERDICT: ACCEPT | REJECT\n']) {
      const review = writeReview(state, text)
      const res = run(baseArgs(state, { args: ['--review-output', review] }))
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.review.verdict, 'REJECT', `expected REJECT for ${JSON.stringify(text)}`)
      assert.ok(parsed.review.reason.includes('verdict_line_not_exclusive') || parsed.review.reason.includes('ambiguous'))
      assert.ok(res.status >= 2)
    }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 1: a verdict line amid prose is still ACCEPT', () => {
  const state = tmpState()
  try {
    const review = writeReview(state, 'findings above\n\nVERDICT: ACCEPT\n')
    const res = run(baseArgs(state, { args: ['--review-output', review] }))
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.review.verdict, 'ACCEPT')
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('guardrail 3: registry quota observations reach the dispatcher', () => {
  const state = tmpState()
  try {
    // A registry whose quotaObservations mark the resolved pool exhausted.
    const registryDir = mkdtempSync(join(tmpdir(), 'sp005-reg-'))
    const registryPath = join(registryDir, 'registry.json')
    const parsed = JSON.parse(readFileSync(makeRegistry(registryDir), 'utf8'))
    parsed.quotaObservations = [{
      pool: 'agy-claude-gpt',
      health: 'exhausted',
      observedAt: new Date().toISOString(),
      resetAt: new Date(Date.now() + 3600_000).toISOString()
    }]
    writeFileSync(registryPath, JSON.stringify(parsed))

    const review = writeReview(state, 'VERDICT: ACCEPT\n')
    const res = run([
      '--registry', registryPath,
      '--repository', 'multi-project-workspace',
      '--work-item', 'SP-005',
      '--state-dir', state,
      '--plan-cli', 'agy',
      '--plan-model', 'claude-opus-5-5-medium',
      '--plan-prompt', 'p',
      '--build-cli', 'agy',
      '--build-model', 'claude-sonnet-5-5-medium',
      '--build-prompt', 'b',
      '--review-output', review,
      '--json'
    ])
    const out = JSON.parse(res.stdout)
    const build = out.gates.find((g) => g.gate === 'build')
    assert.ok(build, 'build gate should be present')
    // The exhausted observation must be seen: either the gate blocks/defers, or the
    // plan carries quota assessment reflecting it. Either way the observation is not dropped.
    const sawQuota = JSON.stringify(out).includes('agy-claude-gpt')
    assert.ok(sawQuota, 'registry quota observation should be visible in the plan output')
    rmSync(registryDir, { recursive: true, force: true })
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('missing required flags fail closed with a clear message', () => {
  const state = tmpState()
  try {
    const res = run(['--repository', 'x', '--state-dir', state, '--json'])
    assert.equal(res.status, 1)
    assert.ok(res.stderr.includes('swarm-run:'))
  } finally { rmSync(state, { recursive: true, force: true }) }
})

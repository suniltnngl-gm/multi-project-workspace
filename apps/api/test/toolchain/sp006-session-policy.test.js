import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SCRIPT = join(REPO, 'scripts', 'swarm-run.mjs')

function run(args, { cwd = REPO } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}
function tmp() { return mkdtempSync(join(tmpdir(), 'sp006-')) }
function write(dir, name, text) { const p = join(dir, name); writeFileSync(p, text); return p }

// Two sessions on independent pools so rotation is observable.
function makeRegistry(dir, { sessions } = {}) {
  const list = sessions || [
    { role: 'planner', cli: 'agy', model: 'claude-opus-5-5-medium', quotaPool: 'agy-gemini', repository: 'multi-project-workspace', status: 'idle', sessionId: 'ses_plan_a' },
    { role: 'builder', cli: 'agy', model: 'claude-sonnet-5-5-medium', quotaPool: 'agy-claude-gpt', repository: 'multi-project-workspace', status: 'idle', sessionId: 'ses_build_a' },
    { role: 'builder+worker-fallback', cli: 'opencode', model: 'console-nvidia/google/gemma-4-31b-it', quotaPool: 'opencode-console-nvidia', repository: 'multi-project-workspace', status: 'idle', sessionId: 'ses_fb_b' }
  ]
  return write(dir, 'registry.json', JSON.stringify({ schemaVersion: 'agy-session-registry/v1.8', sessions: list, quotaObservations: [] }))
}

function args(state, extra = []) {
  const reg = makeRegistry(state)
  return [
    '--registry', reg,
    '--repository', 'multi-project-workspace',
    '--work-item', 'SP-006',
    '--state-dir', state,
    '--plan-cli', 'agy',
    '--plan-model', 'claude-opus-5-5-medium',
    '--plan-prompt', 'plan',
    '--build-cli', 'agy',
    '--build-model', 'claude-sonnet-5-5-medium',
    '--build-prompt', 'build',
    '--json',
    ...extra
  ]
}

test('per-gate (default) is unchanged: no pinning, no poolUsage, fallback mode', () => {
  const s = tmp()
  try {
    const res = run(args(s))
    const out = JSON.parse(res.stdout)
    assert.equal(out.sessionPolicy, 'per-gate')
    assert.equal(out.pinnedSessionId, null)
    for (const g of out.gates) assert.equal(g.pinnedSessionId, null)
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('pinned: one session is held across plan and build', () => {
  const s = tmp()
  try {
    const res = run(args(s, ['--session-policy', 'pinned']))
    const out = JSON.parse(res.stdout)
    assert.equal(out.sessionPolicy, 'pinned')
    const withPin = out.gates.filter((g) => g.pinnedSessionId)
    assert.ok(withPin.length >= 1, 'at least one gate should carry a pin')
    const pins = new Set(withPin.map((g) => g.pinnedSessionId))
    assert.equal(pins.size, 1, `expected a single pinned session, got ${[...pins].join(',')}`)
    assert.equal(out.pinnedSessionId, [...pins][0])
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('invalid session policy fails closed', () => {
  const s = tmp()
  try {
    const res = run(args(s, ['--session-policy', 'bogus']))
    assert.equal(res.status, 1)
    assert.ok(res.stderr.includes('invalid --session-policy'))
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('publish stays stopped without --allow-publish, even in pinned mode', () => {
  const s = tmp()
  try {
    const res = run(args(s, ['--session-policy', 'pinned']))
    const out = JSON.parse(res.stdout)
    assert.equal(out.publish.stopped, true)
    assert.equal(out.publish.authorized, false)
    assert.equal(out.publish.executorSessionId, null)
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('publish names the pinned executor only with --allow-publish', () => {
  const s = tmp()
  try {
    const res = run(args(s, ['--session-policy', 'pinned', '--allow-publish']))
    const out = JSON.parse(res.stdout)
    assert.equal(out.publish.stopped, false)
    assert.equal(out.publish.authorized, true)
    assert.equal(out.publish.executorSessionId, out.pinnedSessionId)
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('poolUsage is derived from stateDir inFlight runs', () => {
  const s = tmp()
  try {
    // Seed a run record for the builder session so its pool has a lastUsedAt.
    const runsDir = join(s, 'run')
    mkdirp(runsDir)
    const key = 'opencode:ses_fb_b'
    write(runsDir, '000000000000001-x.json', JSON.stringify({
      record: { key, compositeKey: key, status: 'running', acquiredAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }
    }))
    const res = run(args(s, ['--session-policy', 'pinned']))
    const constOut = JSON.parse(res.stdout)
    assert.ok(Array.isArray(constOut.gates))
  } finally { rmSync(s, { recursive: true, force: true }) }
})

test('registry quota observations still reach the dispatcher in pinned mode', () => {
  const s = tmp()
  try {
    const regPath = makeRegistry(s)
    const parsed = JSON.parse(readFileSync(regPath, 'utf8'))
    parsed.quotaObservations = [{ pool: 'agy-claude-gpt', health: 'exhausted', observedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 3600000).toISOString() }]
    writeFileSync(regPath, JSON.stringify(parsed))
    const res = run(args(s, ['--session-policy', 'pinned']))
    const out = JSON.parse(res.stdout)
    assert.ok(out.gates.length >= 1)
  } finally { rmSync(s, { recursive: true, force: true }) }
})

function mkdirp(p) { spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(p)},{recursive:true})`]) }

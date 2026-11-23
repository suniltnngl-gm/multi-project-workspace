import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRelayQuotaSummary, formatRelayQuotaDoctor, quotaReasonCode } from '../../../scripts/swarm-doctor-quota.mjs'
import { loadPoolBudgets, readLiveSqliteQuota } from '../../../scripts/swarm-quota-ring.mjs'

// #190: `swarm doctor` must surface the relay's quota admission view without
// duplicating the budget math (it reuses loadPoolBudgets + countPoolCallsInWindow).

test('buildRelayQuotaSummary counts eligible vs CONSERVE pools and emits a greppable headline', () => {
  const statusInfo = {
    ok: true,
    source: 'sqlite',
    quota: {
      'nous-hermes-free': { weeklyRemainingPct: 100 },
      'gemini-api-key': { weeklyRemainingPct: 42 },
      'cloudflare-workers-ai': { weeklyRemainingPct: 100 },
      'agy-gemini': { weeklyRemainingPct: 13 }
    },
    conservePools: ['agy-gemini']
  }
  const budgets = loadPoolBudgets({ quota: statusInfo.quota, conservePools: statusInfo.conservePools })
  const summary = buildRelayQuotaSummary({
    stateDir: '/nonexistent-state',
    statusInfo,
    budgets,
    countCalls: (pool) => (pool === 'gemini-api-key' ? 5 : pool === 'nous-hermes-free' ? 9 : 0)
  })

  assert.equal(summary.schema, 'relay-quota-summary/v1')
  assert.equal(summary.ok, true)
  assert.equal(summary.source, 'sqlite')
  // agy-gemini/argon/claude-gpt are CONSERVE-excluded (not weekly-exhausted here).
  assert.equal(summary.total, 10)
  assert.equal(summary.eligibleCount, 7)
  assert.equal(summary.conserveCount, 3)
  assert.equal(summary.totalCalls, 14)
  assert.match(summary.headline, /^relay_quota: 7\/10 eligible pools \(14 calls\/5h\)$/)
  // Top lanes are eligible and sorted by weekly remaining desc.
  assert.equal(summary.top.length <= 4, true)
  assert.ok(summary.top.every((b) => b.eligible))
  assert.deepEqual(
    summary.pools.filter((p) => !p.eligible).map((p) => `${p.pool}:${p.reasonCode}`).sort(),
    ['agy-argon:conserve', 'agy-claude-gpt:conserve', 'agy-gemini:conserve']
  )
})

test('buildRelayQuotaSummary honours allowConserve and reports cap5h without a live ledger', () => {
  const statusInfo = { ok: true, source: 'sqlite', quota: {}, conservePools: [] }
  const budgets = loadPoolBudgets({ quota: {}, conservePools: [] })
  // Mirror loadPoolBudgets' own cap arithmetic so the injected count agrees.
  for (const b of Object.values(budgets)) {
    if (b.pool === 'agy-gemini') b.callsInWindow = 4
  }
  const summary = buildRelayQuotaSummary({
    stateDir: '/nonexistent-state',
    statusInfo,
    budgets,
    allowConserve: true,
    countCalls: (pool) => (pool === 'agy-gemini' ? 4 : 0)
  })

  assert.equal(summary.allowConserve, true)
  assert.match(summary.headline, /allowConserve/)
  // agy-gemini has a real 4/5h cap -> reasonCode cap5h; uncapped $0 pools stay admitted.
  // Note loadPoolBudgets already computes admitted=true for a conserve pool whose weekly
  // quota is intact, so eligibility (not admission) is what excludes it by default.
  const gemini = summary.pools.find((p) => p.pool === 'agy-gemini')
  const hermes = summary.pools.find((p) => p.pool === 'nous-hermes-free')
  assert.equal(gemini.reasonCode, 'cap5h')
  assert.equal(gemini.eligible, true)
  assert.equal(hermes.quotaAdmitted, true)
  assert.equal(hermes.cap, null)
  assert.equal(quotaReasonCode({ quotaAdmitted: true, conserve: false, callsInWindow: 0 }), 'admitted')
})

test('formatRelayQuotaDoctor renders the summary line and lane lines, or an honest unavailable line', () => {
  const summary = {
    ok: true,
    headline: 'quota: 2/10 eligible pools (3 calls/5h)',
    top: [
      { pool: 'gemini-api-key', eligible: true, conserve: false, callsInWindow: 3, cap: null, weeklyRemainingPct: 42, reasonCode: 'admitted' }
    ]
  }
  assert.deepEqual(formatRelayQuotaDoctor(summary), [
    'quota: 2/10 eligible pools (3 calls/5h)',
    '  gemini-api-key: eligible=true conserve=false calls5h=3/uncapped weekly=42%'
  ])
  assert.deepEqual(formatRelayQuotaDoctor({ ...summary, top: [] }), [
    'quota: 2/10 eligible pools (3 calls/5h)',
    '  (no eligible pool)'
  ])
  assert.deepEqual(formatRelayQuotaDoctor({ ok: false }), ['relay_quota: unavailable (quota store unreadable)'])
})

test('live quota store + doctor summary agrees with `swarm relay quota-status`', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const out = execFileSync(process.execPath, [scriptPath, 'quota-status'], { encoding: 'utf8' })

  const statusInfo = readLiveSqliteQuota()
  assert.equal(statusInfo.ok, true)
  const budgets = loadPoolBudgets({ countCalls: () => 0, quota: statusInfo.quota, conservePools: statusInfo.conservePools })
  const summary = buildRelayQuotaSummary({ stateDir: '/nonexistent-state', statusInfo, budgets })

  // Every pool the relay prints must appear in the doctor summary with the same verdict.
  for (const line of out.split('\n')) {
    const m = line.match(/^\s{2}(\S+): eligible=(\w+) quotaAdmitted=(\w+) conserve=(\w+)/)
    if (!m) continue
    const pool = summary.pools.find((p) => p.pool === m[1])
    assert.ok(pool, `doctor summary missing pool ${m[1]}`)
    assert.equal(String(pool.eligible), m[2], `${m[1]} eligible`)
    assert.equal(String(pool.quotaAdmitted), m[3], `${m[1]} quotaAdmitted`)
    assert.equal(String(pool.conserve), m[4], `${m[1]} conserve`)
  }
})

test('swarm doctor prints a relay quota summary block', () => {
  const cli = resolve(new URL('../../../scripts/swarm-cli.sh', import.meta.url).pathname)
  const home = mkdtempSync(join(tmpdir(), 'doctor-home-'))
  const stateRoot = join(home, '.local/state/curl-ai-bridge')
  try {
    // Minimal registry so `swarm status` (the doctor's first step) can run offline.
    mkdirSync(join(stateRoot, 'sessions'), { recursive: true })
    writeFileSync(join(stateRoot, 'sessions/swarm-sessions.json'), JSON.stringify({ sessions: [] }))
    const out = execFileSync('bash', [cli, 'doctor'], { encoding: 'utf8', cwd: resolve(new URL('../../', import.meta.url).pathname), env: { ...process.env, HOME: home, SWARM_STATE_ROOT: stateRoot }, timeout: 60_000 })
    assert.match(out, /relay_quota:/)
    assert.match(out, /eligible pools \([0-9]+ calls\/5h\)/)
    // The per-lane lines are the doctor's added value over the raw guardrails line.
    assert.match(out, /\n  \S+: eligible=(true|false) conserve=(true|false) calls5h=\d+\/\S+ weekly=\d+%/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

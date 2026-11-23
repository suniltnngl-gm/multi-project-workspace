#!/usr/bin/env node
/**
 * SWARM RELAY — graceful, quota-aware multi-sibling relay runner.
 *
 * Round-robin parent promotion: each sibling works one window, then is promoted to
 * the parent slot for the next sibling; on wrap-around the previous parent is demoted
 * back to a sibling. See scripts/swarm-ring-state.mjs for the durable ledger.
 *
 * Window contract (noHardKill): the relay never installs a routine wall-clock timer.
 * A window is a cooperative budget — the sibling is told the deadline, the relay stops
 * admitting new sub-turns once the budget is spent, and promotion happens at turn exit.
 * Only an explicit `--stall-kill-sec <n>` (default 0 = disabled) interrupts a runaway.
 *
 * Quota-aware slot selection is delegated to scripts/swarm-quota-ring.mjs (pure).
 *
 * Defaults to --dry-run (prints the relay plan, spawns nothing). Pass --execute to run.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  checkPoolFiveHourAdmission,
  countPoolCallsInWindow,
  recordPoolCall
} from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import {
  PIPELINE_JOBS,
  RING_PRESETS,
  loadPoolBudgets,
  poolForSibling,
  readLiveSqliteQuota,
  resolveRing,
  selectSlot,
  guestFallbackCandidates
} from './swarm-quota-ring.mjs'
import {
  DEFAULT_RING_STATE_DIR,
  advanceRingState,
  createRingState,
  readRingState,
  writeRingState
} from './swarm-ring-state.mjs'

export const RELAY_MODES = ['discover', 'fix', 'pipeline', 'case-solve', 'build', 'review', 'publish']
export const DEFAULT_SIBLINGS = ['hermes', 'direct']
export const DEFAULT_WINDOWS = 3
export const DEFAULT_SOFT_WINDOW_SEC = 300
export const DEFAULT_ROUNDS = 1
export const DEFAULT_MAX_CONSERVE_WINDOWS = 1
export const DEFAULT_STALL_KILL_SEC = 0
export const DEFAULT_REPORT_DIR = join(homedir(), '.local/state/curl-ai-bridge/reports')

/** Sibling CLIs that accept an explicit `--model` flag. */
const MODEL_FLAG_CLIS = new Set(['hermes', 'opencode', 'agy'])

/**
 * Classify one window's outcome. A sibling that exits 0 without writing its findings
 * artifact is `ok_no_findings` — a legitimate "found nothing" result, never a failure —
 * so the missing-artifact blind spot becomes visible in the ledger instead of silently
 * recording `status:'ok'` for a stage that produced no report.
 */
export function resolveWindowStatus({ error = null, stallKilled = false, exitCode = null, findingsWritten = false } = {}) {
  if (error) return 'spawn_error'
  if (stallKilled) return 'stall_killed'
  if (exitCode !== 0) return 'failed'
  return findingsWritten ? 'ok' : 'ok_no_findings'
}

/** Statuses that count as a successful relay window for the summary verdict. */
export function isSuccessfulWindowStatus(status) {
  return status === 'ok' || status === 'ok_no_findings' || status === 'ok_after_failover'
}

const SIBLING_TOKEN = /^[a-z0-9][a-z0-9._-]*$/

function expandHome(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string')
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number (got ${value})`)
  return Math.floor(n)
}

function nonNegativeInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number (got ${value})`)
  return Math.floor(n)
}

export function normalizeSiblings(siblings = DEFAULT_SIBLINGS) {
  const raw = Array.isArray(siblings) ? siblings : String(siblings ?? '').split(',')
  const list = raw
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) throw new Error('siblings must contain at least one sibling CLI name')
  for (const s of list) {
    if (!SIBLING_TOKEN.test(s)) throw new Error(`invalid sibling name '${s}' (allowed: a-z 0-9 . _ -)`)
  }
  return list
}

/** Parse `--model-map a=model,b=model` or a JSON object string. */
export function parseModelMap(value) {
  if (!value) return {}
  if (typeof value === 'object') return { ...value }
  const text = String(value).trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model_map_json_invalid')
    return { ...parsed }
  }
  const map = {}
  for (const pair of text.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    if (!k || !v) throw new Error(`model_map_pair_invalid:${pair}`)
    map[k] = v
  }
  return map
}

/**
 * Parse an optional quota-status JSON file (`{ pools: { pool: { weeklyRemainingPct } }, conservePools: [] }`)
 * OR load live weeklyRemainingPct and conservePools directly from the workspace SQLite `ai_quota` store.
 */
export function readQuotaStatus(path) {
  if (!path) {
    return readLiveSqliteQuota()
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const pools = parsed?.pools && typeof parsed.pools === 'object' ? parsed.pools : {}
  const quota = {}
  for (const [pool, v] of Object.entries(pools)) {
    quota[pool] = { weeklyRemainingPct: Number(v?.weeklyRemainingPct ?? 100) }
  }
  return { ok: true, source: 'file', quota, conservePools: Array.isArray(parsed?.conservePools) ? [...parsed.conservePools] : [] }
}

/**
 * Pure planner: no I/O, no CLI spawning. Deterministic in its inputs.
 */
export function buildRelayPlan({
  mode = 'discover',
  siblings = DEFAULT_SIBLINGS,
  windows = null,
  softWindowSec = DEFAULT_SOFT_WINDOW_SEC,
  windowSec = null,
  rounds = DEFAULT_ROUNDS,
  preset = null,
  modelMap = {},
  reportDir = DEFAULT_REPORT_DIR
} = {}) {
  const planMode = (preset === 'k5-pipeline-ring' && (!mode || mode === 'discover'))
    ? 'pipeline'
    : String(mode ?? 'discover').trim().toLowerCase()
  if (!RELAY_MODES.includes(planMode)) {
    throw new Error(`invalid mode '${mode}' (expected one of: ${RELAY_MODES.join('|')})`)
  }
  const list = preset ? resolveRing(null, preset) : normalizeSiblings(siblings)
  const defaultWin = preset ? list.length : DEFAULT_WINDOWS
  const windowCount = positiveInt(windows, defaultWin, 'windows')
  const roundCount = rounds === 'continuous' ? 'continuous' : positiveInt(rounds, DEFAULT_ROUNDS, 'rounds')
  const totalPlanWindows = roundCount === 'continuous' ? windowCount : windowCount * roundCount
  const softSec = positiveInt(windowSec ?? softWindowSec, DEFAULT_SOFT_WINDOW_SEC, 'windowSec')
  const dir = resolve(expandHome(reportDir))
  const models = modelMap && typeof modelMap === 'object' ? modelMap : {}

  const assignments = Array.from({ length: totalPlanWindows }, (_, i) => buildAssignment({
    list, index: i, dir, planMode, softSec, models
  }))

  return {
    version: 'relay-plan/v1',
    mode: planMode,
    siblings: list,
    windows: windowCount,
    softWindowSec: softSec,
    rounds: roundCount,
    preset: preset || null,
    modelMap: models,
    reportDir: dir,
    execution: 'sequential',
    assignmentStrategy: 'round_robin',
    noHardKill: true,
    hardKill: false,
    killsSiblings: false,
    killSwitchFile: join(homedir(), '.local/state/curl-ai-bridge/overnight/STOP_SWARM'),
    summaryReportPath: join(dir, `relay-${planMode}-summary.json`),
    assignments
  }
}

/** One window's assignment. `index` is zero-based across the whole run (rounds included). */
export function buildAssignment({ list, index, dir, planMode, softSec, models = {}, allowConserve = false }) {
  const window = index + 1
  const idx = index % list.length
  const round = Math.floor(index / list.length) + 1
  const rawSibling = list[idx]
  const sibling = rawSibling === 'guest'
    ? guestFallbackCandidates({ list, round, allowConserve })[0]
    : rawSibling
  const job = planMode === 'pipeline'
    ? PIPELINE_JOBS[idx % PIPELINE_JOBS.length]
    : planMode
  const siblingSlot = `sibling${idx + 1}`
  const promotedToParentSlot = `parent${idx + 1}`
  const hasParent = index > 0
  const prevIdx = hasParent ? (index - 1) % list.length : null
  const prevRound = hasParent ? Math.floor((index - 1) / list.length) + 1 : null
  const rawParentSibling = hasParent ? list[prevIdx] : null
  const parentSibling = rawParentSibling === 'guest'
    ? guestFallbackCandidates({ list, round: prevRound, allowConserve })[0]
    : rawParentSibling
  const parentSlot = hasParent ? `parent${prevIdx + 1}` : null
  const parentWindow = hasParent ? index : null
  const parentFindingsPath = hasParent
    ? join(dir, `relay-${planMode}-w${index}-${parentSibling}-findings.json`)
    : null
  const demotedFromParentSlot = index >= list.length ? `parent${idx + 1}` : null

  return {
    window,
    index,
    round,
    sibling,
    rosterSlot: rawSibling,
    job,
    role: 'sibling',
    siblingSlot,
    promotedToParentSlot,
    demotedFromParentSlot,
    parentSibling,
    parentSlot,
    parentWindow,
    parentFindingsPath,
    model: models[sibling] || models[rawSibling] || null,
    pool: poolForSibling(sibling),
    softWindowSec: softSec,
    hardKill: false,
    findingsPath: join(dir, `relay-${planMode}-w${window}-${sibling}-findings.json`),
    reportPath: join(dir, `relay-${planMode}-w${window}-${sibling}.json`)
  }
}

export function buildSiblingPrompt({
  mode,
  job = null,
  window,
  windows,
  sibling,
  siblingSlot = null,
  promotedToParentSlot = null,
  demotedFromParentSlot = null,
  parentSibling = null,
  parentSlot = null,
  parentFindingsPath = null,
  softWindowSec,
  reportPath,
  deadlineIso = null
}) {
  const activeJob = job || (mode === 'pipeline' ? 'discover' : mode)
  const budget = `Soft window budget ${softWindowSec}s (advisory only — do not self-kill; finish gracefully).`
  const deadlineLine = deadlineIso
    ? `Window deadline ${deadlineIso} (cooperative budget: finish before it; the relay stops admitting new sub-turns once the budget is spent).`
    : ''
  const roleLine = [
    siblingSlot ? `Role: ${siblingSlot} [job=${activeJob}]${demotedFromParentSlot ? ` (demoted from ${demotedFromParentSlot} in round-robin ring)` : ''}.` : '',
    parentSibling
      ? `Active Parent: ${parentSlot} (${parentSibling}) — read parent findings at ${parentFindingsPath} and query via "swarm ask --parent-slot ${parentSlot} <question>" if clarity is needed.`
      : 'Active Parent: none (bootstrap window 1).',
    promotedToParentSlot ? `On completion, you are promoted to ${promotedToParentSlot} for the next sibling.` : ''
  ].filter(Boolean).join(' ')
  if (activeJob === 'fix' || activeJob === 'build') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=${activeJob}).`,
      roleLine,
      `Apply the smallest verified fix set for the active case/task, run focused tests, and write a concise JSON report to ${reportPath}.`,
      'Never force-push, never reset --hard, never discard untracked work.',
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'case-solve') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=case-solve).`,
      roleLine,
      `Triage and score open multi-option cases from parent findings, pause only on unrecoverable options, and write a JSON report to ${reportPath}.`,
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'review') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=review).`,
      roleLine,
      `Independently cross-review the active diff and parent build findings, verify tests pass, and write VERDICT: ACCEPT or REJECT to ${reportPath}.`,
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'publish') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=publish).`,
      roleLine,
      `Consolidate verified passing diffs from the round, prepare the triple-layer checkpoint summary, and write the publish report to ${reportPath}.`,
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  return [
    `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=${activeJob}).`,
    roleLine,
    `Discover prioritized work and multi-option cases, then write a concise JSON report to ${reportPath}.`,
    'Read-only exploration only: propose options, do not mutate the working tree.',
    deadlineLine,
    budget
  ].filter(Boolean).join(' ')
}

function envBinName(sibling) {
  return `SWARM_RELAY_${sibling.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`
}

/**
 * Resolve the argv for a sibling CLI. `opencode` is pinned to `run --standalone`
 * (never `serve`, per workspace hard rules). Unknown siblings fall back to a
 * same-named binary. Override with SWARM_RELAY_<SIBLING>_BIN.
 * `model` is appended only for CLIs that accept `--model`.
 */
export function buildSiblingCommand(sibling, { prompt, model = null }) {
  const override = process.env[envBinName(sibling)]
  let base
  if (override && override.trim()) base = override.trim().split(/\s+/)
  else if (sibling === 'hermes') base = ['hermes', '-z']
  else if (sibling === 'opencode') base = ['opencode', 'run', '--standalone', '--model', 'opencode/deepseek-v4.1-flash-free']
  else if (sibling === 'direct') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'cloudflare', '--prompt']
  else if (sibling === 'direct-vercel') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'vercel', '--prompt']
  else if (sibling === 'local') base = [process.execPath, resolve(new URL('./local-llama-cli.mjs', import.meta.url).pathname), '--model', '1.5b', '--prompt']
  else if (sibling === 'copilot') base = ['copilot', '-p']
  else if (sibling === 'gemini-api') base = ['gemini-api', 'prompt']
  else if (sibling === 'agy') base = ['agy', '-p']
  else base = [sibling]

  if (base[0] === 'opencode') {
    const rest = base.slice(1)
    if (!rest.includes('run')) base = ['opencode', 'run', '--standalone', ...rest]
    // Hard rule: never launch opencode serve/attach from the relay.
    base = base.filter((token) => token !== 'serve')
  }
  const args = [...base.slice(1)]
  if (model && MODEL_FLAG_CLIS.has(sibling)) args.push('--model', String(model))
  args.push(prompt)
  return { command: base[0], args }
}

function writeReport(path, payload) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  protectedWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * Run one child. No routine timer: `stallKillSec` defaults to 0 (disabled) so a normal
 * turn is never interrupted. When enabled, a runaway turn is killed at the stall limit.
 */
function runChild({ command, args, cwd, env, stallKillSec, windowStartMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd, env, detached: true })
    let settled = false
    let timer = null
    const finish = (status, signal, error, stallKilled) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ status, signal, error, stallKilled, elapsedMs: Date.now() - windowStartMs })
    }
    if (Number(stallKillSec) > 0 && child.pid) {
      timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
        finish(null, 'SIGKILL', null, true)
      }, Number(stallKillSec) * 1000)
    }
    child.on('error', (err) => finish(null, null, err, false))
    child.on('close', (code, signal) => finish(code, signal, null, false))
  })
}

function parseArgs(argv) {
  const opts = {
    mode: 'discover',
    siblings: DEFAULT_SIBLINGS.join(','),
    windows: null,
    softWindowSec: DEFAULT_SOFT_WINDOW_SEC,
    windowSec: null,
    rounds: String(DEFAULT_ROUNDS),
    preset: null,
    modelMap: null,
    allowConserve: false,
    maxConserveWindows: DEFAULT_MAX_CONSERVE_WINDOWS,
    subTurns: 1,
    stallKillSec: DEFAULT_STALL_KILL_SEC,
    quotaStatus: null,
    printQuotaStatus: false,
    ringStateDir: DEFAULT_RING_STATE_DIR,
    reportDir: DEFAULT_REPORT_DIR,
    execute: false,
    json: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--dry-run') opts.execute = false
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--siblings') opts.siblings = argv[++i]
    else if (a === '--windows') opts.windows = argv[++i]
    else if (a === '--soft-window-sec') opts.softWindowSec = argv[++i]
    else if (a === '--window-sec') opts.windowSec = argv[++i]
    else if (a === '--rounds') opts.rounds = argv[++i]
    else if (a === '--preset') opts.preset = argv[++i]
    else if (a === '--model-map') opts.modelMap = argv[++i]
    else if (a === '--allow-conserve') opts.allowConserve = true
    else if (a === '--max-conserve-windows') opts.maxConserveWindows = argv[++i]
    else if (a === '--sub-turns') opts.subTurns = argv[++i]
    else if (a === '--stall-kill-sec') opts.stallKillSec = argv[++i]
    else if (a === '--quota-status' || a === 'quota-status') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        opts.printQuotaStatus = true
      } else {
        opts.quotaStatus = argv[++i]
        opts.printQuotaStatus = true
      }
    }
    else if (a === '--ring-state-dir') opts.ringStateDir = argv[++i]
    else if (a === '--report-dir') opts.reportDir = argv[++i]
    else throw new Error(`unknown argument '${a}' (try --help)`)
  }
  return opts
}

const USAGE = `Usage: node scripts/swarm-relay.mjs [options]

Graceful, quota-aware multi-sibling relay with round-robin parent promotion.
No routine hard kill: a window is a cooperative budget; only --stall-kill-sec interrupts.

      --mode <discover|fix>      Relay intent (default: discover)
      --siblings <csv>           Sibling CLIs to alternate (default: hermes,direct)
      --preset <name>            Roster preset (tier1-ring = hermes,direct,gemini-api,opencode)
      --windows <n>              Windows per round (default: 3)
      --rounds <n|continuous>    Rounds to run (default: 1)
      --window-sec <n>           Cooperative window budget in seconds (default: 300)
      --soft-window-sec <n>      Alias for --window-sec
      --model-map <csv|json>     Per-sibling model, e.g. hermes=model,direct=model
      --allow-conserve           Admit CONSERVE pools (agy-*) up to --max-conserve-windows
      --max-conserve-windows <n> Cap on CONSERVE windows (default: 1)
      --stall-kill-sec <n>       Opt-in runaway kill in seconds (default 0 = disabled)
      --quota-status <file>      JSON with per-pool weeklyRemainingPct + conservePools
      --ring-state-dir <dir>     Ring ledger directory
      --report-dir <dir>         Report directory (default: ~/.local/state/curl-ai-bridge/reports)
      --dry-run                  Print plan only (default)
      --execute                  Run siblings sequentially, waiting for each to finish
      --json                     Emit structured JSON
  -h, --help                     Show this help
`

export async function runRelay(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return { ok: true, help: true }
  }

  const stateDir = join(homedir(), '.local/state/curl-ai-bridge/overnight')
  if (opts.printQuotaStatus && !opts.execute) {
    const statusInfo = readQuotaStatus(opts.quotaStatus)
    const budgets = loadPoolBudgets({
      countCalls: (pool) => countPoolCallsInWindow(stateDir, pool),
      quota: statusInfo.quota,
      conservePools: statusInfo.conservePools
    })
    const budgetsWithEligibility = Object.fromEntries(
      Object.entries(budgets).map(([pool, b]) => [
        pool,
        { ...b, eligible: Boolean(b.admitted && (!b.conserve || opts.allowConserve)) }
      ])
    )
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'quota-status', source: statusInfo.source || 'sqlite', allowConserve: Boolean(opts.allowConserve), budgets: budgetsWithEligibility }, null, 2)}\n`)
    } else {
      const lines = [
        `swarm relay quota-status (source=${statusInfo.source || 'sqlite'} | 5h window + live weekly/CONSERVE admission):`,
        ...Object.values(budgetsWithEligibility).map((b) =>
          `  ${b.pool}: eligible=${b.eligible} quotaAdmitted=${b.admitted} conserve=${b.conserve} calls5h=${b.callsInWindow}/${b.cap ?? 'uncapped'} weekly=${b.weeklyRemainingPct}% reason=${b.reason}`
        )
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return { ok: true, mode: 'quota-status', source: statusInfo.source || 'sqlite', budgets: budgetsWithEligibility }
  }

  const plan = buildRelayPlan({
    mode: opts.mode,
    siblings: opts.siblings,
    windows: opts.windows,
    softWindowSec: opts.softWindowSec,
    windowSec: opts.windowSec,
    rounds: opts.rounds,
    preset: opts.preset,
    modelMap: parseModelMap(opts.modelMap),
    reportDir: opts.reportDir
  })
  const startedAt = new Date().toISOString()

  if (!opts.execute) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'dry-run', executed: false, startedAt, plan }, null, 2)}\n`)
    } else {
      const lines = [
        `relay plan (dry-run): mode=${plan.mode} windows=${plan.windows} rounds=${plan.rounds} siblings=${plan.siblings.join('->')}`,
        `window=${plan.softWindowSec}s noHardKill=${plan.noHardKill} stallKillSec=${opts.stallKillSec} execution=${plan.execution} report_dir=${plan.reportDir}`,
        ...plan.assignments.map((a) => `  w${a.window} r${a.round} [${a.job}] ${a.sibling} (${a.pool}) -> ${a.reportPath}`),
        `summary -> ${plan.summaryReportPath}`,
        'dry-run: no sibling CLIs spawned (pass --execute to run)'
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return { ok: true, mode: 'dry-run', executed: false, plan }
  }

  const cwd = resolve(new URL('..', import.meta.url).pathname)
  const { quota, conservePools } = readQuotaStatus(opts.quotaStatus)
  const budgets = loadPoolBudgets({
    countCalls: (pool) => countPoolCallsInWindow(stateDir, pool),
    quota,
    conservePools
  })

  const priorState = readRingState(opts.ringStateDir)
  let ringState = priorState && Array.isArray(priorState.siblings) && priorState.siblings.join(',') === plan.siblings.join(',')
    ? priorState
    : createRingState({ siblings: plan.siblings, mode: plan.mode, nowIso: startedAt })

  const windows = []
  let stopReason = 'completed'
  let conserveWindowsUsed = Number(priorState?.conserveWindowsUsed || 0) || 0
  const totalWindows = plan.rounds === 'continuous' ? Number.POSITIVE_INFINITY : plan.windows * plan.rounds

  for (let index = 0; index < totalWindows; index += 1) {
    if (existsSync(plan.killSwitchFile)) {
      stopReason = 'kill_switch_armed'
      break
    }

    const assignment = buildAssignment({
      list: plan.siblings, index, dir: plan.reportDir, planMode: plan.mode,
      softSec: plan.softWindowSec, models: plan.modelMap, allowConserve: opts.allowConserve
    })
    const choice = selectSlot({
      ring: plan.siblings,
      windowIndex: index,
      round: assignment.round,
      budgets,
      modelMap: plan.modelMap,
      allowConserve: opts.allowConserve,
      maxConserveWindows: nonNegativeInt(opts.maxConserveWindows, DEFAULT_MAX_CONSERVE_WINDOWS, 'maxConserveWindows'),
      conserveWindowsUsed
    })
    if (choice.conserve) conserveWindowsUsed = choice.conserveWindowsUsed
    if (!choice.admitted) {
      windows.push({
        window: assignment.window, round: assignment.round, sibling: assignment.sibling,
        job: assignment.job, status: 'deferred_quota', reason: choice.reason, elapsedMs: 0, hardKilled: false
      })
      stopReason = 'quota_exhausted'
      break
    }

    const windowStartedAt = new Date().toISOString()
    const windowStartMs = Date.now()
    const deadlineMs = windowStartMs + plan.softWindowSec * 1000
    const prompt = buildSiblingPrompt({
      mode: plan.mode,
      job: assignment.job,
      window: assignment.window,
      windows: totalWindows === Number.POSITIVE_INFINITY ? 'continuous' : totalWindows,
      sibling: choice.sibling,
      siblingSlot: assignment.siblingSlot,
      promotedToParentSlot: assignment.promotedToParentSlot,
      demotedFromParentSlot: assignment.demotedFromParentSlot,
      parentSibling: assignment.parentSibling,
      parentSlot: assignment.parentSlot,
      parentFindingsPath: assignment.parentFindingsPath,
      softWindowSec: plan.softWindowSec,
      reportPath: assignment.findingsPath || assignment.reportPath,
      deadlineIso: new Date(deadlineMs).toISOString()
    })

    const { command, args } = buildSiblingCommand(choice.sibling, { prompt, model: choice.model })
    const maxSubTurns = positiveInt(opts.subTurns, 1, 'subTurns')
    let res = null
    let subTurnsExecuted = 0
    let subTurnsStoppedByBudget = false
    for (let subTurn = 1; subTurn <= maxSubTurns; subTurn += 1) {
      if (subTurn > 1 && Date.now() - windowStartMs >= plan.softWindowSec * 1000) {
        subTurnsStoppedByBudget = true
        break
      }
      subTurnsExecuted += 1
      res = await runChild({
        command, args, cwd, stallKillSec: opts.stallKillSec, windowStartMs,
        env: {
          ...process.env,
          SWARM_RELAY_WINDOW: String(assignment.window),
          SWARM_RELAY_MODE: plan.mode,
          SWARM_RELAY_JOB: assignment.job,
          SWARM_RELAY_WINDOW_INDEX: String(index),
          SWARM_RELAY_ROUND: String(assignment.round),
          SWARM_RELAY_SLOT: assignment.siblingSlot,
          SWARM_RELAY_PARENT_SLOT: assignment.parentSlot || '',
          SWARM_RELAY_WINDOW_SEC: String(plan.softWindowSec),
          SWARM_RELAY_DEADLINE_AT: new Date(deadlineMs).toISOString(),
          SWARM_WINDOW_DEADLINE_MS: String(deadlineMs),
          SWARM_RELAY_SUB_TURN: String(subTurn)
        }
      })
      if (res.error || res.status !== 0) break
    }

    const exitCode = typeof res.status === 'number' ? res.status : null
    const findingsPath = assignment.findingsPath || assignment.reportPath || null
    const findingsWritten = Boolean(findingsPath && existsSync(findingsPath))
    const entry = {
      window: assignment.window,
      round: assignment.round,
      job: assignment.job,
      sibling: choice.sibling,
      pool: choice.pool,
      model: choice.model,
      substitutedFor: choice.substitutedFor,
      command,
      argv: args,
      startedAt: windowStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: res.elapsedMs,
      windowSec: plan.softWindowSec,
      softWindowExceeded: res.elapsedMs > plan.softWindowSec * 1000,
      subTurnsExecuted,
      subTurnsStoppedByBudget,
      hardKilled: res.stallKilled === true,
      exitCode,
      signal: res.signal || null,
      status: resolveWindowStatus({ error: res.error, stallKilled: res.stallKilled === true, exitCode, findingsWritten }),
      error: res.error ? String(res.error.code || res.error.message) : null,
      findingsPath,
      findingsWritten
    }
    ringState = advanceRingState(ringState, assignment, {
      model: choice.model, pool: choice.pool, findingsPath: assignment.findingsPath
    })
    ringState.conserveWindowsUsed = conserveWindowsUsed
    writeRingState(opts.ringStateDir, ringState)

    windows.push(entry)
    writeReport(assignment.reportPath, { ...entry, mode: plan.mode, noHardKill: true })

    // Quota ledger: one call against the pool actually used.
    if (choice.pool) {
      recordPoolCall(stateDir, { quotaPool: choice.pool, taskId: `relay-w${assignment.window}`, status: entry.status === 'ok' ? 'ok' : `exit_${exitCode ?? 'null'}` })
    }

    if (res.error && res.error.code === 'ENOENT') {
      // Missing CLI: keep relaying so the remaining siblings still run.
      continue
    }
    if (exitCode !== 0) {
      // Self-healing failover: retry once with an alternate $0 sibling (hermes or direct)
      const fallbackSibling = choice.sibling === 'hermes' ? 'direct' : 'hermes'
      const fbCmd = buildSiblingCommand(fallbackSibling, { prompt })
      const fbStartMs = Date.now()
      const fbRes = await runChild({
        command: fbCmd.command, args: fbCmd.args, cwd, stallKillSec: opts.stallKillSec, windowStartMs: fbStartMs,
        env: { ...process.env, SWARM_RELAY_WINDOW: String(assignment.window), SWARM_RELAY_MODE: plan.mode, SWARM_RELAY_FALLBACK_FROM: choice.sibling }
      })
      const fbCode = typeof fbRes.status === 'number' ? fbRes.status : null
      entry.failover = {
        fallbackSibling,
        elapsedMs: fbRes.elapsedMs,
        exitCode: fbCode,
        status: !fbRes.error && fbCode === 0 ? 'ok' : 'failed'
      }
      if (entry.failover.status === 'ok') {
        entry.status = 'ok_after_failover'
        writeReport(assignment.reportPath, { ...entry, mode: plan.mode, noHardKill: true })
        continue
      }
      stopReason = 'sibling_failed'
    }
  }

  ringState.finishedAt = new Date().toISOString()
  ringState.stopReason = stopReason
  writeRingState(opts.ringStateDir, ringState)

  const summary = {
    ok: windows.every((w) => isSuccessfulWindowStatus(w.status)),
    mode: 'execute',
    executed: true,
    relayMode: plan.mode,
    stopReason,
    noHardKill: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan,
    windows
  }
  writeReport(plan.summaryReportPath, summary)

  if (opts.json) process.stdout.write(`${JSON.stringify({ ...summary, reportPath: plan.summaryReportPath }, null, 2)}\n`)
  else {
    const ran = windows.map((w) => `w${w.window}:${w.sibling}=${w.status}(${Math.round(w.elapsedMs / 1000)}s)`).join(' ')
    process.stdout.write(`relay (execute): ${stopReason} | ${ran || 'no windows run'} | <- ${plan.summaryReportPath}\n`)
  }
  return { ...summary, reportPath: plan.summaryReportPath }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runRelay(process.argv.slice(2))
    .then((result) => {
      if (result && result.mode === 'execute' && result.ok === false) process.exitCode = 1
    })
    .catch((err) => {
      process.stderr.write(`swarm-relay: ${err.message}\n`)
      process.exitCode = 2
    })
}

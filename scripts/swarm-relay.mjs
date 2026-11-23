#!/usr/bin/env node
/**
 * SWARM RELAY — graceful multi-sibling relay runner.
 *
 * Alternates sibling CLIs (default: hermes -> opencode) across N soft windows.
 * Each sibling runs to completion on its own: there is NO hard kill and NO
 * wall-clock timeout. `--soft-window-sec` is advisory only — once a sibling
 * exceeds it we record `softWindowExceeded` and keep waiting, so in-flight
 * work is never lost and no artifacts are left half-written.
 *
 * Defaults to --dry-run (prints the relay plan, spawns nothing). Pass
 * --execute to run the siblings sequentially for real.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const RELAY_MODES = ['discover', 'fix']
export const DEFAULT_SIBLINGS = ['hermes', 'opencode']
export const DEFAULT_WINDOWS = 3
export const DEFAULT_SOFT_WINDOW_SEC = 300
export const DEFAULT_REPORT_DIR = join(homedir(), '.local/state/curl-ai-bridge/reports')

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

/**
 * Pure planner: no I/O, no CLI spawning. Deterministic in its inputs.
 * @returns {{version:string, mode:string, siblings:string[], windows:number, softWindowSec:number,
 *   reportDir:string, execution:string, assignmentStrategy:string, noHardKill:boolean,
 *   hardKill:boolean, killsSiblings:boolean, killSwitchFile:string, summaryReportPath:string,
 *   assignments:Array<{window:number, sibling:string, softWindowSec:number, hardKill:boolean, reportPath:string}>}}
 */
export function buildRelayPlan({
  mode = 'discover',
  siblings = DEFAULT_SIBLINGS,
  windows = DEFAULT_WINDOWS,
  softWindowSec = DEFAULT_SOFT_WINDOW_SEC,
  reportDir = DEFAULT_REPORT_DIR
} = {}) {
  const planMode = String(mode ?? 'discover').trim().toLowerCase()
  if (!RELAY_MODES.includes(planMode)) {
    throw new Error(`invalid mode '${mode}' (expected one of: ${RELAY_MODES.join('|')})`)
  }
  const list = normalizeSiblings(siblings)
  const windowCount = positiveInt(windows, DEFAULT_WINDOWS, 'windows')
  const softSec = positiveInt(softWindowSec, DEFAULT_SOFT_WINDOW_SEC, 'softWindowSec')
  const dir = resolve(expandHome(reportDir))

  const assignments = Array.from({ length: windowCount }, (_, i) => {
    const window = i + 1
    const sibling = list[i % list.length]
    return {
      window,
      sibling,
      softWindowSec: softSec,
      hardKill: false,
      reportPath: join(dir, `relay-${planMode}-w${window}-${sibling}.json`)
    }
  })

  return {
    version: 'relay-plan/v1',
    mode: planMode,
    siblings: list,
    windows: windowCount,
    softWindowSec: softSec,
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

export function buildSiblingPrompt({ mode, window, windows, sibling, softWindowSec, reportPath }) {
  const budget = `Soft window budget ${softWindowSec}s (advisory only — do not self-kill; finish gracefully).`
  if (mode === 'fix') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=fix).`,
      `Apply the smallest verified fix set for the active case/task, run focused tests, and write a concise JSON report to ${reportPath}.`,
      'Never force-push, never reset --hard, never discard untracked work.',
      budget
    ].join(' ')
  }
  return [
    `swarm relay window ${window}/${windows} -> ${sibling} (mode=discover).`,
    `Discover prioritized work and multi-option cases, then write a concise JSON report to ${reportPath}.`,
    'Read-only exploration only: propose options, do not mutate the working tree.',
    budget
  ].join(' ')
}

function envBinName(sibling) {
  return `SWARM_RELAY_${sibling.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`
}

/**
 * Resolve the argv for a sibling CLI. `opencode` is pinned to `run --standalone`
 * (never `serve`, per workspace hard rules). Unknown siblings fall back to a
 * same-named binary. Override with SWARM_RELAY_<SIBLING>_BIN, e.g.
 * SWARM_RELAY_HERMES_BIN="hermes chat --prompt".
 */
export function buildSiblingCommand(sibling, { prompt }) {
  const override = process.env[envBinName(sibling)]
  let base
  if (override && override.trim()) base = override.trim().split(/\s+/)
  else if (sibling === 'hermes') base = ['hermes', '-z']
  else if (sibling === 'opencode') base = ['opencode', 'run', '--standalone', '--model', 'opencode/deepseek-v4.1-flash-free']
  else if (sibling === 'direct') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'cloudflare', '--prompt']
  else base = [sibling]

  if (base[0] === 'opencode') {
    const rest = base.slice(1)
    if (!rest.includes('run')) base = ['opencode', 'run', '--standalone', ...rest]
    // Hard rule: never launch opencode serve/attach from the relay.
    base = base.filter((token) => token !== 'serve')
  }
  return { command: base[0], args: [...base.slice(1), prompt] }
}

function writeReport(path, payload) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

function parseArgs(argv) {
  const opts = {
    mode: 'discover',
    siblings: DEFAULT_SIBLINGS.join(','),
    windows: DEFAULT_WINDOWS,
    softWindowSec: DEFAULT_SOFT_WINDOW_SEC,
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
    else if (a === '--report-dir') opts.reportDir = argv[++i]
    else throw new Error(`unknown argument '${a}' (try --help)`)
  }
  return opts
}

const USAGE = `Usage: node scripts/swarm-relay.mjs [options]

Graceful multi-sibling relay: alternates sibling CLIs across soft windows.
No hard kill and no timeout — each sibling finishes on its own.

      --mode <discover|fix>      Relay intent (default: discover)
      --siblings <csv>           Sibling CLIs to alternate (default: hermes,opencode)
      --windows <n>              Number of relay windows (default: 3)
      --soft-window-sec <n>      Advisory per-window budget in seconds (default: 300)
      --report-dir <dir>         Report directory (default: ~/.local/state/curl-ai-bridge/reports)
      --dry-run                  Print plan only (default)
      --execute                  Run siblings sequentially, waiting for each to finish
      --json                     Emit structured JSON
  -h, --help                     Show this help
`

export function runRelay(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return { ok: true, help: true }
  }

  const plan = buildRelayPlan(opts)
  const startedAt = new Date().toISOString()

  if (!opts.execute) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'dry-run', executed: false, startedAt, plan }, null, 2)}\n`)
    } else {
      const lines = [
        `relay plan (dry-run): mode=${plan.mode} windows=${plan.windows} siblings=${plan.siblings.join('->')}`,
        `soft_window=${plan.softWindowSec}s noHardKill=${plan.noHardKill} execution=${plan.execution} report_dir=${plan.reportDir}`,
        ...plan.assignments.map((a) => `  w${a.window} ${a.sibling} -> ${a.reportPath}`),
        `summary -> ${plan.summaryReportPath}`,
        'dry-run: no sibling CLIs spawned (pass --execute to run)'
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return { ok: true, mode: 'dry-run', executed: false, plan }
  }

  const windows = []
  let stopReason = 'completed'

  for (const assignment of plan.assignments) {
    if (existsSync(plan.killSwitchFile)) {
      stopReason = 'kill_switch_armed'
      break
    }

    const prompt = buildSiblingPrompt({
      mode: plan.mode,
      window: assignment.window,
      windows: plan.windows,
      sibling: assignment.sibling,
      softWindowSec: plan.softWindowSec,
      reportPath: assignment.reportPath
    })
    const { command, args } = buildSiblingCommand(assignment.sibling, { prompt })
    const windowStartedAt = new Date().toISOString()
    const windowStartMs = Date.now()

    // No `timeout` on purpose: the relay never hard-kills a sibling.
    const res = spawnSync(command, args, {
      stdio: 'inherit',
      cwd: resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, SWARM_RELAY_WINDOW: String(assignment.window), SWARM_RELAY_MODE: plan.mode }
    })

    const elapsedMs = Date.now() - windowStartMs
    const exitCode = typeof res.status === 'number' ? res.status : null
    const entry = {
      window: assignment.window,
      sibling: assignment.sibling,
      command,
      argv: args,
      startedAt: windowStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs,
      softWindowSec: plan.softWindowSec,
      softWindowExceeded: elapsedMs > plan.softWindowSec * 1000,
      hardKilled: false,
      exitCode,
      signal: res.signal || null,
      status: res.error ? 'spawn_error' : exitCode === 0 ? 'ok' : 'failed',
      error: res.error ? String(res.error.code || res.error.message) : null
    }
    windows.push(entry)
    writeReport(assignment.reportPath, { ...entry, mode: plan.mode, noHardKill: true })

    if (res.error && res.error.code === 'ENOENT') {
      // Missing CLI: keep relaying so the remaining siblings still run.
      continue
    }
    if (exitCode !== 0) {
      // Self-healing failover: retry once with an alternate $0 sibling (hermes or direct)
      const fallbackSibling = assignment.sibling === 'hermes' ? 'direct' : 'hermes'
      const fbCmd = buildSiblingCommand(fallbackSibling, { prompt })
      const fbStartMs = Date.now()
      const fbRes = spawnSync(fbCmd.command, fbCmd.args, {
        stdio: 'inherit',
        cwd: resolve(new URL('..', import.meta.url).pathname),
        env: { ...process.env, SWARM_RELAY_WINDOW: String(assignment.window), SWARM_RELAY_MODE: plan.mode, SWARM_RELAY_FALLBACK_FROM: assignment.sibling }
      })
      const fbCode = typeof fbRes.status === 'number' ? fbRes.status : null
      entry.failover = {
        fallbackSibling,
        elapsedMs: Date.now() - fbStartMs,
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

  const summary = {
    ok: windows.every((w) => w.status === 'ok' || w.status === 'ok_after_failover'),
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
  try {
    const result = runRelay(process.argv.slice(2))
    if (result.mode === 'execute' && result.ok === false) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`swarm-relay: ${err.message}\n`)
    process.exitCode = 2
  }
}

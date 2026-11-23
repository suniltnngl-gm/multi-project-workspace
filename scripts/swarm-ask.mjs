#!/usr/bin/env node
/**
 * Cross-session read-only query CLI (`swarm ask --session <id> | --all | --parent-slot <slot> "<question>"`).
 *
 * Defaults to Tier 1 (`--mode grep`, $0 zero-LLM).
 * Explicit `--mode llm` enforces READ-ONLY prompt wrapper and warns if session >60KB.
 * `--parent-slot` resolves a relay ring slot (parent1..parentK / siblingN / CLI name)
 * through the ring ledger and greps that parent's findings artifact.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildReadOnlyAskCommand,
  grepAllSessionTranscripts,
  grepSessionTranscript,
  resolveDefaultHandoffDir
} from '../apps/api/src/toolchain/dispatch/session-handoff.js'
import {
  checkPoolFiveHourAdmission,
  recordPoolCall
} from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'
import {
  DEFAULT_RING_STATE_DIR,
  readRingState,
  resolveSlot
} from './swarm-ring-state.mjs'

const argv = process.argv.slice(2)
const valueFlags = new Set(['--session', '--mode', '--cli', '--timeout', '--max-matches', '--transcript', '--handoff-dir', '--pool', '--state-dir', '--parent-slot', '--ring-state-dir'])
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const has = (name) => {
  for (let i = 0; i < argv.length; i += 1) {
    if (valueFlags.has(argv[i])) {
      i += 1
      continue
    }
    if (argv[i] === name) return true
  }
  return false
}

if (has('--help') || has('-h') || argv.length === 0) {
  console.log(`Usage: swarm ask (--session <id> | --all | --parent-slot <slot>) "<question>" [options]
Options:
  --session <id>           Target session/conversation ID
  --all                    Search across ALL handoff cards and AGY transcripts ($0 grep)
  --parent-slot <slot>     Query a relay ring slot (parent1..parentK / siblingN / CLI name)
  --ring-state-dir <dir>   Ring ledger directory (default: ~/.local/state/curl-ai-bridge/relay)
  --mode <grep|llm>        Query mode: grep ($0 default) or llm (bounded READ-ONLY headless)
  --cli <agy>              CLI backend for --mode llm (default: agy)
  --timeout <sec>          Timeout in seconds for --mode llm (default: 120)
  --dry-run                Print resolved LLM command + size warning without executing
  --max-matches <n>        Max grep matches (default: 8)
  --transcript <path>      Explicit transcript path override
  --handoff-dir <dir>      Override handoff directory
  --pool <pool>            Quota pool for --mode llm 5h cap (default: agy-gemini)
  --state-dir <dir>        Overnight state directory for 5h cap ledger
  --json                   Output JSON`)
  process.exit(0)
}

const sessionId = flag('--session', null)
const parentSlotKey = flag('--parent-slot', null)
const ringStateDir = flag('--ring-state-dir', DEFAULT_RING_STATE_DIR)
const mode = flag('--mode', 'grep')
const cli = flag('--cli', 'agy')
const timeoutSec = Number(flag('--timeout', '120')) || 120
const maxMatches = Number(flag('--max-matches', '8')) || 8
const transcriptPath = flag('--transcript', null)
const handoffDir = flag('--handoff-dir', resolveDefaultHandoffDir())

// Extract positional question (first arg not belonging to a known flag)
const positionals = []
for (let i = 0; i < argv.length; i += 1) {
  if (valueFlags.has(argv[i])) {
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      console.error(`swarm ask: flag '${argv[i]}' requires a value`)
      process.exit(1)
    }
    i += 1
    continue
  }
  if (argv[i].startsWith('--')) continue
  positionals.push(argv[i])
}
const question = positionals.join(' ').trim()
const searchAll = has('--all')

if ((!sessionId && !searchAll && !parentSlotKey) || !question) {
  console.error('swarm ask: (--session <id> | --all | --parent-slot <slot>) and "<question>" are required')
  process.exit(1)
}

/** Grep one artifact (the parent's findings file) for the question, case-insensitive. */
function grepArtifact(path, query, limit) {
  if (!path || !existsSync(path)) return { path, found: false, matches: [] }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const needle = String(query || '').toLowerCase()
  const matches = []
  for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
    if (lines[i].toLowerCase().includes(needle)) {
      matches.push({ line: i + 1, snippet: lines[i].slice(0, 220) })
    }
  }
  return { path, found: true, matches }
}

if (parentSlotKey) {
  const state = readRingState(ringStateDir)
  const slot = resolveSlot(state, parentSlotKey)
  if (!slot) {
    console.error(`swarm ask: unknown parent slot '${parentSlotKey}' (ring ledger ${join(ringStateDir, 'ring-state.json')}` + (state ? ' has slots: ' + Object.keys(state.slots).join(',') : ' missing or unreadable') + ')')
    process.exit(1)
  }
  const artifact = grepArtifact(slot.findingsPath, question, maxMatches)
  const payload = {
    ok: true,
    mode: 'grep-parent',
    parentSlot: parentSlotKey,
    resolvedSlot: slot.key,
    cli: slot.cli,
    model: slot.model,
    pool: slot.pool,
    role: slot.role,
    findingsPath: slot.findingsPath,
    artifactFound: artifact.found,
    matchCount: artifact.matches.length,
    matches: artifact.matches
  }
  if (has('--json')) {
    console.log(JSON.stringify(payload, null, 2))
  } else if (!artifact.found) {
    console.log(`swarm ask [grep-parent]: slot=${slot.key} cli=${slot.cli} findings=${slot.findingsPath} (artifact not present yet)`)
  } else {
    console.log(`swarm ask [grep-parent]: slot=${slot.key} cli=${slot.cli} matches=${artifact.matches.length}`)
    for (const m of artifact.matches) {
      console.log(`  [${slot.cli} findings:${m.line}] ${m.snippet}`)
    }
    if (artifact.matches.length === 0) {
      console.log('  (no matches in parent findings — try --all for a wider grep)')
    }
  }
  process.exit(0)
}

if (searchAll) {
  const res = grepAllSessionTranscripts({ query: question, handoffDir, maxMatches })
  if (has('--json')) {
    console.log(JSON.stringify(res, null, 2))
  } else {
    console.log(`swarm ask [grep-all]: scanned=${res.sessionsScanned}/${res.totalSessions} matches=${res.matchCount}`)
    for (const m of res.matches) {
      console.log(`  [${String(m.sessionId).slice(0, 8)} ${m.source}:${m.line}] ${m.snippet}`)
    }
  }
  process.exit(0)
}

if (mode === 'grep') {
  const res = grepSessionTranscript({ sessionId, query: question, transcriptPath, handoffDir, maxMatches })
  if (has('--json')) {
    console.log(JSON.stringify(res, null, 2))
  } else {
    const kb = Math.round((res.transcriptStats?.bytes || 0) / 1024)
    console.log(`swarm ask [grep]: session=${sessionId} matches=${res.matchCount} handoff=${res.handoffFound} transcript=${kb}KB`)
    for (const m of res.matches) {
      console.log(`  [${m.source}:${m.line}] ${m.snippet}`)
    }
    if (res.matchCount === 0) {
      console.log('  (no local matches — escalate with --mode llm only if necessary)')
    }
  }
  process.exit(0)
}

if (mode === 'llm') {
  const stateRoot = process.env.SWARM_STATE_ROOT || join(homedir(), '.local', 'state', 'curl-ai-bridge')
  const stateDir = flag('--state-dir', join(stateRoot, 'overnight'))
  const pool = flag('--pool', cli === 'agy' ? 'agy-gemini' : cli)
  const cap = checkPoolFiveHourAdmission(stateDir, pool)
  if (!cap.admitted) {
    const msg = `swarm ask [blocked]: 5h cap reached for pool=${pool} (${cap.callsInWindow ?? 0}/${cap.cap}). Use --mode grep ($0).`
    if (has('--json')) console.log(JSON.stringify({ ok: false, mode: 'llm', blocked: true, pool, cap }, null, 2))
    else console.error(msg)
    process.exit(2)
  }

  const spec = buildReadOnlyAskCommand({ sessionId, question, cli, timeoutSec, transcriptPath })
  if (spec.sizeWarning) {
    const kb = Math.round(spec.stats.bytes / 1024)
    console.error(`swarm ask [warn]: target session ${sessionId} is ${kb}KB (>60KB). Prefer --mode grep to save weekly quota.`)
  }
  if (has('--dry-run')) {
    console.log(JSON.stringify({ ok: true, dryRun: true, mode: 'llm', sessionId, pool, cap, sizeWarning: spec.sizeWarning, command: spec.command, args: spec.args }, null, 2))
    process.exit(0)
  }
  recordPoolCall(stateDir, { quotaPool: pool, source: 'swarm-ask', sessionId })
  const child = spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: (timeoutSec + 10) * 1000 })
  if (has('--json')) {
    console.log(JSON.stringify({
      ok: child.status === 0,
      mode: 'llm',
      sessionId,
      sizeWarning: spec.sizeWarning,
      exitCode: child.status,
      stdout: child.stdout || '',
      stderr: child.stderr || ''
    }, null, 2))
  } else {
    if (child.stdout) process.stdout.write(child.stdout)
    if (child.stderr) process.stderr.write(child.stderr)
  }
  process.exit(child.status ?? 1)
}

console.error(`swarm ask: unknown --mode '${mode}' (expected grep or llm)`)
process.exit(1)

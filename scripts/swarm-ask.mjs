#!/usr/bin/env node
/**
 * Cross-session read-only query CLI (`swarm ask --session <id> "<question>"`).
 *
 * Defaults to Tier 1 (`--mode grep`, $0 zero-LLM).
 * Explicit `--mode llm` enforces READ-ONLY prompt wrapper and warns if session >60KB.
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildReadOnlyAskCommand,
  grepSessionTranscript,
  resolveDefaultHandoffDir
} from '../apps/api/src/toolchain/dispatch/session-handoff.js'
import {
  checkPoolFiveHourAdmission,
  recordPoolCall
} from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

if (has('--help') || has('-h') || argv.length === 0) {
  console.log(`Usage: swarm ask --session <id> "<question>" [options]
Options:
  --session <id>           Target session/conversation ID (required)
  --mode <grep|llm>        Query mode: grep ($0 default) or llm (bounded READ-ONLY headless)
  --cli <agy>              CLI backend for --mode llm (default: agy)
  --timeout <sec>          Timeout in seconds for --mode llm (default: 120)
  --dry-run                Print resolved LLM command + size warning without executing
  --max-matches <n>        Max grep matches (default: 8)
  --transcript <path>      Explicit transcript path override
  --handoff-dir <dir>      Override handoff directory
  --json                   Output JSON`)
  process.exit(0)
}

const sessionId = flag('--session', null)
const mode = flag('--mode', 'grep')
const cli = flag('--cli', 'agy')
const timeoutSec = Number(flag('--timeout', '120')) || 120
const maxMatches = Number(flag('--max-matches', '8')) || 8
const transcriptPath = flag('--transcript', null)
const handoffDir = flag('--handoff-dir', resolveDefaultHandoffDir())

// Extract positional question (first arg not belonging to a known flag)
const valueFlags = new Set(['--session', '--mode', '--cli', '--timeout', '--max-matches', '--transcript', '--handoff-dir'])
const positionals = []
for (let i = 0; i < argv.length; i += 1) {
  if (valueFlags.has(argv[i])) {
    i += 1
    continue
  }
  if (argv[i].startsWith('--')) continue
  positionals.push(argv[i])
}
const question = positionals.join(' ').trim()

if (!sessionId || !question) {
  console.error('swarm ask: --session <id> and "<question>" are required')
  process.exit(1)
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

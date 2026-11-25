#!/usr/bin/env node
/**
 * Zero-LLM Session Handoff Card generator & reader (`swarm handoff`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveStateRoot } from './swarm-state-paths.mjs'
import {
  buildHandoffCard,
  readLatestHandoff,
  resolveDefaultHandoffDir,
  retireSession,
  writeHandoffCard
} from '../apps/api/src/toolchain/dispatch/session-handoff.js'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  console.log(`Usage: swarm handoff [options]
Options:
  --from <session_id>      Session ID to record (default: latest AGY brain session)
  --completed "<a; b>"     Semicolon-separated completed items
  --open "<a; b>"          Semicolon-separated open tasks (default: auto from queue/)
  --decisions "<a; b>"     Semicolon-separated key decisions
  --next "<a; b>"          Semicolon-separated next steps
  --read                   Read latest (or --from) handoff card instead of writing
  --retire                 Retire session (writes handoff card + records in retired-sessions.json)
  --reason <text>          Retirement reason (default: manual_retire)
  --handoff-dir <dir>      Override handoff directory
  --json                   Output JSON`)
  process.exit(0)
}

const handoffDir = flag('--handoff-dir', resolveDefaultHandoffDir())
const stateRoot = resolveStateRoot()
const mpwDir = process.env.MPW_DIR || join(homedir(), 'Code', 'multi-project-workspace')

if (has('--read')) {
  const res = readLatestHandoff(handoffDir, { sessionId: flag('--from', null) })
  if (has('--json')) {
    console.log(JSON.stringify(res, null, 2))
  } else if (!res.exists) {
    console.log('swarm handoff: no handoff card found')
  } else {
    process.stdout.write(res.content)
  }
  process.exit(0)
}

function detectHeadSha() {
  try {
    return execFileSync('git', ['-C', mpwDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function detectOpenQueueItems() {
  const items = []
  for (const [sub, filterFn, fmt] of [
    ['queue/active', (t) => t.state !== 'done', (t) => `task:${t.taskId} (${t.priority || 'P2'}, ${t.state})`],
    ['queue/cases', (c) => c.state === 'open_case', (c) => `case:${c.id} (${(c.options || []).length} opts)`]
  ]) {
    const dir = join(stateRoot, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).slice(0, 5)) {
      try {
        const obj = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (filterFn(obj)) items.push(fmt(obj))
      } catch {
        // skip invalid json
      }
    }
  }
  return items
}

const sessionId = flag('--from', `session-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const openTasks = flag('--open', null) || detectOpenQueueItems()
const headSha = detectHeadSha()

if (has('--retire')) {
  const retired = retireSession({
    handoffDir,
    sessionId,
    headSha,
    completed: flag('--completed', ''),
    openTasks,
    keyDecisions: flag('--decisions', ''),
    nextSteps: flag('--next', ''),
    reason: flag('--reason', 'manual_retire')
  })
  if (has('--json')) {
    console.log(JSON.stringify(retired, null, 2))
  } else {
    console.log(`swarm retire: retired ${retired.sessionId} -> ${retired.handoffFile} (total retired: ${retired.retiredCount})`)
  }
  process.exit(0)
}

const card = buildHandoffCard({
  sessionId,
  headSha,
  completed: flag('--completed', ''),
  openTasks,
  keyDecisions: flag('--decisions', ''),
  nextSteps: flag('--next', '')
})

const written = writeHandoffCard(handoffDir, sessionId, card)
if (has('--json')) {
  console.log(JSON.stringify({ ...written, lines: card.trim().split('\n').length }, null, 2))
} else {
  console.log(`swarm handoff: saved ${written.filePath} (${card.trim().split('\n').length} lines)`)
}

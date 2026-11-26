#!/usr/bin/env node
/**
 * Step 1 Offload: Zero-LLM Executive Brief (`swarm brief "<goal>"`).
 *
 * Combines live status, latest handoff card, local context pack, and cross-session
 * $0 grep (`ask --all`) into one bounded <=4KB brief so a parent session starts
 * with 1 read instead of 15 tool calls.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statePaths } from './swarm-state-paths.mjs'
import {
  grepAllSessionTranscripts,
  readLatestHandoff,
  resolveDefaultHandoffDir
} from '../apps/api/src/toolchain/dispatch/session-handoff.js'

export function buildExecutiveBrief({
  goal = '',
  stateRoot = statePaths().root,
  mpwDir = process.env.MPW_DIR || resolve(new URL('..', import.meta.url).pathname),
  handoffDir = resolveDefaultHandoffDir(),
  homeDir = homedir(),
  maxChars = 4000
} = {}) {
  let headSha = 'unknown'
  try {
    headSha = execFileSync('git', ['-C', mpwDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim()
  } catch {}

  const qDir = join(stateRoot, 'queue/active')
  const cDir = join(stateRoot, 'queue/cases')
  const activeTasks = existsSync(qDir)
    ? readdirSync(qDir).filter((f) => f.endsWith('.json')).map((f) => {
        try { const t = JSON.parse(readFileSync(join(qDir, f), 'utf8')); return `${t.taskId}(${t.priority || 'P2'},${t.state})` } catch { return null }
      }).filter(Boolean)
    : []
  const openCases = existsSync(cDir)
    ? readdirSync(cDir).filter((f) => f.endsWith('.json')).map((f) => {
        try { const c = JSON.parse(readFileSync(join(cDir, f), 'utf8')); return c.state === 'open_case' ? `${c.id}(${(c.options || []).length} opts)` : null } catch { return null }
      }).filter(Boolean)
    : []

  const handoff = readLatestHandoff(handoffDir)
  const historyHits = goal
    ? grepAllSessionTranscripts({ query: goal, handoffDir, homeDir, maxMatches: 4, maxCharsPerMatch: 160 })
    : { matchCount: 0, matches: [] }

  const lines = [
    `# Swarm Executive Brief (${new Date().toISOString()})`,
    `- goal: ${goal || '(general status)'}`,
    `- mpw_head: ${headSha}`,
    `- active_tasks (${activeTasks.length}): ${activeTasks.slice(0, 5).join(', ') || 'none'}`,
    `- open_cases (${openCases.length}): ${openCases.slice(0, 5).join(', ') || 'none'}`,
    '## Latest Handoff',
    ...(handoff.exists ? handoff.content.trim().split('\n').slice(0, 12) : ['- none']),
    `## Historical Session Matches (${historyHits.matchCount})`,
    ...(historyHits.matches.length
      ? historyHits.matches.map((m) => `- [${String(m.sessionId).slice(0, 8)} ${m.source}:${m.line}] ${m.snippet}`)
      : ['- none'])
  ]

  let markdown = `${lines.join('\n')}\n`
  if (markdown.length > maxChars) {
    markdown = `${markdown.slice(0, Math.max(0, maxChars - 4))}...\n`
  }

  return {
    ok: true,
    goal,
    headSha,
    activeTaskCount: activeTasks.length,
    openCaseCount: openCases.length,
    handoffSessionId: handoff.sessionId,
    historyMatchCount: historyHits.matchCount,
    chars: markdown.length,
    markdown
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: swarm brief "<goal>" [--max-chars 4000] [--json]')
    process.exit(0)
  }
  const flag = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb }
  const maxChars = Number(flag('--max-chars', '4000')) || 4000
  const positionals = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--max-chars')
  const res = buildExecutiveBrief({ goal: positionals.join(' ').trim(), maxChars })
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2))
  else process.stdout.write(res.markdown)
}

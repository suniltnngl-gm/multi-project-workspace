#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../apps/api/src/database.js'
import { loadWorkspaceEnv, resolveDatabasePath } from './env.mjs'

loadWorkspaceEnv()

export const DEFAULT_HARVEST_MODEL = 'agy@gemini-3.8-flash-medium'
export const CONSERVED_MODEL = 'agy@gemini-4-argon'
export const DEFAULT_HISTORY_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl')

export const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'completed_commits', 'next_actions', 'blockers', 'target_repo'],
  properties: {
    summary: { type: 'string' },
    completed_commits: { type: 'array', items: { type: 'string' } },
    next_actions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    target_repo: { type: 'string' },
  },
}

export const DEFAULT_HARVEST_PROMPT =
  'Summarize this session for a workspace handoff: include a concise summary, any completed_commits (SHAs or descriptions), concrete next_actions, any blockers, and the primary target_repo.'

export function resolveLatestConversationId(historyPath = DEFAULT_HISTORY_PATH) {
  if (!fs.existsSync(historyPath)) {
    throw new Error(`History file not found at ${historyPath}`)
  }
  const lines = fs
    .readFileSync(historyPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i])
      const id = entry.conversation_id || entry.conversationId || entry.id
      if (typeof id === 'string' && id.trim()) return id.trim()
    } catch {
      // Skip malformed line.
    }
  }
  throw new Error(`No conversation_id found in ${historyPath}`)
}

export function buildAgyHarvestArgs({
  conversationId,
  model = DEFAULT_HARVEST_MODEL,
  prompt = DEFAULT_HARVEST_PROMPT,
  schema = HANDOFF_SCHEMA,
}) {
  if (!conversationId || typeof conversationId !== 'string') {
    throw new Error('conversationId is required')
  }
  const args = [
    '--conversation',
    conversationId,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
  ]
  if (model) {
    args.push('--model', model)
  }
  // -p must be the final flag pair; never pass --add-dir or -c.
  args.push('-p', prompt)
  return args
}

export function parseHarvestEnvelope(rawStdout) {
  const envelope = typeof rawStdout === 'string' ? JSON.parse(rawStdout) : rawStdout
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid JSON envelope from agy')
  }
  const structured = envelope.structured_output
  if (!structured || typeof structured !== 'object') {
    throw new Error('Missing structured_output in agy JSON envelope')
  }
  return {
    conversationId: envelope.conversation_id || null,
    status: envelope.status || 'ok',
    durationSeconds: Number(envelope.duration_seconds ?? 0),
    numTurns: Number(envelope.num_turns ?? 0),
    structuredOutput: {
      summary: String(structured.summary || ''),
      completed_commits: Array.isArray(structured.completed_commits) ? structured.completed_commits.map(String) : [],
      next_actions: Array.isArray(structured.next_actions) ? structured.next_actions.map(String) : [],
      blockers: Array.isArray(structured.blockers) ? structured.blockers.map(String) : [],
      target_repo: String(structured.target_repo || ''),
    },
    rawEnvelope: envelope,
  }
}

export function ensureSessionHandoffsTable(db) {
  const sqlite = db.db || db
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      task_id INTEGER,
      target_repo TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      completed_commits_json TEXT NOT NULL DEFAULT '[]',
      next_actions_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      raw_envelope_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

export function saveSessionHandoff(db, { conversationId, taskId = null, structuredOutput, rawEnvelope }) {
  ensureSessionHandoffsTable(db)
  const sqlite = db.db || db
  const stmt = sqlite.prepare(`
    INSERT INTO session_handoffs (
      conversation_id,
      task_id,
      target_repo,
      summary,
      completed_commits_json,
      next_actions_json,
      blockers_json,
      raw_envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const info = stmt.run(
    conversationId,
    taskId,
    structuredOutput.target_repo || '',
    structuredOutput.summary || '',
    JSON.stringify(structuredOutput.completed_commits || []),
    JSON.stringify(structuredOutput.next_actions || []),
    JSON.stringify(structuredOutput.blockers || []),
    JSON.stringify(rawEnvelope || {}),
  )
  return { id: Number(info.lastInsertRowid) }
}

function parseCliArgs(argv) {
  const opts = {
    conversation: null,
    latest: false,
    task: null,
    createTask: false,
    model: DEFAULT_HARVEST_MODEL,
    allowConserve: false,
    database: null,
    json: false,
    dryRun: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--latest') opts.latest = true
    else if (a === '--create-task') opts.createTask = true
    else if (a === '--allow-conserve') opts.allowConserve = true
    else if (a === '--json') opts.json = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--conversation' && argv[i + 1]) opts.conversation = argv[++i]
    else if (a === '--task' && argv[i + 1]) opts.task = Number(argv[++i])
    else if (a === '--model' && argv[i + 1]) opts.model = argv[++i]
    else if (a === '--database' && argv[i + 1]) opts.database = argv[++i]
  }
  return opts
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(
      'Usage: ./workspace ai harvest [--conversation <id> | --latest] [--task <id>] [--create-task] [--model <m>] [--allow-conserve] [--dry-run] [--json]',
    )
    return
  }

  if (opts.model === CONSERVED_MODEL && !opts.allowConserve) {
    throw new Error(`Model ${CONSERVED_MODEL} is in [CONSERVE] mode. Pass --allow-conserve to override.`)
  }

  const conversationId = opts.conversation || (opts.latest ? resolveLatestConversationId() : null)
  if (!conversationId) {
    throw new Error('Specify --conversation <id> or --latest')
  }

  const agyArgs = buildAgyHarvestArgs({ conversationId, model: opts.model })
  if (opts.dryRun) {
    const payload = { dryRun: true, conversationId, model: opts.model, agyArgs }
    console.log(opts.json ? JSON.stringify(payload, null, 2) : `[dry-run] agy ${agyArgs.join(' ')}`)
    return
  }

  const stdout = execFileSync('agy', agyArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const parsed = parseHarvestEnvelope(stdout)
  const dbPath = resolveDatabasePath(opts.database)
  const db = createDatabase(dbPath)
  const saved = saveSessionHandoff(db, {
    conversationId: parsed.conversationId || conversationId,
    taskId: opts.task,
    structuredOutput: parsed.structuredOutput,
    rawEnvelope: parsed.rawEnvelope,
  })

  if (opts.createTask && parsed.structuredOutput.next_actions.length > 0) {
    const title = `Follow-up (${parsed.structuredOutput.target_repo || 'workspace'}): ${parsed.structuredOutput.next_actions[0]}`
    db.prepare('INSERT INTO tasks (title, status, notes) VALUES (?, ?, ?)').run(
      title,
      'todo',
      `Harvested from conversation ${conversationId}`,
    )
  }

  if (opts.json) {
    console.log(JSON.stringify({ id: saved.id, ...parsed }, null, 2))
  } else {
    console.log(`Harvested session ${conversationId} -> handoff #${saved.id}`)
    console.log(`Summary: ${parsed.structuredOutput.summary}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

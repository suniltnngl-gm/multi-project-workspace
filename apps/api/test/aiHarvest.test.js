import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { harvestClineSession } from '../../../scripts/harvest-adapters/cline.mjs'
import { harvestOpenCodeSession } from '../../../scripts/harvest-adapters/opencode.mjs'
import { harvestTranscriptFile } from '../../../scripts/harvest-adapters/transcript.mjs'
import {
  buildAgyHarvestArgs,
  HANDOFF_SCHEMA,
  parseHarvestEnvelope,
  resolveLatestConversationId,
  saveSessionHandoff,
} from '../../../scripts/ai-harvest.mjs'

test('resolveLatestConversationId picks the last valid conversation_id from history.jsonl', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-harvest-hist-'))
  const histPath = path.join(tmpDir, 'history.jsonl')
  fs.writeFileSync(
    histPath,
    [
      JSON.stringify({ conversation_id: 'conv-1', ts: 1 }),
      'not-json-line',
      JSON.stringify({ conversationId: 'conv-2', ts: 2 }),
      '',
    ].join('\n'),
    'utf8',
  )
  assert.equal(resolveLatestConversationId(histPath), 'conv-2')
})

test('buildAgyHarvestArgs enforces explicit --conversation, no --add-dir, no -c, and -p last', () => {
  const args = buildAgyHarvestArgs({
    conversationId: 'conv-123',
    model: 'agy@gemini-3.8-flash-medium',
    prompt: 'Summarize session',
  })
  assert.equal(args.includes('-c'), false)
  assert.equal(args.includes('--continue'), false)
  assert.equal(args.includes('--add-dir'), false)
  assert.equal(args[0], '--conversation')
  assert.equal(args[1], 'conv-123')
  assert.equal(args.includes('--json-schema'), true)
  assert.equal(args[args.length - 2], '-p')
  assert.equal(args[args.length - 1], 'Summarize session')
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), HANDOFF_SCHEMA)
})

test('parseHarvestEnvelope extracts structured_output and metadata', () => {
  const parsed = parseHarvestEnvelope(
    JSON.stringify({
      conversation_id: 'conv-99',
      status: 'ok',
      duration_seconds: 2.5,
      num_turns: 1,
      structured_output: {
        summary: 'Implemented harvest',
        completed_commits: ['abc1234'],
        next_actions: ['Add UI badge'],
        blockers: [],
        target_repo: 'multi-project-workspace',
      },
    }),
  )
  assert.equal(parsed.conversationId, 'conv-99')
  assert.equal(parsed.durationSeconds, 2.5)
  assert.equal(parsed.structuredOutput.summary, 'Implemented harvest')
  assert.deepEqual(parsed.structuredOutput.completed_commits, ['abc1234'])
  assert.deepEqual(parsed.structuredOutput.next_actions, ['Add UI badge'])
  assert.equal(parsed.structuredOutput.target_repo, 'multi-project-workspace')
})

test('saveSessionHandoff persists row into session_handoffs table', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-harvest-db-'))
  const db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'))
  const saved = saveSessionHandoff(db, {
    conversationId: 'conv-db-1',
    taskId: 81,
    structuredOutput: {
      summary: 'Saved handoff',
      completed_commits: ['fac19e5'],
      next_actions: ['Push branch'],
      blockers: [],
      target_repo: 'multi-project-workspace',
    },
    rawEnvelope: { conversation_id: 'conv-db-1', status: 'ok' },
  })
  assert.ok(saved.id > 0)
  const sqlite = db.db || db
  const row = sqlite.prepare('SELECT * FROM session_handoffs WHERE id = ?').get(saved.id)
  assert.equal(row.conversation_id, 'conv-db-1')
  assert.equal(row.task_id, 81)
  assert.equal(row.target_repo, 'multi-project-workspace')
  assert.equal(row.summary, 'Saved handoff')
})

test('ai-harvest CLI --dry-run --json outputs planned agy args without invoking agy', () => {
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/ai-harvest.mjs')
  const stdout = execFileSync(
    process.execPath,
    [scriptPath, '--conversation', 'conv-dry', '--dry-run', '--json'],
    { encoding: 'utf8' },
  )
  const payload = JSON.parse(stdout)
  assert.equal(payload.dryRun, true)
  assert.equal(payload.conversationId, 'conv-dry')
  assert.equal(payload.agyArgs[payload.agyArgs.length - 2], '-p')
})

test('GET /api/agents/handoffs returns [] when session_handoffs table does not exist and returns seeded rows in DESC order', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-harvest-route-'))
  const dbPath = path.join(tmpDir, 'route.sqlite')
  const database = createDatabase(dbPath)
  const server = createApp(database, { models: [] }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}`

    const emptyRes = await fetch(`${baseUrl}/api/agents/handoffs?limit=5`)
    assert.equal(emptyRes.status, 200)
    assert.deepEqual(await emptyRes.json(), [])

    const sqlite = new DatabaseSync(dbPath)
    saveSessionHandoff(sqlite, {
      conversationId: 'conv-1',
      taskId: 10,
      structuredOutput: {
        summary: 'First handoff',
        completed_commits: ['aaa1111'],
        next_actions: ['Step 1'],
        blockers: [],
        target_repo: 'multi-project-workspace',
      },
      rawEnvelope: {},
    })
    saveSessionHandoff(sqlite, {
      conversationId: 'conv-2',
      taskId: 11,
      structuredOutput: {
        summary: 'Second handoff',
        completed_commits: ['bbb2222'],
        next_actions: ['Step 2'],
        blockers: ['None'],
        target_repo: 'curl-ai-bridge',
      },
      rawEnvelope: {},
    })

    const seededRes = await fetch(`${baseUrl}/api/agents/handoffs?limit=1`)
    assert.equal(seededRes.status, 200)
    const rows = await seededRes.json()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].conversation_id, 'conv-2')
    assert.equal(rows[0].task_id, 11)
    assert.deepEqual(rows[0].completed_commits, ['bbb2222'])
    assert.deepEqual(rows[0].next_actions, ['Step 2'])
    assert.deepEqual(rows[0].blockers, ['None'])
  } finally {
    server.close()
  }
})

test('cline, opencode, and transcript adapters normalize local sessions read-only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-harvest-adapters-'))

  // Cline adapter
  const clineTasksDir = path.join(tmpDir, 'cline-tasks')
  const clineTaskDir = path.join(clineTasksDir, 'task-42')
  fs.mkdirSync(clineTaskDir, { recursive: true })
  fs.writeFileSync(
    path.join(clineTaskDir, 'api_conversation_history.json'),
    JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: 'Fix bug' }] },
      { role: 'assistant', content: [{ type: 'tool_use', input: { path: 'src/app.js' } }, { type: 'text', text: 'Fixed src/app.js' }] },
    ]),
    'utf8',
  )
  const clineOut = harvestClineSession({ tasksDir: clineTasksDir })
  assert.equal(clineOut.source_agent, 'cline')
  assert.equal(clineOut.session_id, 'task-42')
  assert.deepEqual(clineOut.files_touched, ['src/app.js'])
  assert.equal(clineOut.summary, 'Fixed src/app.js')

  // OpenCode adapter
  const opencodeDir = path.join(tmpDir, 'opencode')
  fs.mkdirSync(opencodeDir, { recursive: true })
  fs.writeFileSync(
    path.join(opencodeDir, 'oc-1.jsonl'),
    `${JSON.stringify({ role: 'assistant', content: 'OpenCode summary ready' })}\n`,
    'utf8',
  )
  const ocOut = harvestOpenCodeSession({ opencodeDir })
  assert.equal(ocOut.source_agent, 'opencode')
  assert.equal(ocOut.session_id, 'oc-1')
  assert.equal(ocOut.summary, 'OpenCode summary ready')

  // Generic transcript adapter
  const transcriptPath = path.join(tmpDir, 'gemini-chat.json')
  fs.writeFileSync(transcriptPath, JSON.stringify({ messages: [{ content: 'Gemini CLI finished' }] }), 'utf8')
  const trOut = harvestTranscriptFile({ sourceAgent: 'gemini-cli', transcriptPath })
  assert.equal(trOut.source_agent, 'gemini-cli')
  assert.equal(trOut.summary, 'Gemini CLI finished')
})

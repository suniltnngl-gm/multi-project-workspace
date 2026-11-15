import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

// Objective: Parse Cline VS Code globalStorage task history read-only into normalized session handoff payloads.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractTextFromMessages, normalizeHandoffPayload } from './common.mjs'

export const DEFAULT_CLINE_TASKS_DIR = path.join(
  os.homedir(),
  '.config',
  'Code',
  'User',
  'globalStorage',
  'saoudrizwan.claude-dev',
  'tasks',
)

export function resolveLatestClineTaskId(tasksDir = DEFAULT_CLINE_TASKS_DIR) {
  if (!fs.existsSync(tasksDir)) {
    throw new Error(`Cline tasks directory not found at ${tasksDir}`)
  }
  const dirs = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      mtimeMs: fs.statSync(path.join(tasksDir, d.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (dirs.length === 0) {
    throw new Error(`No Cline task directories found in ${tasksDir}`)
  }
  return dirs[0].name
}

export function harvestClineSession({ sessionId = null, tasksDir = DEFAULT_CLINE_TASKS_DIR } = {}) {
  const taskId = sessionId || resolveLatestClineTaskId(tasksDir)
  const taskDir = path.join(tasksDir, taskId)
  if (!fs.existsSync(taskDir)) {
    throw new Error(`Cline task directory not found: ${taskDir}`)
  }

  const historyPath = path.join(taskDir, 'api_conversation_history.json')
  const uiPath = path.join(taskDir, 'ui_messages.json')
  const messages = fs.existsSync(historyPath)
    ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
    : fs.existsSync(uiPath)
      ? JSON.parse(fs.readFileSync(uiPath, 'utf8'))
      : []

  const list = Array.isArray(messages) ? messages : []
  const texts = extractTextFromMessages(list)
  const summary = texts.length > 0 ? texts[texts.length - 1].slice(0, 280) : `Cline task ${taskId} (${list.length} messages)`

  const filesTouched = new Set()
  for (const msg of list) {
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part?.type === 'tool_use' && typeof part?.input?.path === 'string') {
          filesTouched.add(part.input.path)
        }
      }
    }
  }

  return normalizeHandoffPayload(
    {
      summary,
      files_touched: [...filesTouched],
      completed_commits: [],
      next_actions: [],
      blockers: [],
      target_repo: '',
    },
    { sourceAgent: 'cline', sessionId: taskId, modelUsed: 'cline-local' },
  )
}

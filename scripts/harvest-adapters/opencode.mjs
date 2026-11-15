import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractTextFromMessages, normalizeHandoffPayload } from './common.mjs'

export const DEFAULT_OPENCODE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode')

export function resolveLatestOpenCodeSession(opencodeDir = DEFAULT_OPENCODE_DIR) {
  if (!fs.existsSync(opencodeDir)) {
    throw new Error(`OpenCode directory not found at ${opencodeDir}`)
  }
  const files = fs
    .readdirSync(opencodeDir, { withFileTypes: true })
    .filter((f) => f.isFile() && (f.name.endsWith('.json') || f.name.endsWith('.jsonl')))
    .map((f) => ({
      name: f.name,
      fullPath: path.join(opencodeDir, f.name),
      mtimeMs: fs.statSync(path.join(opencodeDir, f.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (files.length === 0) {
    throw new Error(`No OpenCode session files found in ${opencodeDir}`)
  }
  return files[0].fullPath
}

export function harvestOpenCodeSession({ sessionId = null, opencodeDir = DEFAULT_OPENCODE_DIR } = {}) {
  const filePath = sessionId
    ? path.join(opencodeDir, sessionId.endsWith('.json') || sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.json`)
    : resolveLatestOpenCodeSession(opencodeDir)

  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenCode session file not found: ${filePath}`)
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim()
  let messages = []
  if (filePath.endsWith('.jsonl')) {
    messages = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } else {
    const parsed = JSON.parse(raw)
    messages = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.messages) ? parsed.messages : [parsed]
  }

  const texts = extractTextFromMessages(messages)
  const resolvedId = sessionId || path.basename(filePath, path.extname(filePath))
  const summary = texts.length > 0 ? texts[texts.length - 1].slice(0, 280) : `OpenCode session ${resolvedId}`

  return normalizeHandoffPayload(
    {
      summary,
      files_touched: [],
      completed_commits: [],
      next_actions: [],
      blockers: [],
      target_repo: '',
    },
    { sourceAgent: 'opencode', sessionId: resolvedId, modelUsed: 'opencode-local' },
  )
}

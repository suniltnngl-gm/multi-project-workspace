import fs from 'node:fs'
import path from 'node:path'
import { extractTextFromMessages, normalizeHandoffPayload } from './common.mjs'

export function harvestTranscriptFile({ sourceAgent = 'custom', transcriptPath, sessionId = null } = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`)
  }
  const raw = fs.readFileSync(transcriptPath, 'utf8').trim()
  let messages = []
  if (transcriptPath.endsWith('.jsonl')) {
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
  const resolvedId = sessionId || path.basename(transcriptPath, path.extname(transcriptPath))
  const summary = texts.length > 0 ? texts[texts.length - 1].slice(0, 280) : `${sourceAgent} transcript ${resolvedId}`

  return normalizeHandoffPayload(
    {
      summary,
      files_touched: [],
      completed_commits: [],
      next_actions: [],
      blockers: [],
      target_repo: '',
    },
    { sourceAgent, sessionId: resolvedId, modelUsed: 'transcript-parse' },
  )
}

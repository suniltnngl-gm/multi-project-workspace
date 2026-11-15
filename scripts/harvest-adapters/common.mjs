export const CANONICAL_HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'completed_commits', 'files_touched', 'next_actions', 'blockers', 'target_repo'],
  properties: {
    summary: { type: 'string' },
    completed_commits: { type: 'array', items: { type: 'string' } },
    files_touched: { type: 'array', items: { type: 'string' } },
    next_actions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    verification_evidence: { type: 'array', items: { type: 'string' } },
    target_repo: { type: 'string' },
  },
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

export function normalizeHandoffPayload(raw = {}, { sourceAgent = 'agy', sessionId = null, modelUsed = '' } = {}) {
  return {
    source_agent: String(sourceAgent || 'agy'),
    session_id: sessionId ? String(sessionId) : null,
    model_used: String(modelUsed || ''),
    summary: String(raw.summary || ''),
    completed_commits: toStringArray(raw.completed_commits),
    files_touched: toStringArray(raw.files_touched),
    next_actions: toStringArray(raw.next_actions),
    blockers: toStringArray(raw.blockers),
    verification_evidence: toStringArray(raw.verification_evidence),
    target_repo: String(raw.target_repo || ''),
  }
}

export function extractTextFromMessages(messages) {
  const texts = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (typeof msg.text === 'string' && msg.text.trim()) texts.push(msg.text.trim())
    else if (typeof msg.content === 'string' && msg.content.trim()) texts.push(msg.content.trim())
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part?.text === 'string' && part.text.trim()) texts.push(part.text.trim())
      }
    }
  }
  return texts
}

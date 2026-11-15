import { createHash } from 'node:crypto'

export function computeCacheFingerprint({
  profile = 'default',
  enabledPlugins = [],
  model = '',
  systemPrefix = '',
} = {}) {
  const normalizedPlugins = Array.isArray(enabledPlugins)
    ? [...new Set(enabledPlugins.map(String).filter(Boolean))].sort()
    : []
  const systemPrefixHash = createHash('sha256').update(String(systemPrefix || '')).digest('hex')
  const payload = JSON.stringify({
    profile: String(profile || 'default'),
    enabledPlugins: normalizedPlugins,
    model: String(model || ''),
    systemPrefixHash,
  })
  return createHash('sha256').update(payload).digest('hex')
}

export function detectCacheDrift({
  previousFingerprint,
  currentFingerprint,
  previousProfile = '',
  currentProfile = '',
  previousModel = '',
  currentModel = '',
} = {}) {
  if (!previousFingerprint || !currentFingerprint || previousFingerprint === currentFingerprint) {
    return { drifted: false, reasons: [] }
  }
  const reasons = []
  if (previousProfile && currentProfile && previousProfile !== currentProfile) {
    reasons.push(`profile changed (${previousProfile} -> ${currentProfile})`)
  }
  if (previousModel && currentModel && previousModel !== currentModel) {
    reasons.push(`model changed (${previousModel} -> ${currentModel})`)
  }
  if (reasons.length === 0) {
    reasons.push('plugin or system prefix fingerprint changed')
  }
  return { drifted: true, reasons }
}

export function getLatestSessionHandoff(db, { targetRepo = '' } = {}) {
  const sqlite = db?.db || db
  if (!sqlite || typeof sqlite.prepare !== 'function') return null
  try {
    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_handoffs'")
      .get()
    if (!table) return null
    const sql = targetRepo
      ? 'SELECT * FROM session_handoffs WHERE target_repo = ? ORDER BY id DESC LIMIT 1'
      : 'SELECT * FROM session_handoffs ORDER BY id DESC LIMIT 1'
    const row = targetRepo ? sqlite.prepare(sql).get(targetRepo) : sqlite.prepare(sql).get()
    if (!row) return null
    const parseArr = (raw) => {
      try {
        const parsed = JSON.parse(raw || '[]')
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      source_agent: row.source_agent || 'agy',
      target_repo: row.target_repo || '',
      summary: row.summary || '',
      completed_commits: parseArr(row.completed_commits_json),
      next_actions: parseArr(row.next_actions_json),
      blockers: parseArr(row.blockers_json),
    }
  } catch {
    return null
  }
}

export function formatCompactHandoffPrefix(handoff, { maxChars = 600 } = {}) {
  if (!handoff || typeof handoff !== 'object') return ''
  const parts = []
  const header = `[Handoff ${handoff.source_agent || 'agy'}${handoff.target_repo ? `:${handoff.target_repo}` : ''}]`
  parts.push(header)
  if (handoff.summary) parts.push(`Summary: ${String(handoff.summary).trim()}`)
  if (Array.isArray(handoff.completed_commits) && handoff.completed_commits.length > 0) {
    parts.push(`Commits: ${handoff.completed_commits.slice(0, 3).join(', ')}`)
  }
  if (Array.isArray(handoff.next_actions) && handoff.next_actions.length > 0) {
    parts.push(`Next: ${handoff.next_actions.slice(0, 3).join(' | ')}`)
  }
  if (Array.isArray(handoff.blockers) && handoff.blockers.length > 0) {
    parts.push(`Blockers: ${handoff.blockers.slice(0, 2).join(' | ')}`)
  }
  const joined = parts.join('\n')
  if (joined.length <= maxChars) return joined
  return `${joined.slice(0, Math.max(0, maxChars - 1))}…`
}

export function buildWorkerHandoffPrefix({
  database,
  model = '',
  injectHandoff = true,
  maxChars = 600,
} = {}) {
  if (!injectHandoff || !database) return ''
  const lower = String(model || '').toLowerCase()
  const isTightTpm = lower.includes('opencode') || lower.includes('groq')
  const effectiveMaxChars = isTightTpm ? Math.min(maxChars, 240) : maxChars
  const latest = getLatestSessionHandoff(database)
  return formatCompactHandoffPrefix(latest, { maxChars: effectiveMaxChars })
}

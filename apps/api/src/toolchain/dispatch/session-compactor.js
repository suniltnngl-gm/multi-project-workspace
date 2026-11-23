/**
 * Zero-LLM deterministic JSONL session compactor for swarm sessions.
 *
 * Keeps the most recent `keepRecent` turns verbatim and folds all older turns into
 * a single bounded summary record, writing atomically via `protectedWriteFile`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { protectedWriteFile } from './mutation-guard.js'

export const DEFAULT_COMPACT_THRESHOLDS = Object.freeze({
  agyBytes: 120_000,
  agyLines: 40,
  jsonlBytes: 64_000,
  jsonlLines: 12,
  rotateBytes: 160_000,
  rotateLines: 40
})

export function resolveAgyTranscriptPath(sessionId, { homeDir = homedir() } = {}) {
  if (!sessionId) return null
  return join(homeDir, '.gemini', 'antigravity-cli', 'brain', String(sessionId), '.system_generated', 'logs', 'transcript.jsonl')
}

export function inspectFileStats(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { exists: false, bytes: 0, lines: 0, mtimeMs: 0, path: filePath || null }
  }
  const st = statSync(filePath)
  const text = readFileSync(filePath, 'utf8')
  const lines = text ? text.split(/\r?\n/).filter(Boolean).length : 0
  return { exists: true, bytes: st.size, lines, mtimeMs: st.mtimeMs, path: filePath }
}

/**
 * Zero-LLM policy evaluator for intelligent swarm compaction & session rotation.
 * - `agy` (resumed): prefixes `/compact ` when transcript exceeds thresholds.
 * - `local-jsonl`: compacts JSONL deterministically via `compactSessionFile`.
 * - Other persistent CLIs: rotates to a fresh session (seeded with wakeup/pack) when oversized.
 */
export function evaluateSessionCompaction({
  cli,
  sessionId = null,
  transcriptPath = null,
  homeDir = homedir(),
  thresholds = DEFAULT_COMPACT_THRESHOLDS
} = {}) {
  const t = { ...DEFAULT_COMPACT_THRESHOLDS, ...(thresholds || {}) }
  if (cli === 'agy') {
    const target = transcriptPath || resolveAgyTranscriptPath(sessionId, { homeDir })
    const stats = inspectFileStats(target)
    if (!stats.exists) return { action: 'none', reason: 'transcript_not_found', ...stats }
    if (stats.bytes >= t.agyBytes || stats.lines >= t.agyLines) {
      return { action: 'compact_prefix', reason: stats.bytes >= t.agyBytes ? 'agy_bytes_threshold' : 'agy_lines_threshold', ...stats }
    }
    return { action: 'none', reason: 'within_threshold', ...stats }
  }
  if (cli === 'local-jsonl') {
    const stats = inspectFileStats(transcriptPath)
    if (!stats.exists) return { action: 'none', reason: 'jsonl_not_found', ...stats }
    if (stats.bytes >= t.jsonlBytes || stats.lines >= t.jsonlLines) {
      return { action: 'compact_jsonl', reason: stats.bytes >= t.jsonlBytes ? 'jsonl_bytes_threshold' : 'jsonl_lines_threshold', ...stats }
    }
    return { action: 'none', reason: 'within_threshold', ...stats }
  }
  if (transcriptPath) {
    const stats = inspectFileStats(transcriptPath)
    if (!stats.exists) return { action: 'none', reason: 'transcript_not_found', ...stats }
    if (stats.bytes >= t.rotateBytes || stats.lines >= t.rotateLines) {
      return { action: 'rotate_session', reason: stats.bytes >= t.rotateBytes ? 'rotate_bytes_threshold' : 'rotate_lines_threshold', ...stats }
    }
    return { action: 'none', reason: 'within_threshold', ...stats }
  }
  return { action: 'none', reason: 'no_transcript_path', exists: false, bytes: 0, lines: 0, mtimeMs: 0, path: null }
}

export function applyCompactPrefix(prompt, action) {
  const text = String(prompt || '')
  if (action !== 'compact_prefix') return text
  if (/^\s*\/compact(\s|$)/.test(text)) return text
  return `/compact ${text}`
}

export function scanAndCompactLocalSessions(sessionsDir, { keepRecent = 4, maxSummaryChars = 1200, minLines = 12, apply = false } = {}) {
  if (!sessionsDir || !existsSync(sessionsDir)) return []
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).sort()
  const results = []
  for (const name of files) {
    const filePath = join(sessionsDir, name)
    const stats = inspectFileStats(filePath)
    if (stats.lines < minLines) {
      results.push({ filePath, skipped: true, reason: 'below_min_lines', lines: stats.lines, compacted: false })
      continue
    }
    results.push(compactSessionFile(filePath, { keepRecent, maxSummaryChars, apply }))
  }
  return results
}

export function parseJsonl(text) {
  return String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
}

export function compactTurns(turns, { keepRecent = 4, maxSummaryChars = 1200 } = {}) {
  const list = Array.isArray(turns) ? turns : []
  if (list.length <= keepRecent) {
    return { compacted: false, beforeCount: list.length, afterCount: list.length, foldedCount: 0, turns: list }
  }
  const older = list.slice(0, list.length - keepRecent)
  const recent = list.slice(-keepRecent)

  const bullets = older.map((t, idx) => {
    const p = String(t.prompt || t.summary || '').replace(/\s+/g, ' ').trim().slice(0, 100)
    const r = String(t.reply || t.status || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return `${idx + 1}. ${p}${r ? ` -> ${r}` : ''}`
  })
  let summaryText = bullets.join(' | ')
  if (summaryText.length > maxSummaryChars) {
    summaryText = `${summaryText.slice(0, Math.max(0, maxSummaryChars - 3))}...`
  }

  const summaryRecord = {
    role: 'summary',
    compactedTurns: older.length,
    prompt: '[COMPACTED_HISTORY]',
    reply: summaryText,
    compactedAt: new Date().toISOString()
  }

  const next = [summaryRecord, ...recent]
  return {
    compacted: true,
    beforeCount: list.length,
    afterCount: next.length,
    foldedCount: older.length,
    turns: next
  }
}

export function compactSessionFile(filePath, { keepRecent = 4, maxSummaryChars = 1200, apply = false } = {}) {
  if (!existsSync(filePath)) {
    return { ok: false, reason: `session_file_not_found:${filePath}` }
  }
  const turns = parseJsonl(readFileSync(filePath, 'utf8'))
  const res = compactTurns(turns, { keepRecent, maxSummaryChars })
  let backupPath = null
  if (apply && res.compacted) {
    const content = `${res.turns.map((t) => JSON.stringify(t)).join('\n')}\n`
    const written = protectedWriteFile(filePath, content)
    backupPath = written.backupPath
  }
  return {
    ok: true,
    apply,
    filePath,
    compacted: res.compacted,
    beforeCount: res.beforeCount,
    afterCount: res.afterCount,
    foldedCount: res.foldedCount,
    backupPath
  }
}

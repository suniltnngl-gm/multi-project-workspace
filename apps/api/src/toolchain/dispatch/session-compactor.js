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
  agyBytes: 60_000,
  agyLines: 20,
  jsonlBytes: 32_000,
  jsonlLines: 10,
  rotateBytes: 80_000,
  rotateLines: 20,
  cacheTtlMs: 15 * 60 * 1000,
  cacheMinBytes: 16_000
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
  nowMs = Date.now(),
  thresholds = DEFAULT_COMPACT_THRESHOLDS
} = {}) {
  const t = { ...DEFAULT_COMPACT_THRESHOLDS, ...(thresholds || {}) }
  const isCacheExpired = (stats) =>
    t.cacheTtlMs > 0 && stats.mtimeMs > 0 && (nowMs - stats.mtimeMs) >= t.cacheTtlMs && stats.bytes >= t.cacheMinBytes

  if (cli === 'agy') {
    const target = transcriptPath || resolveAgyTranscriptPath(sessionId, { homeDir })
    const stats = inspectFileStats(target)
    if (!stats.exists) return { action: 'none', reason: 'transcript_not_found', ...stats }
    if (isCacheExpired(stats)) {
      return { action: 'rotate_session', reason: 'cache_ttl_expired', ...stats }
    }
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
    if (isCacheExpired(stats)) {
      return { action: 'rotate_session', reason: 'cache_ttl_expired', ...stats }
    }
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

/**
 * W6 (#295): canonical envelopes are durable structured state, not prose —
 * they survive compaction verbatim. Only schema-tagged records are protected,
 * so plain turns still fold normally.
 */
export function isCanonicalEnvelope(turn) {
  return Boolean(turn && typeof turn === 'object' && typeof turn.schema === 'string' && turn.schema.includes('/v'))
}

export function compactTurns(turns, { keepRecent = 4, maxSummaryChars = 1200, now = () => new Date().toISOString() } = {}) {
  const list = Array.isArray(turns) ? turns : []
  if (list.length <= keepRecent) {
    return { compacted: false, beforeCount: list.length, afterCount: list.length, foldedCount: 0, turns: list, preservedEnvelopes: 0 }
  }
  // W6: envelopes are never folded — they are the reconstruction payload.
  const protectedTurns = list.filter(isCanonicalEnvelope)
  const foldable = list.filter((t) => !isCanonicalEnvelope(t))
  const older = foldable.slice(0, Math.max(0, foldable.length - keepRecent))
  const recent = foldable.slice(-keepRecent)

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
    compactedAt: now()
  }

  // Order preserved: envelopes keep their original positions relative to the
  // compacted prose; the summary leads.
  const next = [summaryRecord, ...recent, ...protectedTurns.filter((t) => !recent.includes(t))]
  return {
    compacted: true,
    beforeCount: list.length,
    afterCount: next.length,
    foldedCount: older.length,
    preservedEnvelopes: protectedTurns.length,
    turns: next
  }
}

/**
 * W6 (#295): compaction integrity check — every canonical envelope in the
 * original must survive in the compacted output, byte-for-byte in content.
 * A violation means the compaction was lossy for structured state: fail closed.
 */
export function verifyCompactionIntegrity(originalTurns, compactedTurns) {
  const keyOf = (t) => JSON.stringify(t)
  const surviving = new Set((Array.isArray(compactedTurns) ? compactedTurns : []).map(keyOf))
  const envelopes = (Array.isArray(originalTurns) ? originalTurns : []).filter(isCanonicalEnvelope)
  const lost = envelopes.filter((t) => !surviving.has(keyOf(t)))
  return {
    ok: lost.length === 0,
    envelopesTotal: envelopes.length,
    preservedCount: envelopes.length - lost.length,
    lost: lost.map((t) => t.schema)
  }
}

/**
 * W6 (#295): context budgeter — deterministic verdict + prune advice, driven by
 * thresholds and translation-usage stats (adapters at 100% ok-rate are healthy,
 * so their hot session context is a prune candidate, not a keeper).
 */
export function contextBudget({ bytes = 0, lines = 0, thresholds = DEFAULT_COMPACT_THRESHOLDS, usageAdapters = [] } = {}) {
  const byteBudget = thresholds.jsonlBytes
  const withinBudget = bytes <= byteBudget && lines <= thresholds.jsonlLines
  const pruneCandidates = usageAdapters
    .filter((a) => a.okRate >= 1 && a.total >= 3)
    .map((a) => `${a.kind}:${a.adapter}`)
  return {
    bytes,
    lines,
    byteBudget,
    withinBudget,
    verdict: withinBudget ? 'within_budget' : bytes > byteBudget ? 'over_byte_budget' : 'over_line_budget',
    pruneCandidates
  }
}

export function compactSessionFile(filePath, { keepRecent = 4, maxSummaryChars = 1200, apply = false } = {}) {
  if (!existsSync(filePath)) {
    return { ok: false, reason: `session_file_not_found:${filePath}` }
  }
  const turns = parseJsonl(readFileSync(filePath, 'utf8'))
  const res = compactTurns(turns, { keepRecent, maxSummaryChars })
  const integrity = verifyCompactionIntegrity(turns, res.turns)
  let backupPath = null
  if (apply && res.compacted) {
    // W6: fail closed — never write a compaction that loses canonical envelopes.
    if (!integrity.ok) {
      return { ok: false, apply, filePath, reason: 'compaction_integrity_violation', integrity }
    }
    const content = `${res.turns.map((t) => JSON.stringify(t)).join('\n')}\n`
    const written = protectedWriteFile(filePath, content)
    backupPath = written.backupPath
  }
  const stats = inspectFileStats(filePath)
  return {
    ok: true,
    apply,
    filePath,
    compacted: res.compacted,
    beforeCount: res.beforeCount,
    afterCount: res.afterCount,
    foldedCount: res.foldedCount,
    preservedEnvelopes: res.preservedEnvelopes || 0,
    integrity,
    budget: contextBudget({ bytes: stats.bytes, lines: stats.lines, thresholds: DEFAULT_COMPACT_THRESHOLDS }),
    backupPath
  }
}

/**
 * Zero-LLM deterministic JSONL session compactor for swarm sessions.
 *
 * Keeps the most recent `keepRecent` turns verbatim and folds all older turns into
 * a single bounded summary record, writing atomically via `protectedWriteFile`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { protectedWriteFile } from './mutation-guard.js'

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

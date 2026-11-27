/**
 * Cross-session handoff cards and read-only old-session querying for the swarm.
 *
 * Implements the 4-tier escalation pattern:
 * - Tier 0: Canonical state (wakeup / handoff card)
 * - Tier 1: Zero-LLM local grep over handoff cards + old session transcripts
 * - Tier 2: Bounded read-only headless LLM query (with >60KB bloat warning)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { protectedWriteFile } from './mutation-guard.js'
import { DEFAULT_COMPACT_THRESHOLDS, inspectFileStats, resolveAgyTranscriptPath } from './session-compactor.js'

export const MAX_HANDOFF_LINES = 30

export function resolveDefaultHandoffDir({ stateRoot = process.env.SWARM_STATE_ROOT, homeDir = homedir() } = {}) {
  const root = stateRoot || join(homeDir, '.local', 'state', 'curl-ai-bridge')
  return join(root, 'handoffs')
}

export function sanitizeSessionId(sessionId) {
  return String(sessionId || 'unknown')
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80)
}

const DUMMY_SECRET_VALUES = new Set([
  'secret-value',
  'transport-secret',
  'must-not-be-copied',
  'not-a-real-secret',
  'changeme',
  'change-me',
  'placeholder',
  'example',
  'sample',
  'dummy',
  'redacted',
  'your-key',
  'your-api-key',
  'your-token',
  'test-value',
  'xxx'
])

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
const TOKEN_PREFIX_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g
const DSN_PASSWORD_PATTERN = /(:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g
const BEARER_PATTERN = /(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi
const SECRET_ASSIGNMENT_PATTERN = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*['"]?)([^\s'",;]+)/gi

function isPlaceholderValue(value) {
  const normalized = value.replace(/^['"]|['"]$/g, '').toLowerCase()
  if (DUMMY_SECRET_VALUES.has(normalized)) return true
  return /^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|x{3,}|\*{3,})$/.test(normalized)
}

function isCodeOrSchemaValue(value) {
  if (value.startsWith('//')) return true
  if (/[()[\]{}]/.test(value)) return true
  return /\b(?:validate|assert|String|JSON|process|require|import)\b/.test(value)
}

function hasCredentialEntropy(value) {
  if (value.length < 12) return false
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) return true
  if (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) return true
  return /[+/=]/.test(value) && /[A-Za-z0-9]/.test(value)
}

function shouldRedactValue(value) {
  if (!value || isPlaceholderValue(value) || isCodeOrSchemaValue(value)) return false
  return hasCredentialEntropy(value)
}

function redactLine(line) {
  let out = line
  out = out.replace(PRIVATE_KEY_PATTERN, '[REDACTED]')
  out = out.replace(TOKEN_PREFIX_PATTERN, '[REDACTED]')
  out = out.replace(BEARER_PATTERN, (match, prefix, token) => shouldRedactValue(token) ? `${prefix}[REDACTED]` : match)
  out = out.replace(DSN_PASSWORD_PATTERN, (match, prefix, password, suffix) => `${prefix}[REDACTED]${suffix}`)
  out = out.replace(SECRET_ASSIGNMENT_PATTERN, (match, prefix, value) => shouldRedactValue(value) ? `${prefix}[REDACTED]` : match)
  return out
}

/** Redact credential-shaped values without flagging fixtures, schemas, identifiers or prose. */
export function redactSecrets(text) {
  return String(text || '').replace(/[^\r\n]+/g, redactLine)
}

function toBullets(items, maxItems = 5) {
  const list = Array.isArray(items)
    ? items
    : typeof items === 'string' && items.trim()
      ? items.split(/\s*;\s*|\r?\n/).map((s) => s.trim()).filter(Boolean)
      : []
  if (!list.length) return ['- none']
  return list.slice(0, maxItems).map((item) => `- ${String(item).replace(/\s+/g, ' ').trim().slice(0, 160)}`)
}

/**
 * Build a bounded <=30-line markdown Session Handoff Card.
 */
export function buildHandoffCard({
  sessionId = 'unknown',
  headSha = 'unknown',
  createdAt = new Date().toISOString(),
  completed = [],
  openTasks = [],
  keyDecisions = [],
  nextSteps = []
} = {}) {
  const lines = [
    `# Session Handoff: ${sanitizeSessionId(sessionId)}`,
    `- created_at: ${createdAt}`,
    `- head_sha: ${headSha}`,
    '## Completed',
    ...toBullets(completed, 5),
    '## Open Tasks / Cases',
    ...toBullets(openTasks, 5),
    '## Key Decisions',
    ...toBullets(keyDecisions, 4),
    '## Next Steps',
    ...toBullets(nextSteps, 4)
  ]
  return `${lines.slice(0, MAX_HANDOFF_LINES).join('\n')}\n`
}

export function writeHandoffCard(handoffDir, sessionId, cardContent) {
  mkdirSync(handoffDir, { recursive: true, mode: 0o700 })
  const safeId = sanitizeSessionId(sessionId)
  const filePath = join(handoffDir, `${safeId}.md`)
  const written = protectedWriteFile(filePath, String(cardContent || ''))
  return { ok: true, filePath, sessionId: safeId, backupPath: written.backupPath }
}

/**
 * Retire a session cleanly: writes its handoff card and records it in retired-sessions.json
 * so new sessions start from the handoff card and only query the old session via `swarm ask`.
 */
export function retireSession({
  handoffDir = resolveDefaultHandoffDir(),
  sessionId,
  headSha = 'unknown',
  completed = [],
  openTasks = [],
  keyDecisions = [],
  nextSteps = [],
  reason = 'manual_retire'
} = {}) {
  const safeId = sanitizeSessionId(sessionId)
  const card = buildHandoffCard({ sessionId: safeId, headSha, completed, openTasks, keyDecisions, nextSteps })
  const handoff = writeHandoffCard(handoffDir, safeId, card)

  const ledgerPath = join(handoffDir, 'retired-sessions.json')
  let ledger = { retired: [] }
  if (existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      if (Array.isArray(parsed?.retired)) ledger = parsed
    } catch {
      // reset malformed ledger
    }
  }
  const entry = {
    sessionId: safeId,
    retiredAt: new Date().toISOString(),
    reason,
    headSha,
    handoffFile: handoff.filePath
  }
  ledger.retired = [...ledger.retired.filter((r) => r.sessionId !== safeId), entry]
  protectedWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
  return { ok: true, sessionId: safeId, handoffFile: handoff.filePath, ledgerPath, retiredCount: ledger.retired.length }
}

export function readLatestHandoff(handoffDir, { sessionId = null } = {}) {
  if (!handoffDir || !existsSync(handoffDir)) {
    return { exists: false, filePath: null, sessionId: null, content: '', mtimeMs: 0 }
  }
  if (sessionId) {
    const safeId = sanitizeSessionId(sessionId)
    const exact = join(handoffDir, `${safeId}.md`)
    if (existsSync(exact)) {
      const st = statSync(exact)
      return { exists: true, filePath: exact, sessionId: safeId, content: readFileSync(exact, 'utf8'), mtimeMs: st.mtimeMs }
    }
    const prefixMatch = readdirSync(handoffDir).find((f) => f.endsWith('.md') && f.startsWith(safeId))
    if (prefixMatch) {
      const fp = join(handoffDir, prefixMatch)
      const st = statSync(fp)
      return { exists: true, filePath: fp, sessionId: prefixMatch.replace(/\.md$/, ''), content: readFileSync(fp, 'utf8'), mtimeMs: st.mtimeMs }
    }
    return { exists: false, filePath: null, sessionId: safeId, content: '', mtimeMs: 0 }
  }
  const files = readdirSync(handoffDir).filter((f) => f.endsWith('.md'))
  let newest = null
  for (const name of files) {
    const fp = join(handoffDir, name)
    const st = statSync(fp)
    if (!newest || st.mtimeMs > newest.mtimeMs) {
      newest = { filePath: fp, sessionId: name.replace(/\.md$/, ''), mtimeMs: st.mtimeMs }
    }
  }
  if (!newest) return { exists: false, filePath: null, sessionId: null, content: '', mtimeMs: 0 }
  return { exists: true, ...newest, content: readFileSync(newest.filePath, 'utf8') }
}

/**
 * Tier 1 zero-LLM grep across a session's handoff card and local transcript.
 */
export function grepSessionTranscript({
  sessionId,
  query,
  transcriptPath = null,
  handoffDir = resolveDefaultHandoffDir(),
  homeDir = homedir(),
  maxMatches = 8,
  maxCharsPerMatch = 220
} = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9._:/-]/g, ''))
    .filter((t) => t.length >= 2)

  const matches = []
  const pushMatch = (source, lineNo, text) => {
    if (matches.length >= maxMatches) return
    const clean = redactSecrets(String(text || '').replace(/\s+/g, ' ').trim())
    if (!clean) return
    matches.push({
      source,
      line: lineNo,
      snippet: clean.length > maxCharsPerMatch ? `${clean.slice(0, maxCharsPerMatch - 3)}...` : clean
    })
  }

  const lineMatches = (line) => {
    if (!terms.length) return true
    const lower = line.toLowerCase()
    return terms.some((t) => lower.includes(t))
  }

  // 1. Check handoff card first
  const handoff = readLatestHandoff(handoffDir, { sessionId })
  if (handoff.exists) {
    const hLines = handoff.content.split(/\r?\n/)
    hLines.forEach((line, idx) => {
      if (lineMatches(line)) pushMatch('handoff', idx + 1, line)
    })
  }

  // 2. Check transcript.jsonl (or explicit transcriptPath)
  const target = transcriptPath || resolveAgyTranscriptPath(sessionId, { homeDir })
  const stats = inspectFileStats(target)
  if (stats.exists) {
    const tLines = readFileSync(target, 'utf8').split(/\r?\n/)
    // Scan newest-first so recent decisions surface first
    for (let i = tLines.length - 1; i >= 0 && matches.length < maxMatches; i -= 1) {
      const raw = tLines[i]
      if (!raw) continue
      if (lineMatches(raw)) {
        let display = raw
        try {
          const obj = JSON.parse(raw)
          const role = obj.role || obj.type || ''
          const content = obj.content || obj.text || obj.message || ''
          const flat = Array.isArray(content)
            ? content.map((c) => (typeof c === 'object' && c ? c.text || JSON.stringify(c) : String(c))).join(' ')
            : String(content)
          if (flat.trim()) display = `${role ? `[${role}] ` : ''}${flat}`
        } catch {
          // keep raw line
        }
        pushMatch('transcript', i + 1, display)
      }
    }
  }

  return {
    ok: true,
    mode: 'grep',
    sessionId,
    query,
    terms,
    handoffFound: handoff.exists,
    transcriptStats: stats,
    sizeWarning: stats.exists && stats.bytes >= DEFAULT_COMPACT_THRESHOLDS.agyBytes,
    matchCount: matches.length,
    matches
  }
}

/**
 * Tier 1 zero-LLM grep across ALL handoff cards and AGY session transcripts (newest-first).
 */
export function grepAllSessionTranscripts({
  query,
  handoffDir = resolveDefaultHandoffDir(),
  homeDir = homedir(),
  maxMatches = 12,
  maxCharsPerMatch = 220
} = {}) {
  const candidates = new Map()
  if (handoffDir && existsSync(handoffDir)) {
    for (const f of readdirSync(handoffDir).filter((x) => x.endsWith('.md'))) {
      const id = f.replace(/\.md$/, '')
      const st = statSync(join(handoffDir, f))
      candidates.set(id, Math.max(candidates.get(id) || 0, st.mtimeMs))
    }
  }
  const brainDir = join(homeDir, '.gemini', 'antigravity-cli', 'brain')
  if (existsSync(brainDir)) {
    for (const id of readdirSync(brainDir)) {
      const tp = resolveAgyTranscriptPath(id, { homeDir })
      if (tp && existsSync(tp)) {
        const st = statSync(tp)
        candidates.set(id, Math.max(candidates.get(id) || 0, st.mtimeMs))
      }
    }
  }
  const sortedIds = [...candidates.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const matches = []
  let sessionsScanned = 0
  for (const sessionId of sortedIds) {
    if (matches.length >= maxMatches) break
    sessionsScanned += 1
    const res = grepSessionTranscript({
      sessionId,
      query,
      handoffDir,
      homeDir,
      maxMatches: Math.min(3, maxMatches - matches.length),
      maxCharsPerMatch
    })
    for (const m of res.matches) {
      matches.push({ sessionId, ...m })
      if (matches.length >= maxMatches) break
    }
  }
  return {
    ok: true,
    mode: 'grep-all',
    query,
    sessionsScanned,
    totalSessions: sortedIds.length,
    matchCount: matches.length,
    matches
  }
}

/**
 * Tier 2 bounded read-only headless LLM query command builder.
 */
export function buildReadOnlyAskCommand({
  sessionId,
  question,
  cli = 'agy',
  timeoutSec = 120,
  homeDir = homedir(),
  transcriptPath = null
} = {}) {
  if (!sessionId) throw new Error('sessionId is required')
  if (!question || !String(question).trim()) throw new Error('question is required')

  const wrappedPrompt = [
    'READ-ONLY CLARIFICATION (do NOT edit files, do NOT run tools).',
    String(question).trim(),
    'Reply concisely in <=5 bullets.'
  ].join(' ')

  const target = transcriptPath || (cli === 'agy' ? resolveAgyTranscriptPath(sessionId, { homeDir }) : null)
  const stats = inspectFileStats(target)
  const sizeWarning = stats.exists && stats.bytes >= DEFAULT_COMPACT_THRESHOLDS.agyBytes

  if (cli !== 'agy') {
    throw new Error(`Unsupported cli for direct read-only resume: ${cli} (use --mode grep for $0 search)`)
  }

  return {
    command: 'agy',
    args: ['--conversation', String(sessionId), '--print-timeout', `${Number(timeoutSec) || 120}s`, '-p', wrappedPrompt],
    prompt: wrappedPrompt,
    stats,
    sizeWarning
  }
}

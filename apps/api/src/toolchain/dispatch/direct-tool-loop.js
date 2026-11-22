/**
 * Lightweight zero-dependency tool-calling loop (<30 MB RAM) for direct HTTP/CLI
 * endpoints (cloudflare-workers-ai, vercel-ai-gateway, llm7, local-llama, colab, kaggle).
 *
 * Safety:
 * - Strictly allowlisted tools: `read_file`, `git_grep`, and opt-in `protected_write`
 * - Path traversal outside `repoDir` is rejected fail-closed
 * - Writes default to disabled (`allowWrites: false`) and always use `protectedWriteFile`
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { protectedWriteFile } from './mutation-guard.js'

const TOOL_SYSTEM_PROMPT = [
  'You have allowlisted local tools. To call a tool, reply ONLY with a JSON object:',
  '{"tool":"read_file","args":{"path":"relative/path"}}',
  '{"tool":"git_grep","args":{"query":"symbol"}}',
  '{"tool":"protected_write","args":{"path":"relative/path","content":"..."}}',
  'Otherwise reply directly with your final answer.'
].join('\n')

function safeResolve(repoDir, relPath) {
  const root = resolve(repoDir)
  const target = resolve(root, String(relPath || ''))
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`path_outside_repo:${relPath}`)
  }
  return target
}

export function parseToolCall(text) {
  if (text && typeof text === 'object' && typeof text.tool === 'string' && text.args && typeof text.args === 'object') {
    return { tool: text.tool, args: text.args }
  }
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj.tool === 'string' && obj.args && typeof obj.args === 'object') {
      return { tool: obj.tool, args: obj.args }
    }
  } catch {}
  return null
}

export function executeToolCall({ tool, args }, { repoDir = process.cwd(), allowWrites = false } = {}) {
  if (tool === 'read_file') {
    const abs = safeResolve(repoDir, args.path)
    if (!existsSync(abs)) return { ok: false, error: `file_not_found:${args.path}` }
    const content = readFileSync(abs, 'utf8')
    return { ok: true, content: content.slice(0, 4000), truncated: content.length > 4000 }
  }
  if (tool === 'git_grep') {
    const q = String(args.query || '').trim()
    if (!q) return { ok: false, error: 'query_required' }
    try {
      const out = execFileSync('git', ['-C', resolve(repoDir), 'grep', '-n', '-I', '--max-count', '5', q], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim()
      return { ok: true, matches: out.split(/\r?\n/).slice(0, 20) }
    } catch {
      return { ok: true, matches: [] }
    }
  }
  if (tool === 'protected_write') {
    if (!allowWrites) return { ok: false, error: 'writes_disabled_in_read_only_mode' }
    const abs = safeResolve(repoDir, args.path)
    const res = protectedWriteFile(abs, String(args.content ?? ''))
    return { ok: true, path: args.path, backupPath: res.backupPath }
  }
  return { ok: false, error: `tool_not_allowlisted:${tool}` }
}

export async function runDirectToolLoop({
  callModel,
  prompt,
  repoDir = process.cwd(),
  maxTurns = 4,
  allowWrites = false
}) {
  const messages = [
    { role: 'system', content: TOOL_SYSTEM_PROMPT },
    { role: 'user', content: String(prompt || '') }
  ]
  const trace = []
  for (let turn = 1; turn <= maxTurns; turn++) {
    const rawReply = await callModel(messages)
    const call = parseToolCall(rawReply)
    const reply = typeof rawReply === 'string' ? rawReply : JSON.stringify(rawReply ?? '')
    if (!call) {
      return { ok: true, turns: turn, finalAnswer: reply, trace }
    }
    const result = executeToolCall(call, { repoDir, allowWrites })
    trace.push({ turn, tool: call.tool, ok: result.ok })
    messages.push({ role: 'assistant', content: reply })
    messages.push({ role: 'user', content: `TOOL_RESULT(${call.tool}): ${JSON.stringify(result)}` })
  }
  return { ok: false, turns: maxTurns, reason: 'max_turns_reached', finalAnswer: null, trace }
}

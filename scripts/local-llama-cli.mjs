#!/usr/bin/env node
/**
 * Minimal resource-gated CLI wrapper for local llama.cpp GGUF models (Task #172).
 *
 * Features:
 * - Optional config at ~/.config/local-llama-cli/config.json (env: LOCAL_LLAMA_CONFIG)
 * - Micro-skill injection via --skill <file.md>
 * - Rolling bounded session memory via --session <id> (last 4 turns in JSONL; zero writes in --dry-run)
 * - --prompt-file <path> or --prompt <text>
 * - Defaults to --dry-run (no spawn). Pass --execute to invoke `llama-cli --single-turn`
 *   with stdin closed (/dev/null) after passing the SP-004 host resource gate.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gatherTelemetry } from '../apps/api/src/toolchain/dispatch/host-telemetry.js'
import { evaluateResourceGate } from '../apps/api/src/toolchain/dispatch/resource-gate.js'

const MODELS_DIR = process.env.LLAMA_MODELS_DIR || join(homedir(), '.local/share/llama.cpp/models')
const DEFAULT_CONFIG_PATH = process.env.LOCAL_LLAMA_CONFIG || join(homedir(), '.config/local-llama-cli/config.json')
const DEFAULT_SESSIONS_DIR = process.env.LOCAL_LLAMA_SESSIONS_DIR || join(homedir(), '.local/state/local-llama-cli/sessions')
const MAX_HISTORY_TURNS = 4

export const LOCAL_LLAMA_MODELS = Object.freeze({
  '0.5b': { file: 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf', minFreeMemoryMb: 1536 },
  '1.5b': { file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf', minFreeMemoryMb: 2048 }
})

export function loadLocalLlamaConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!configPath || !existsSync(configPath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function sanitizeSessionId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  return clean || null
}

export function loadSessionHistory(sessionId, sessionsDir = DEFAULT_SESSIONS_DIR, maxTurns = MAX_HISTORY_TURNS) {
  const safe = sanitizeSessionId(sessionId)
  if (!safe) return []
  const file = join(sessionsDir, `${safe}.jsonl`)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  const records = []
  for (const l of lines) {
    try { records.push(JSON.parse(l)) } catch {}
  }
  return records.slice(-maxTurns)
}

export function appendSessionTurn(sessionId, turn, sessionsDir = DEFAULT_SESSIONS_DIR) {
  const safe = sanitizeSessionId(sessionId)
  if (!safe) return null
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
  const file = join(sessionsDir, `${safe}.jsonl`)
  appendFileSync(file, `${JSON.stringify({ ...turn, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

export function composePrompt({ skillText = '', history = [], prompt }) {
  const parts = []
  if (skillText && skillText.trim()) parts.push(`[SKILL]\n${skillText.trim()}`)
  if (Array.isArray(history) && history.length > 0) {
    const hist = history.map((h) => `User: ${h.prompt}\nAssistant: ${h.reply}`).join('\n')
    parts.push(`[HISTORY]\n${hist}`)
  }
  parts.push(String(prompt || '').trim())
  return parts.join('\n\n')
}

export function stripLlamaBanner(raw) {
  const text = String(raw || '')
  const marker = text.lastIndexOf('\n> ')
  const slice = marker >= 0 ? text.slice(marker + 3) : text
  const lines = slice.split(/\r?\n/)
  const body = marker >= 0 ? lines.slice(1) : lines
  return body
    .filter((l) => !/^\[ Prompt:/.test(l.trim()) && l.trim() !== 'Exiting...')
    .join('\n')
    .trim()
}

const argv = process.argv.slice(2)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/local-llama-cli.mjs [options]
  -m, --model <0.5b|1.5b>   Local GGUF model alias (default: 0.5b)
  -p, --prompt <text>       Prompt text
      --prompt-file <path>  Read prompt from file
      --skill <file.md>     Inject micro-skill markdown
      --session <id>        Rolling 4-turn JSONL session memory
  -n, --max-tokens <n>      Max generation tokens (default: 128)
  -t, --threads <n>         CPU threads (default: 4)
      --dry-run             Plan only, no spawn (default)
      --execute             Run llama-cli --single-turn after resource gate
      --json                Output JSON
  -h, --help                Show this help
`)
    process.exit(0)
  }
  const cfg = loadLocalLlamaConfig()
  const opts = {
    model: cfg.defaultModel || '0.5b',
    maxTokens: String(cfg.maxTokens || '128'),
    threads: String(cfg.threads || '4'),
    json: false,
    execute: false,
    session: null,
    skill: null,
    promptFile: null,
    prompt: null
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--dry-run') opts.execute = false
    else if (a === '--model' || a === '-m') opts.model = argv[++i]
    else if (a === '--prompt' || a === '-p') opts.prompt = argv[++i]
    else if (a === '--prompt-file') opts.promptFile = argv[++i]
    else if (a === '--skill') opts.skill = argv[++i]
    else if (a === '--session') opts.session = argv[++i]
    else if (a === '--max-tokens' || a === '-n') opts.maxTokens = argv[++i]
    else if (a === '--threads' || a === '-t') opts.threads = argv[++i]
  }

  const fail = (reason, code = 1) => {
    const payload = { ok: false, reason, cliArtifactBoundary: { mergeNativeArtifacts: false } }
    process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `local-llama-cli: ${reason}\n`)
    process.exit(code)
  }

  const spec = LOCAL_LLAMA_MODELS[opts.model]
  if (!spec) fail(`unknown_model:${opts.model} (expected 0.5b|1.5b)`)

  let rawPrompt = opts.prompt
  if (opts.promptFile) {
    if (!existsSync(opts.promptFile)) fail(`prompt_file_not_found:${opts.promptFile}`)
    rawPrompt = readFileSync(opts.promptFile, 'utf8')
  }
  if (!rawPrompt || !rawPrompt.trim()) fail('prompt_required')

  let skillText = ''
  if (opts.skill) {
    if (!existsSync(opts.skill)) fail(`skill_not_found:${opts.skill}`)
    skillText = readFileSync(opts.skill, 'utf8')
  }

  const history = opts.session ? loadSessionHistory(opts.session) : []
  const fullPrompt = composePrompt({ skillText, history, prompt: rawPrompt })
  const modelPath = join(MODELS_DIR, spec.file)
  const telemetry = gatherTelemetry()
  const gate = evaluateResourceGate({
    activeProcesses: 0,
    telemetry,
    limits: { maxConcurrentProcesses: 1, minFreeMemoryMb: spec.minFreeMemoryMb, maxLoadAvgRatio: 0.85 }
  })

  if (gate.verdict !== 'admitted') {
    const payload = { ok: false, verdict: 'deferred', reason: gate.primaryReason, gate, cliArtifactBoundary: { mergeNativeArtifacts: false } }
    process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `deferred: ${gate.primaryReason}\n`)
    process.exit(3)
  }

  const cmdArgs = ['-m', modelPath, '-p', fullPrompt, '-n', String(opts.maxTokens), '-t', String(opts.threads), '--single-turn']
  if (!opts.execute) {
    const payload = {
      ok: true,
      mode: 'dry-run',
      model: opts.model,
      modelPath,
      modelExists: existsSync(modelPath),
      session: sanitizeSessionId(opts.session),
      historyTurnsLoaded: history.length,
      skillLoaded: Boolean(skillText),
      wouldSpawn: { bin: 'llama-cli', argv: cmdArgs.map((x) => (x === fullPrompt ? '<prompt>' : x)) },
      gate,
      cliArtifactBoundary: { mergeNativeArtifacts: false }
    }
    process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `dry-run ok (${opts.model})\n`)
    process.exit(0)
  }

  if (!existsSync(modelPath)) fail(`model_not_found:${modelPath}`)

  const t0 = Date.now()
  const res = spawnSync('llama-cli', cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
  const durationMs = Date.now() - t0
  const ok = res.status === 0
  const combined = (res.stdout && res.stdout.includes('\n> ')) ? res.stdout : `${res.stdout || ''}\n${res.stderr || ''}`
  const replyText = stripLlamaBanner(combined)
  if (ok && opts.session) {
    appendSessionTurn(opts.session, { model: opts.model, prompt: rawPrompt.trim(), reply: replyText })
  }
  const payload = {
    ok,
    mode: 'execute',
    model: opts.model,
    session: sanitizeSessionId(opts.session),
    exitCode: res.status,
    durationMs,
    text: replyText,
    gate,
    cliArtifactBoundary: { mergeNativeArtifacts: false }
  }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.text}\n`)
  process.exit(ok ? 0 : 1)
}

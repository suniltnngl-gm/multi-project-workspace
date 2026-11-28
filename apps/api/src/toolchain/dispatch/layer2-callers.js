/**
 * W5 (#293) — Layer-2 translation callers: local-GGUF intent extraction with
 * graphn as the remote fallback (replaces Colab cold-start).
 *
 * Production callers wrap the existing $0/cheap CLIs:
 *   - local:  `scripts/local-llama-cli.mjs --execute --json` (llama.cpp GGUF, $0)
 *   - remote: `scripts/swarm-direct.mjs --provider graphn` (OpenAI-compatible, cheap)
 *
 * Both are injected into `translatePrompt({ callLocalLlama, callRemoteFallback })`
 * and are fully tolerant: any spawn failure or unparseable output resolves to null
 * so Layer 1 deterministic output is returned untouched (never blocking).
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts')

export function buildLayer2Prompt(normalizedPrompt) {
  return [
    'Normalize the following swarm prompt into JSON only, no prose:',
    '{"intent": string, "canonicalTerms": string[], "targetPools": string[], "taskIds": string[], "constraints": string[]}',
    'Prompt:',
    String(normalizedPrompt || '')
  ].join('\n')
}

/** Tolerant JSON extraction from mixed CLI stdout (model prose + JSON object). */
export function parseLayer2Output(stdout) {
  const s = String(stdout || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const doc = JSON.parse(s.slice(start, end + 1))
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

function runCli(bin, args, timeoutMs) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Local $0 caller: llama.cpp GGUF via local-llama-cli.mjs.
 * `run` is injectable for tests; default executes the real CLI.
 */
export function buildLocalLlamaCaller({ model = '0.5b', timeoutMs = 60_000, scriptPath = join(REPO_SCRIPTS_DIR, 'local-llama-cli.mjs'), run = runCli, bin = process.execPath } = {}) {
  return async (normalizedPrompt) => {
    const out = run(bin, [scriptPath, '-m', model, '--execute', '-p', buildLayer2Prompt(normalizedPrompt), '--json', '-n', '192'], timeoutMs)
    // local-llama-cli --json wraps the model output in an envelope; look inside first.
    const envelope = parseLayer2Output(out)
    const inner = envelope && typeof envelope.response === 'string' ? envelope.response : out
    return parseLayer2Output(inner) || inner
  }
}

/**
 * Remote fallback caller: graphn (OpenAI-compatible gateway), replacing the
 * Colab cold-start path. Never cold-starts a GPU for a small prompt.
 */
export function buildGraphnFallbackCaller({ timeoutMs = 45_000, scriptPath = join(REPO_SCRIPTS_DIR, 'swarm-direct.mjs'), run = runCli, bin = process.execPath } = {}) {
  return async (normalizedPrompt) => {
    const out = run(bin, [scriptPath, '--provider', 'graphn', '--prompt', buildLayer2Prompt(normalizedPrompt)], timeoutMs)
    return parseLayer2Output(out) || out
  }
}

/**
 * Resolve Layer-2 callers for translatePrompt/parent-offload-gateway:
 * explicit callouts win; otherwise defaults are local-GGUF then graphn.
 */
export function resolveLayer2Callers({ callLocalLlama = null, callRemoteFallback = null, useLocalLlm = false, localLlama = {}, graphn = {} } = {}) {
  return {
    useLocalLlm: useLocalLlm || Boolean(callLocalLlama),
    callLocalLlama: callLocalLlama || (useLocalLlm ? buildLocalLlamaCaller(localLlama) : null),
    callRemoteFallback: callRemoteFallback || (useLocalLlm ? buildGraphnFallbackCaller(graphn) : null)
  }
}

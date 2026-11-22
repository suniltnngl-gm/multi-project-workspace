#!/usr/bin/env node
/**
 * Minimal resource-gated CLI wrapper for local llama.cpp GGUF models (Task #172).
 *
 * Defaults to --dry-run (no spawn). Pass --execute to invoke `llama-cli --single-turn`
 * with stdin closed (/dev/null) after passing the SP-004 host resource gate.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gatherTelemetry } from '../apps/api/src/toolchain/dispatch/host-telemetry.js'
import { evaluateResourceGate } from '../apps/api/src/toolchain/dispatch/resource-gate.js'

const MODELS_DIR = process.env.LLAMA_MODELS_DIR || join(homedir(), '.local/share/llama.cpp/models')
export const LOCAL_LLAMA_MODELS = Object.freeze({
  '0.5b': { file: 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf', minFreeMemoryMb: 1536 },
  '1.5b': { file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf', minFreeMemoryMb: 2048 }
})

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
  const opts = { model: '0.5b', maxTokens: '128', threads: '4', json: false, execute: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--dry-run') opts.execute = false
    else if (a === '--model' || a === '-m') opts.model = argv[++i]
    else if (a === '--prompt' || a === '-p') opts.prompt = argv[++i]
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
  if (!opts.prompt || !opts.prompt.trim()) fail('prompt_required')

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

  const cmdArgs = ['-m', modelPath, '-p', opts.prompt, '-n', String(opts.maxTokens), '-t', String(opts.threads), '--single-turn']
  if (!opts.execute) {
    const payload = {
      ok: true,
      mode: 'dry-run',
      model: opts.model,
      modelPath,
      modelExists: existsSync(modelPath),
      wouldSpawn: { bin: 'llama-cli', argv: cmdArgs.map((x) => (x === opts.prompt ? '<prompt>' : x)) },
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
  const payload = {
    ok,
    mode: 'execute',
    model: opts.model,
    exitCode: res.status,
    durationMs,
    text: stripLlamaBanner(res.stdout),
    gate,
    cliArtifactBoundary: { mergeNativeArtifacts: false }
  }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.text}\n`)
  process.exit(ok ? 0 : 1)
}

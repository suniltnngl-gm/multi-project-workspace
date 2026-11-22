#!/usr/bin/env node
/**
 * Minimal remote GPU CLI/gateway wrapper for Colab Direct -> Kaggle GPU fallback (Task #173).
 *
 * - Primary lane: Colab Direct (`colab` CLI), fail-closed if runtime is CPU-only or free-tier blocked.
 * - Automatic fallback: Kaggle GPU (`kaggle` CLI) when Colab is unavailable / CPU-only / free-tier restricted.
 * - Supports --skill <file.md>, --prompt-file <path>, --session <id> (rolling 4-turn JSONL memory),
 *   --dry-run (default, zero writes/spawns), --json, --execute.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const DEFAULT_CONFIG_PATH = process.env.REMOTE_GPU_CONFIG || join(homedir(), '.config/remote-gpu-cli/config.json')
const DEFAULT_SESSIONS_DIR = process.env.REMOTE_GPU_SESSIONS_DIR || join(homedir(), '.local/state/remote-gpu-cli/sessions')
const MAX_HISTORY_TURNS = 4

export const REMOTE_GPU_MODELS = Object.freeze({
  colab: { lane: 'colab', quotaPool: 'colab-gpu', transport: 'cli', modelId: 'colab-gpu-runtime' },
  kaggle: { lane: 'kaggle', quotaPool: 'kaggle-gpu', transport: 'kaggle-cli', modelId: 'Qwen/Qwen2.5-Coder-3B-Instruct' },
  'kaggle-tpu': { lane: 'kaggle-tpu', quotaPool: 'kaggle-tpu', transport: 'kaggle-cli', modelId: 'kaggle-tpu-jax-placeholder', placeholder: true },
  'kaggle-ai-models': { lane: 'kaggle-ai-models', quotaPool: 'kaggle-ai-models', transport: 'kaggle-api', modelId: 'kaggle-ai-models-placeholder', placeholder: true }
})

export function loadRemoteGpuConfig(configPath = DEFAULT_CONFIG_PATH) {
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

export function evaluateRemoteGpuTrigger({
  queuedTasks = 1,
  minBatchTasks = 3,
  promptTokens = 0,
  minPromptTokens = 1500,
  force = false
} = {}) {
  if (force) return { trigger: true, reason: 'explicit_force', recommendTier: 'T4-remote-gpu' }
  if (Number(queuedTasks) >= Number(minBatchTasks)) {
    return { trigger: true, reason: 'batch_threshold_met', recommendTier: 'T4-remote-gpu' }
  }
  if (Number(promptTokens) >= Number(minPromptTokens)) {
    return { trigger: true, reason: 'large_prompt_threshold_met', recommendTier: 'T4-remote-gpu' }
  }
  return {
    trigger: false,
    reason: `below_cost_trigger_threshold:tasks=${queuedTasks}/${minBatchTasks},tokens=${promptTokens}/${minPromptTokens}`,
    recommendTier: 'T0-local_or_T1-daily'
  }
}

export function selectRemoteGpuLane({
  preferred = 'auto',
  colabAvailable = true,
  colabHasGpu = true,
  colabFreeTierBlocked = false,
  kaggleAvailable = true,
  kaggleHasGpu = true
} = {}) {
  const colabEligible = colabAvailable && colabHasGpu && !colabFreeTierBlocked
  const kaggleEligible = kaggleAvailable && kaggleHasGpu

  if (preferred === 'colab') {
    if (colabEligible) return { ok: true, lane: 'colab', quotaPool: 'colab-gpu', fallbackUsed: false, reason: 'colab_gpu_primary' }
    return {
      ok: false,
      lane: null,
      quotaPool: 'colab-gpu',
      fallbackUsed: false,
      reason: colabFreeTierBlocked ? 'colab_free_tier_restricted' : (!colabHasGpu ? 'colab_cpu_only_refused' : 'colab_unavailable')
    }
  }

  if (preferred === 'kaggle') {
    if (kaggleEligible) return { ok: true, lane: 'kaggle', quotaPool: 'kaggle-gpu', fallbackUsed: false, reason: 'kaggle_gpu_explicit' }
    return { ok: false, lane: null, quotaPool: 'kaggle-gpu', fallbackUsed: false, reason: !kaggleHasGpu ? 'kaggle_cpu_only_refused' : 'kaggle_unavailable' }
  }

  if (preferred === 'kaggle-tpu') {
    return { ok: true, lane: 'kaggle-tpu', quotaPool: 'kaggle-tpu', fallbackUsed: false, reason: 'kaggle_tpu_explicit' }
  }

  if (preferred === 'kaggle-ai-models') {
    return { ok: true, lane: 'kaggle-ai-models', quotaPool: 'kaggle-ai-models', fallbackUsed: false, reason: 'kaggle_ai_models_explicit' }
  }

  // auto: Colab Direct primary -> Kaggle GPU fallback
  if (colabEligible) {
    return { ok: true, lane: 'colab', quotaPool: 'colab-gpu', fallbackUsed: false, reason: 'colab_gpu_primary' }
  }
  if (kaggleEligible) {
    const colabSkip = colabFreeTierBlocked ? 'colab_free_tier_restricted' : (!colabHasGpu ? 'colab_cpu_only' : 'colab_unavailable')
    return { ok: true, lane: 'kaggle', quotaPool: 'kaggle-gpu', fallbackUsed: true, reason: `fallback_to_kaggle:${colabSkip}` }
  }
  return { ok: false, lane: null, quotaPool: null, fallbackUsed: false, reason: 'no_remote_gpu_lane_available' }
}

export function loadSessionHistory(sessionId, sessionsDir = DEFAULT_SESSIONS_DIR, maxTurns = MAX_HISTORY_TURNS) {
  const safe = sanitizeSessionId(sessionId)
  if (!safe) return []
  const file = join(sessionsDir, `${safe}.jsonl`)
  if (!existsSync(file)) return []
  const records = []
  for (const l of readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
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

export function buildRemoteGpuCommand({
  lane,
  notebook = null,
  kernel = null,
  colabTransport = 'cli',
  sshTarget = null,
  remoteCommand = null,
  outputNotebook = null
}) {
  if (lane === 'colab') {
    if (colabTransport === 'ssh' && sshTarget) {
      return { bin: 'ssh', argv: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshTarget, remoteCommand || 'nvidia-smi'] }
    }
    if (colabTransport === 'papermill' && notebook) {
      const outNb = outputNotebook || (notebook.endsWith('.ipynb') ? notebook.replace(/\.ipynb$/i, '.out.ipynb') : `${notebook}.out.ipynb`)
      return { bin: 'papermill', argv: [notebook, outNb] }
    }
    return { bin: 'colab', argv: notebook ? ['run', notebook] : ['status'] }
  }
  if (lane === 'kaggle' || lane === 'kaggle-tpu') {
    return { bin: 'kaggle', argv: kernel ? ['kernels', 'push', '-p', kernel] : ['kernels', 'list', '--mine'] }
  }
  if (lane === 'kaggle-ai-models') {
    return { bin: 'kaggle', argv: ['models', 'list'] }
  }
  return null
}

const argv = process.argv.slice(2)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  let configPath = DEFAULT_CONFIG_PATH
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[i + 1]
  }
  const cfg = loadRemoteGpuConfig(configPath)
  const modelsCfg = {
    colab: { ...REMOTE_GPU_MODELS.colab, ...(cfg.models?.colab || {}) },
    kaggle: { ...REMOTE_GPU_MODELS.kaggle, ...(cfg.models?.kaggle || {}) }
  }
  const opts = {
    lane: cfg.defaultLane || cfg.defaultModel || 'auto',
    colabState: cfg.colabState || 'gpu',
    kaggleState: cfg.kaggleState || 'gpu',
    colabTransport: modelsCfg.colab.transport || 'cli',
    sshTarget: modelsCfg.colab.sshTarget || null,
    remoteCommand: modelsCfg.colab.remoteCommand || null,
    notebook: modelsCfg.colab.notebook || null,
    kernel: modelsCfg.kaggle.kernel || null,
    skill: null,
    session: null,
    promptFile: null,
    prompt: null,
    json: false,
    execute: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--dry-run') opts.execute = false
    else if (a === '--lane' || a === '--model' || a === '-m') opts.lane = argv[++i]
    else if (a === '--colab-state') opts.colabState = argv[++i]
    else if (a === '--kaggle-state') opts.kaggleState = argv[++i]
    else if (a === '--colab-transport') opts.colabTransport = argv[++i]
    else if (a === '--ssh-target') opts.sshTarget = argv[++i]
    else if (a === '--remote-cmd') opts.remoteCommand = argv[++i]
    else if (a === '--notebook') opts.notebook = argv[++i]
    else if (a === '--kernel') opts.kernel = argv[++i]
    else if (a === '--skill') opts.skill = argv[++i]
    else if (a === '--session') opts.session = argv[++i]
    else if (a === '--prompt' || a === '-p') opts.prompt = argv[++i]
    else if (a === '--prompt-file') opts.promptFile = argv[++i]
    else if (a === '--config') i++
  }

  const fail = (reason, code = 1) => {
    const payload = { ok: false, reason, cliArtifactBoundary: { mergeNativeArtifacts: false } }
    process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `remote-gpu-cli: ${reason}\n`)
    process.exit(code)
  }

  let rawPrompt = opts.prompt || ''
  if (opts.promptFile) {
    if (!existsSync(opts.promptFile)) fail(`prompt_file_not_found:${opts.promptFile}`)
    rawPrompt = readFileSync(opts.promptFile, 'utf8')
  }

  let skillLoaded = false
  if (opts.skill) {
    if (!existsSync(opts.skill)) fail(`skill_not_found:${opts.skill}`)
    readFileSync(opts.skill, 'utf8')
    skillLoaded = true
  }

  const selection = selectRemoteGpuLane({
    preferred: opts.lane,
    colabAvailable: opts.colabState !== 'unavailable',
    colabHasGpu: opts.colabState === 'gpu',
    colabFreeTierBlocked: opts.colabState === 'free_tier_blocked',
    kaggleAvailable: opts.kaggleState !== 'unavailable',
    kaggleHasGpu: opts.kaggleState === 'gpu'
  })

  if (!selection.ok) fail(selection.reason, 2)

  const activeModel = modelsCfg[selection.lane] || REMOTE_GPU_MODELS[selection.lane]
  const cmd = buildRemoteGpuCommand({
    lane: selection.lane,
    notebook: opts.notebook,
    kernel: opts.kernel,
    colabTransport: opts.colabTransport,
    sshTarget: opts.sshTarget,
    remoteCommand: opts.remoteCommand
  })
  const history = opts.session ? loadSessionHistory(opts.session) : []

  if (!opts.execute) {
    const payload = {
      ok: true,
      mode: 'dry-run',
      model: activeModel,
      selection,
      session: sanitizeSessionId(opts.session),
      historyTurnsLoaded: history.length,
      skillLoaded,
      promptRedacted: Boolean(rawPrompt.trim()),
      wouldSpawn: cmd,
      cliArtifactBoundary: { mergeNativeArtifacts: false }
    }
    process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `dry-run ok (${selection.lane})\n`)
    process.exit(0)
  }

  const t0 = Date.now()
  const res = spawnSync(cmd.bin, cmd.argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
  const durationMs = Date.now() - t0
  const ok = res.status === 0
  if (ok && opts.session) {
    appendSessionTurn(opts.session, { lane: selection.lane, prompt: rawPrompt.trim(), exitCode: res.status })
  }
  const payload = {
    ok,
    mode: 'execute',
    selection,
    session: sanitizeSessionId(opts.session),
    exitCode: res.status,
    durationMs,
    stdout: String(res.stdout || '').trim().slice(-2000),
    stderr: String(res.stderr || '').trim().slice(-1000),
    cliArtifactBoundary: { mergeNativeArtifacts: false }
  }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.stdout}\n`)
  process.exit(ok ? 0 : 1)
}

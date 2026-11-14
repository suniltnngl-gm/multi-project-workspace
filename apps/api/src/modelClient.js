import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
const RESULT_SENTINEL = '__WORKSPACE_MODEL_RESULT__'
const PROBE_CACHE_MS = 60000
const DEFAULT_HTTP_TIMEOUT_MS = 120000
const DEFAULT_PROMPT_CACHE_TTL_MS = 3600000
const DEFAULT_PROMPT_CACHE_MAX_ENTRIES = 100
const DEFAULT_COLAB_TIMEOUT_MS = 900000
const DEFAULT_KAGGLE_TIMEOUT_MS = 3600000
const SCRIPTS_DIR = fileURLToPath(new URL('../../../scripts', import.meta.url))

export class ModelCallError extends Error {
  constructor(message, status = 502, { retryAfter, code, details } = {}) {
    super(message)
    this.name = 'ModelCallError'
    this.status = status
    if (Number.isFinite(retryAfter)) this.retryAfter = Math.max(0, Math.ceil(retryAfter))
    if (code) this.code = code
    if (details) this.details = details
  }
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

// `colab status -s NAME` is the only authoritative source for what the
// runtime actually is: `colab sessions` lists a session by its requested name,
// so a session called gpu-t4-* can still be backed by a CPU runtime.
export function parseColabStatus(output) {
  const text = stripAnsi(output)
  const absent = /session .*not found|no active sessions?|not running/i.test(text)
  const field = (label) => {
    const match = text.match(new RegExp(`${label}:\\s*([^|\\n]+)`, 'i'))
    return match ? match[1].trim() : ''
  }
  const hardware = field('Hardware')
  const variant = field('Variant')
  const status = field('Status')
  // null means the CLI did not report enough to decide; false is positive
  // evidence of a CPU runtime, which the GPU-only model server cannot use.
  let gpu = null
  if (variant && variant.toUpperCase() !== 'DEFAULT') gpu = true
  else if (hardware && hardware.toUpperCase() !== 'CPU') gpu = true
  else if (hardware || variant) gpu = false
  return { absent, hardware, variant, status, gpu }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error) {
  return String(error?.message || error || '').toLowerCase()
}

function isCapacityError(error) {
  const message = errorText(error)
  return (
    message.includes('service unavailable')
    || message.includes('503')
    || message.includes('capacity')
    || message.includes('resource exhausted')
    || message.includes('try again later')
  )
}

function isEntitlementError(error) {
  const message = errorText(error)
  return (
    message.includes('rejected accelerator')
    || message.includes('quota or entitlement')
    || message.includes('not have quota')
    || message.includes('entitlement')
  )
}

async function defaultRunCommand(command, args, {
  timeoutMs = 600000,
  env = process.env,
  cwd,
  signal
} = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
      ...(cwd ? { cwd } : {}),
      signal
    })
    return { stdout, stderr }
  } catch (error) {
    if (signal?.aborted) {
      throw new ModelCallError(`${command} was cancelled.`, 499)
    }
    if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
      throw new ModelCallError(
        `${command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
        504
      )
    }
    // Non-zero exit with stdout/stderr may contain parseable JSON events (e.g. opencode
    // quota errors). Return them so the caller can extract the provider error.
    const stdout = String(error.stdout || '').trim()
    const stderr = String(error.stderr || '').trim()
    if (stdout || stderr) {
      return { stdout, stderr }
    }
    const detail = String(error.message || '').trim()
    const lastLine = detail.split('\n').filter(Boolean).at(-1)
    throw new ModelCallError(
      `${command} failed${lastLine ? `: ${lastLine}` : '.'}`,
      502
    )
  }
}

function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined
  const text = String(value).trim()
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds))
  const timestamp = Date.parse(text)
  if (Number.isFinite(timestamp)) {
    return Math.max(0, Math.ceil((timestamp - now) / 1000))
  }
  return undefined
}

// Providers describe retry delays inconsistently: numeric fields, compact
// "retryDelay":"69235s" JSON, and human "retry in 19h13m55s" prose. Read only
// what the error itself reports - never a vendor table - and fail soft.
function retrySecondsFromText(text) {
  if (typeof text !== 'string' || !text) return null
  const compact = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i)
  if (compact) {
    const seconds = Number(compact[1])
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }
  const human = text.match(
    /retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)h(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/i
  )
  if (human) {
    const total = (Number(human[1]) || 0) * 3600 +
      (Number(human[2]) || 0) * 60 +
      (Number(human[3]) || 0)
    if (total > 0) return total
  }
  const secondsOnly = text.match(/retry\s+(?:in|after)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/i)
  if (secondsOnly) {
    const seconds = Number(secondsOnly[1])
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }
  return null
}

function isRateLimitText(text) {
  return /\b429\b|rate.?limit|quota.?exhausted|RESOURCE_EXHAUSTED|too many requests/i.test(String(text ?? ''))
}

function estimateTokens(text) {
  const value = String(text ?? '')
  return value ? Math.max(1, Math.ceil(value.length / 4)) : 0
}

function joinMessagesForPrompt(messages = []) {
  return messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n')
}

export function parseAgyOutput(stdout) {
  const raw = stripAnsi(stdout).trim()
  if (!raw) {
    return { conversationId: '', text: '', error: 'The Antigravity CLI returned no output.', usage: undefined }
  }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    const lines = raw
      .split('\n')
      .map((line) => line.split('\r').pop().trim())
      .filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index]
      if (!candidate.startsWith('{')) continue
      try {
        parsed = JSON.parse(candidate)
        break
      } catch {
        // Keep scanning earlier lines.
      }
    }
    if (!parsed) {
      const firstBrace = raw.indexOf('{')
      const lastBrace = raw.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
        } catch {
          parsed = null
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { conversationId: '', text: '', error: 'The Antigravity CLI returned invalid JSON output.', usage: undefined }
  }

  const conversationId = String(
    parsed.conversation_id
    ?? parsed.conversationId
    ?? parsed.session_id
    ?? parsed.sessionID
    ?? ''
  ).trim()
  const text = typeof parsed.response === 'string'
    ? parsed.response.trim()
    : (typeof parsed.content === 'string' ? parsed.content.trim() : '')

  let error = null
  if (parsed.error) {
    error = typeof parsed.error === 'string'
      ? parsed.error
      : (parsed.error.message || JSON.stringify(parsed.error))
  } else if (parsed.status && !['SUCCESS', 'ok', 'OK'].includes(String(parsed.status))) {
    error = String(parsed.message || parsed.error_message || text || `Antigravity exited with status ${parsed.status}.`)
  }

  let usage
  if (parsed.usage && typeof parsed.usage === 'object') {
    const promptTokens = Number(parsed.usage.input_tokens ?? parsed.usage.prompt_tokens ?? 0)
    const completionTokens = Number(parsed.usage.output_tokens ?? parsed.usage.completion_tokens ?? 0)
      + Number(parsed.usage.thinking_tokens ?? 0)
    const totalTokens = Number(parsed.usage.total_tokens ?? (promptTokens + completionTokens))
    if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens) && Number.isFinite(totalTokens)) {
      usage = { promptTokens, completionTokens, totalTokens }
    }
  }

  return { conversationId, text, error, usage }
}

function parseCliRetryDelaySeconds(error) {
  if (!error || typeof error !== 'object') return undefined
  const direct = Number(error.retryAfter ?? error.retry_after)
  if (Number.isFinite(direct) && direct > 0) return direct
  const message = typeof error.message === 'string' ? error.message : ''
  const body = typeof error.response?.body === 'string' ? error.response.body : ''
  return retrySecondsFromText(message) ?? retrySecondsFromText(body) ?? undefined
}

function parseContent(result) {
  const content = result?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new ModelCallError('The model returned an empty response.', 502)
  }
  return content
}

function reportPhase(request, phase) {
  try {
    request?.onPhase?.(phase)
  } catch {
    // Progress reporting must never break inference.
  }
}

function parseUsage(result) {
  const usage = result?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens)
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens)
  const totalTokens = Number(usage.total_tokens)
  const normalized = {}
  if (Number.isFinite(promptTokens)) normalized.promptTokens = promptTokens
  if (Number.isFinite(completionTokens)) normalized.completionTokens = completionTokens
  if (Number.isFinite(totalTokens)) {
    normalized.totalTokens = totalTokens
  } else if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
    normalized.totalTokens = promptTokens + completionTokens
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function reportUsage(request, usage) {
  try {
    // Always call the hook, even without usage, so the budget can flag a
    // provider that omits token accounting.
    request?.onUsage?.(usage)
  } catch {
    // Usage reporting must never break inference.
  }
}

export function createModelClient({
  fetchImpl = fetch,
  runCommand = defaultRunCommand,
  apiKey = '',
  scriptsDir = SCRIPTS_DIR,
  promptCache: promptCacheOptions = {}
} = {}) {
  const colabStates = new Map()
  const opencodeSessions = new Map()
  const agySessions = new Map()
  const probeCache = new Map()
  // Cache and adaptive timeout state belong to the client instance. Module
  // singletons leaked cached completions and timeouts between app instances
  // (and between tests), so each client now starts clean. The prompt cache
  // options are injectable so tests can exercise it without mutating env.
  const promptCacheEnabled = promptCacheOptions.enabled
    ?? (process.env.AI_PROMPT_CACHE === 'true')
  const promptCacheTtlMs = Number(
    promptCacheOptions.ttlMs
      ?? process.env.AI_PROMPT_CACHE_TTL_MS
      ?? DEFAULT_PROMPT_CACHE_TTL_MS
  )
  const promptCacheMaxEntries = Number(
    promptCacheOptions.maxEntries
      ?? process.env.AI_PROMPT_CACHE_MAX_ENTRIES
      ?? DEFAULT_PROMPT_CACHE_MAX_ENTRIES
  )
  const promptCache = new Map()
  const adaptiveTimeouts = new Map()

  function authHeaders(model) {
    // Never send the local llama.cpp key to an external endpoint; remote
    // models use their own COLAB_AI_API_KEY/KAGGLE_AI_API_KEY.
    const key = model.apiKey || (model.remote ? '' : apiKey)
    return key ? { Authorization: `Bearer ${key}` } : {}
  }

  async function probeHttp(model) {
    for (const path of ['/health', model.healthPath ?? '/v1/models']) {
      try {
        const response = await fetchImpl(`${model.url}${path}`, {
          headers: authHeaders(model),
          signal: AbortSignal.timeout(15000)
        })
        if (response.ok) return true
      } catch {
        // Try the next probe.
      }
    }
    return false
  }

  async function readColabStatus(model, { signal, timeoutMs } = {}) {
    try {
      const { stdout, stderr } = await runCommand(
        model.cli.command,
        ['status', '-s', model.cli.session],
        {
          timeoutMs: timeoutMs
            ?? (Number.isFinite(model.cli.gpuProbeTimeoutMs)
              ? model.cli.gpuProbeTimeoutMs
              : 30000),
          signal
        }
      )
      return parseColabStatus(`${stdout}\n${stderr}`)
    } catch (error) {
      return { absent: false, hardware: '', variant: '', status: '', gpu: null, error }
    }
  }

  function colabRequiresGpu(model) {
    return model.cli?.requireGpu === true
  }

  function colabRetryAfterSeconds(model) {
    const backoff = Number(model.cli?.retryBackoffMs)
    return Math.max(5, Math.ceil((Number.isFinite(backoff) ? backoff : 15000) / 1000))
  }

  function colabGpuError(model, status) {
    const hardware = status.hardware || 'unknown'
    const variant = status.variant || 'unknown'
    return new ModelCallError(
      `${model.label} requires a GPU, but Colab reported ${hardware} (${variant}). `
        + 'The server cannot load on CPU; stop the runtime and request a GPU session.',
      503,
      {
        retryAfter: colabRetryAfterSeconds(model),
        code: 'gpu_unavailable',
        details: {
          session: model.cli.session,
          hardware: status.hardware || null,
          variant: status.variant || null
        }
      }
    )
  }

  async function probeCli(model) {
    const command = model.cli.command
    const cacheKey = command === 'colab'
      ? `colab:${model.cli.session}`
      : command
    const now = Date.now()
    const cached = probeCache.get(cacheKey)
    if (cached && now - cached.at < PROBE_CACHE_MS) return cached.value

    let value = { ok: false }
    try {
      const args = model.cli.probeArgs
        ?? (command === 'colab' ? ['version'] : ['--version'])
      await runCommand(command, args, { timeoutMs: 20000 })
      value = { ok: true }
      if (command === 'colab') {
        const status = await readColabStatus(model, { timeoutMs: 15000 })
        value.sessionState = status.error
          ? 'unknown'
          : status.absent ? 'absent' : 'present'
        if (!status.error && !status.absent && (status.hardware || status.variant)) {
          value.accelerator = {
            hardware: status.hardware || null,
            variant: status.variant || null,
            gpu: status.gpu
          }
        }
      }
    } catch {
      value = { ok: false }
    }
    probeCache.set(cacheKey, { value, at: now })
    return value
  }

  async function probe(model) {
    const cliBackend = model.backend === 'colab-cli'
      || model.backend === 'kaggle-cli'
      || model.backend === 'opencode-cli'
      || model.backend === 'agy-cli'
    let result
    if (cliBackend) {
      result = await probeCli(model)
    } else {
      result = { ok: await probeHttp(model) }
    }
    if (result.ok) return result
    return {
      ok: false,
      error: cliBackend
        ? `The ${model.cli.command} CLI is not installed or not authenticated for ${model.label}.`
        : `Configured endpoint for ${model.label} is unavailable.`
    }
  }

  async function completeHttp(model, request) {
    reportPhase(request, 'generating')
    let response
    const timeout = AbortSignal.timeout(model.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS)
    const signal = request.signal
      ? AbortSignal.any([timeout, request.signal])
      : timeout
    const payload = {
      model: model.apiModel ?? model.id,
      temperature: 0.2,
      max_tokens: request.maxTokens,
      messages: request.messages
    }
    // Existing llama.cpp/HTTP endpoints keep JSON mode by default. A provider
    // that does not support response_format sets supportsJsonMode to false and
    // relies on the prompt's "return only JSON" instruction instead.
    if (model.supportsJsonMode !== false) {
      payload.response_format = { type: 'json_object' }
    }

    try {
      response = await fetchImpl(`${model.url}${model.chatPath ?? '/v1/chat/completions'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(model) },
        signal,
        body: JSON.stringify(payload)
      })
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ModelCallError(`The request to ${model.label} was cancelled.`, 499)
      }
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ModelCallError(`The model ${model.label} took too long to respond.`, 504)
      }
      throw new ModelCallError(`The endpoint for ${model.label} is unavailable.`, 503)
    }

    if (!response.ok) {
      const retryAfter = parseRetryAfter(
        response.headers?.get?.('retry-after')
      )
      if (response.status === 429) {
        throw new ModelCallError(
          `The model ${model.label} is rate-limited (HTTP 429).`,
          429,
          { retryAfter }
        )
      }
      throw new ModelCallError(
        `The model ${model.label} rejected the request (HTTP ${response.status}).`,
        502
      )
    }
    const result = await response.json().catch(() => null)
    // Settle usage before validating content so a malformed draft still counts
    // against the provider quota.
    reportUsage(request, parseUsage(result))
    return parseContent(result)
  }

  function colabState(model) {
    let state = colabStates.get(model.id)
    if (!state) {
      state = { ready: false }
      colabStates.set(model.id, state)
    }
    return state
  }

  function isMissingSessionError(error) {
    const message = String(error?.message || '').toLowerCase()
    return (
      (message.includes('session') && message.includes('not found'))
      || message.includes('no active sessions')
    )
  }

  async function bootstrapColab(model, signal) {
    const { command, session, port, modelId, bootstrapTimeoutMs } = model.cli
    const bootstrapSeconds = Math.max(60, Math.ceil(bootstrapTimeoutMs / 1000))
    await runCommand(command, [
      'exec',
      '-s', session,
      '-f', join(scriptsDir, 'colab_model_server.py'),
      '--timeout', String(bootstrapSeconds),
      '--env', `WORKSPACE_MODEL_PORT=${port}`,
      '--env', `WORKSPACE_MODEL_ID=${modelId}`
    ], { timeoutMs: bootstrapTimeoutMs + 60000, signal })
  }

  async function createColabSession(model, signal) {
    const { command, session, gpus, gpu, newRetries, retryBackoffMs } = model.cli
    const candidates = gpus?.length ? gpus : [gpu || 'T4']
    const retries = Number.isFinite(newRetries) ? Math.max(0, newRetries) : 0
    const backoff = Number.isFinite(retryBackoffMs) ? Math.max(0, retryBackoffMs) : 0
    const requireGpu = colabRequiresGpu(model)
    const attempts = []
    let lastCpuStatus = null

    for (const accelerator of candidates) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          await runCommand(command, ['new', '-s', session, '--gpu', accelerator], {
            timeoutMs: 300000,
            signal
          })
          if (requireGpu) {
            // `colab new --gpu` can succeed and still hand back a CPU runtime.
            // Verify the allocation before downloading multi-gigabyte weights.
            const status = await readColabStatus(model, { signal })
            if (status.gpu === false) {
              lastCpuStatus = status
              attempts.push(
                `${accelerator}: allocated ${status.hardware || 'unknown'} (${status.variant || 'unknown'})`
              )
              continue
            }
          }
          return accelerator
        } catch (error) {
          if (signal?.aborted) throw error
          attempts.push(`${accelerator}: ${error.message}`)
          // Entitlement failures cannot be fixed by retrying the same shape.
          if (isEntitlementError(error)) break
          if (!isCapacityError(error)) throw error
          if (attempt < retries) await sleep(backoff)
        }
      }
    }

    if (lastCpuStatus) throw colabGpuError(model, lastCpuStatus)
    throw new ModelCallError(
      `Colab could not allocate a GPU (${attempts.at(-1) || 'no accelerator available'}). `
        + 'Try again later or set COLAB_AI_GPUS to an accelerator your account can use.',
      503,
      { retryAfter: colabRetryAfterSeconds(model), code: 'gpu_unavailable' }
    )
  }

  async function ensureColabSession(model, signal) {
    const state = colabState(model)
    if (state.ready) return

    if (colabRequiresGpu(model)) {
      // Verify before bootstrap so a CPU runtime fails in seconds instead of
      // after a model download. A missing session is created and verified by
      // createColabSession; an unreadable status falls through to the normal
      // bootstrap path rather than blocking a request we cannot judge.
      const status = await readColabStatus(model, { signal })
      if (status.absent) {
        await createColabSession(model, signal)
        await bootstrapColab(model, signal)
        state.ready = true
        return
      }
      if (status.gpu === false) throw colabGpuError(model, status)
    }

    try {
      // `colab status` exits successfully even when the session is missing, so
      // probe by bootstrapping and create a session only for that specific
      // failure. Other errors (pip, model download) should surface as-is.
      await bootstrapColab(model, signal)
    } catch (error) {
      if (!isMissingSessionError(error)) throw error
      await createColabSession(model, signal)
      await bootstrapColab(model, signal)
    }
    state.ready = true
  }

  async function writeColabAudit(model, entry) {
    const directory = model.cli.auditDir
    if (!directory) return

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const target = join(directory, `${id}.json`)
      const temporary = `${target}.tmp`
      const payload = {
        id,
        at: new Date().toISOString(),
        model: model.id,
        session: model.cli.session,
        ...entry
      }
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporary, target)
    } catch (error) {
      // Auditing is best-effort and must never break inference.
      console.error(`Could not write the Colab audit file: ${error.message}`)
    }
  }

  async function completeColab(model, request) {
    reportPhase(request, 'bootstrapping')
    await ensureColabSession(model, request.signal)
    reportPhase(request, 'generating')
    const state = colabState(model)
    const { command, session, port } = model.cli
    const timeoutMs = model.timeoutMs ?? DEFAULT_COLAB_TIMEOUT_MS
    const payload = Buffer.from(JSON.stringify({
      messages: request.messages,
      max_tokens: request.maxTokens,
      response_format: { type: 'json_object' }
    })).toString('base64')
    const audit = {
      request: {
        messages: request.messages,
        maxTokens: request.maxTokens
      }
    }
    const startedAt = Date.now()

    try {
      let stdout
      try {
        ({ stdout } = await runCommand(command, [
          'exec',
          '-s', session,
          '-f', join(scriptsDir, 'colab_model_client.py'),
          '--timeout', String(Math.max(30, Math.ceil(timeoutMs / 1000))),
          '--env', `WORKSPACE_MODEL_PORT=${port}`,
          '--env', `WORKSPACE_MODEL_REQUEST=${payload}`
        ], { timeoutMs: timeoutMs + 60000, signal: request.signal }))
      } catch (error) {
        // The session may have expired or the server thread may have died.
        // Force a bootstrap on the next call.
        state.ready = false
        throw error
      }

      const line = stdout
        .split('\n')
        .map((value) => value.trim())
        .findLast((value) => value.startsWith(RESULT_SENTINEL))
      if (!line) {
        throw new ModelCallError(`The ${model.label} CLI returned no model output.`, 502)
      }

      let result
      try {
        result = JSON.parse(line.slice(RESULT_SENTINEL.length))
      } catch {
        throw new ModelCallError(`The ${model.label} CLI returned invalid output.`, 502)
      }
      const content = parseContent(result)
      const durationMs = Date.now() - startedAt
      const computeSeconds = Math.max(1, Math.ceil(durationMs / 1000))
      reportUsage(request, { ...(parseUsage(result) || {}), computeSeconds })
      await writeColabAudit(model, {
        ...audit,
        status: 'ok',
        response: { content },
        durationMs
      })
      return content
    } catch (error) {
      await writeColabAudit(model, {
        ...audit,
        status: 'error',
        error: error.message,
        durationMs: Date.now() - startedAt
      })
      throw error
    }
  }

  async function completeKaggle(model, request) {
    if (!request.task) {
      throw new ModelCallError('The Kaggle runner requires task fields.', 500)
    }

    const startedAt = Date.now()
    const directory = await mkdtemp(join(tmpdir(), 'workspace-kaggle-'))
    try {
      const taskPath = join(directory, 'task.json')
      const outputPath = join(directory, 'response.json')
      await writeFile(taskPath, JSON.stringify(request.task), 'utf8')

      const timeoutMs = model.timeoutMs ?? DEFAULT_KAGGLE_TIMEOUT_MS
      const args = [
        join(scriptsDir, 'kaggle_run.py'),
        '--task-json', taskPath,
        '--output', outputPath,
        '--timeout', String(Math.max(60, Math.floor(timeoutMs / 1000))),
        '--poll-interval', String(Math.max(1, model.cli.pollIntervalSeconds ?? 30)),
        '--cancel-fallback', model.cli.cancelFallback ?? 'none'
      ]
      // A manifest lets a re-queued call resume the existing kernel or reuse
      // its downloaded response instead of spending another submission.
      if (model.cli.manifestDir) {
        args.push('--manifest-dir', model.cli.manifestDir)
      }
      reportPhase(request, 'submitting')
      await runCommand(model.cli.python, args, {
        timeoutMs: timeoutMs + 120000,
        signal: request.signal
      })

      reportPhase(request, 'generating')
      const parsed = JSON.parse(await readFile(outputPath, 'utf8'))
      if (
        typeof parsed.description !== 'string' ||
        typeof parsed.acceptance_criteria !== 'string'
      ) {
        throw new ModelCallError('The Kaggle runner returned an invalid task response.', 502)
      }
      const reportedCompute = Number(parsed.compute_seconds ?? parsed.computeSeconds)
      const computeSeconds = Number.isFinite(reportedCompute) && reportedCompute > 0
        ? reportedCompute
        : Math.max(1, Math.ceil((Date.now() - startedAt) / 1000))
      reportUsage(request, { computeSeconds })
      return JSON.stringify(parsed)
    } catch (error) {
      if (error instanceof ModelCallError) throw error
      throw new ModelCallError(`The Kaggle runner failed: ${error.message}`, 502)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  function opencodeSessionKey(model, request) {
    return [
      model.id ?? 'opencode',
      model.cli?.model ?? '',
      model.cli?.agent ?? '',
      request.worktreePath ?? '',
      request.sessionKey ?? ''
    ].join('\0')
  }

  function isMissingOpencodeSessionMessage(text) {
    return /session.*not found|SessionNotFoundError/i.test(String(text ?? ''))
  }

  function parseOpencodeOutput(stdout) {
    let content = ''
    let errorEvent = null
    let observedSessionId = ''
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    let sawUsage = false
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        const eventSessionId = typeof event.sessionID === 'string' && event.sessionID
          ? event.sessionID
          : (typeof event.part?.sessionID === 'string' && event.part.sessionID ? event.part.sessionID : '')
        if (eventSessionId) observedSessionId = eventSessionId
        if (event.type === 'text' && event.part && typeof event.part.text === 'string') {
          content += event.part.text
        } else if (event.type === 'error' && !errorEvent) {
          errorEvent = event.error ?? {}
        }
        const tokens = event.part?.tokens ?? event.tokens ?? event.usage
        if (tokens && typeof tokens === 'object') {
          const input = Number(tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens)
          const output = Number(tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens)
          const reasoning = Number(tokens.reasoning ?? tokens.thinking_tokens ?? 0)
          const total = Number(tokens.total ?? tokens.total_tokens)
          if (Number.isFinite(input) || Number.isFinite(output) || Number.isFinite(total)) {
            sawUsage = true
            if (Number.isFinite(input)) promptTokens += input
            if (Number.isFinite(output)) {
              completionTokens += output + (Number.isFinite(reasoning) ? reasoning : 0)
            }
            if (Number.isFinite(total)) totalTokens += total
            else totalTokens += (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
          }
        }
      } catch {
        // Ignore non-JSON log lines.
      }
    }
    const usage = sawUsage
      ? {
          promptTokens,
          completionTokens,
          totalTokens: totalTokens || (promptTokens + completionTokens)
        }
      : undefined
    return { content, errorEvent, observedSessionId, usage }
  }

  async function completeOpencode(model, request) {
    reportPhase(request, 'generating')
    const prompt = joinMessagesForPrompt(request.messages)
    const timeoutMs = model.timeoutMs ?? 300000
    const sessionKey = opencodeSessionKey(model, request)
    const cachedSessionId = opencodeSessions.get(sessionKey) || model.cli?.session || ''

    const runOpencodeOnce = async (sessionId) => {
      const args = ['run', prompt, '--format', 'json']
      if (model.cli?.model) args.push('--model', model.cli.model)
      if (model.cli?.agent) args.push('--agent', model.cli.agent)
      if (sessionId) args.push('--session', sessionId)
      const { stdout } = await runCommand(model.cli.command, args, {
        timeoutMs,
        // A task-linked run executes inside the task's worktree so generated
        // changes never touch the main checkout.
        ...(request.worktreePath ? { cwd: request.worktreePath } : {}),
        signal: request.signal
      })
      return parseOpencodeOutput(stdout)
    }

    let parsed
    try {
      parsed = await runOpencodeOnce(cachedSessionId)
      if (cachedSessionId && !parsed.content && isMissingOpencodeSessionMessage(parsed.errorEvent?.message)) {
        opencodeSessions.delete(sessionKey)
        parsed = await runOpencodeOnce('')
      }
    } catch (error) {
      if (cachedSessionId && isMissingOpencodeSessionMessage(error?.message)) {
        opencodeSessions.delete(sessionKey)
        try {
          parsed = await runOpencodeOnce('')
        } catch (retryError) {
          throw new ModelCallError(`The OpenCode CLI failed: ${retryError.message}`, 502)
        }
      } else {
        throw new ModelCallError(`The OpenCode CLI failed: ${error.message}`, 502)
      }
    }

    const { content, errorEvent, observedSessionId } = parsed
    if (!content) {
      // A run that produced no text but reported an error fails with the
      // provider's own status and retry delay when the event carries them, so
      // a live 429 reaches cooldown instead of surfacing as a parse artifact.
      const status = Number(errorEvent?.status)
      throw new ModelCallError(
        String(errorEvent?.message || 'The OpenCode CLI returned no model output.'),
        Number.isFinite(status) && status >= 400 ? status : 502,
        { retryAfter: parseCliRetryDelaySeconds(errorEvent) }
      )
    }

    const nextSessionId = observedSessionId || cachedSessionId
    if (nextSessionId) opencodeSessions.set(sessionKey, nextSessionId)
    reportUsage(
      request,
      parsed.usage ?? {
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(content),
        totalTokens: estimateTokens(prompt) + estimateTokens(content)
      }
    )
    return content
  }

  function agySessionKey(model, request) {
    return [
      model.id ?? 'agy',
      model.cli?.model ?? '',
      model.cli?.agent ?? '',
      model.cli?.effort ?? '',
      request.worktreePath ?? '',
      request.sessionKey ?? ''
    ].join('\0')
  }

  function isMissingAgyConversationMessage(text) {
    return /conversation.*not found|ConversationNotFound|invalid.*conversation|no conversation|unknown conversation/i.test(String(text ?? ''))
  }

  async function completeAgy(model, request) {
    reportPhase(request, 'generating')
    const prompt = joinMessagesForPrompt(request.messages)
    const timeoutMs = model.timeoutMs ?? 300000
    const sessionKey = agySessionKey(model, request)
    const cachedConversationId = agySessions.get(sessionKey) || model.cli?.conversation || ''

    const buildArgs = (conversationId) => {
      const args = ['--print', prompt, '--output-format', 'json']
      if (model.cli?.model) args.push('--model', model.cli.model)
      if (model.cli?.agent) args.push('--agent', model.cli.agent)
      if (model.cli?.effort) args.push('--effort', model.cli.effort)
      if (conversationId) args.push('--conversation', conversationId)
      return args
    }

    const runAgyOnce = async (conversationId) => {
      const { stdout, stderr } = await runCommand(model.cli.command, buildArgs(conversationId), {
        timeoutMs,
        ...(request.worktreePath ? { cwd: request.worktreePath } : {}),
        signal: request.signal
      })
      const parsed = parseAgyOutput(stdout)
      if (parsed.error && stderr && parsed.error === 'The Antigravity CLI returned no output.') {
        parsed.error = stderr.trim()
      }
      return parsed
    }

    let parsed
    try {
      parsed = await runAgyOnce(cachedConversationId)
      if (cachedConversationId && parsed.error && isMissingAgyConversationMessage(parsed.error)) {
        agySessions.delete(sessionKey)
        parsed = await runAgyOnce('')
      }
    } catch (error) {
      if (cachedConversationId && isMissingAgyConversationMessage(error?.message)) {
        agySessions.delete(sessionKey)
        try {
          parsed = await runAgyOnce('')
        } catch (retryError) {
          if (retryError instanceof ModelCallError) throw retryError
          if (isRateLimitText(retryError?.message)) {
            throw new ModelCallError(retryError.message, 429, {
              retryAfter: retrySecondsFromText(retryError.message) ?? undefined
            })
          }
          throw new ModelCallError(`The Antigravity CLI failed: ${retryError.message}`, 502)
        }
      } else {
        if (error instanceof ModelCallError) throw error
        if (isRateLimitText(error?.message)) {
          throw new ModelCallError(error.message, 429, {
            retryAfter: retrySecondsFromText(error.message) ?? undefined
          })
        }
        throw new ModelCallError(`The Antigravity CLI failed: ${error.message}`, 502)
      }
    }

    if (parsed.error || !parsed.text) {
      const errorMessage = String(parsed.error || 'The Antigravity CLI returned no model output.')
      if (isRateLimitText(errorMessage)) {
        throw new ModelCallError(errorMessage, 429, {
          retryAfter: retrySecondsFromText(errorMessage) ?? undefined
        })
      }
      throw new ModelCallError(errorMessage, 502)
    }

    const nextConversationId = parsed.conversationId || cachedConversationId
    if (nextConversationId) agySessions.set(sessionKey, nextConversationId)

    reportUsage(
      request,
      parsed.usage ?? {
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(parsed.text),
        totalTokens: estimateTokens(prompt) + estimateTokens(parsed.text)
      }
    )

    if (model.cli?.auditDir) {
      await writeColabAudit(model, {
        conversationId: nextConversationId || null,
        status: 'ok',
        request: { messages: request.messages, maxTokens: request.maxTokens },
        response: { content: parsed.text },
        usage: parsed.usage ?? null
      })
    }

    return parsed.text
  }

  function promptCacheKey(model, request) {
    // Worktree and task are part of the prompt's effective input for the CLI
    // backends, so two otherwise-identical requests must not share a cache
    // entry across repositories or task payloads. The effective CLI model and
    // agent also belong in the key: changing OPENCODE_AI_MODEL mid-session
    // invalidates the provider's prompt cache, and the local cache must not
    // serve a reply produced by the previous model.
    return createHash('sha256')
      .update(model.id)
      .update(model.cli?.model ?? '')
      .update(model.cli?.agent ?? '')
      .update(model.cli?.effort ?? '')
      .update(JSON.stringify(request.messages ?? []))
      .update(String(request.maxTokens ?? ''))
      .update(JSON.stringify(request.task ?? null))
      .update(String(request.worktreePath ?? ''))
      .digest('hex')
  }

  async function completeOllama(model, request) {
    reportPhase(request, 'generating')
    const endpoint = model.chatUrl || (String(model.url || '').replace(/\/+$/, '').endsWith('/chat')
      ? model.url
      : `${String(model.url || '').replace(/\/+$/, '')}/chat`)
    let response
    const timeout = AbortSignal.timeout(model.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS)
    const signal = request.signal
      ? AbortSignal.any([timeout, request.signal])
      : timeout
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(model) },
        signal,
        body: JSON.stringify({
          model: model.apiModel ?? model.model ?? model.id,
          messages: request.messages,
          stream: false
        })
      })
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ModelCallError(`The request to ${model.label} was cancelled.`, 499)
      }
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ModelCallError(`The model ${model.label} took too long to respond.`, 504)
      }
      throw new ModelCallError(`The endpoint for ${model.label} is unavailable.`, 503)
    }

    if (!response.ok) {
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'))
      if (response.status === 429) {
        throw new ModelCallError(`The model ${model.label} is rate-limited (HTTP 429).`, 429, { retryAfter })
      }
      throw new ModelCallError(`The model ${model.label} rejected the request (HTTP ${response.status}).`, 502)
    }
    const result = await response.json().catch(() => null)
    const content = result?.message?.content
    if (typeof content !== 'string' || !content) {
      throw new ModelCallError(`The model ${model.label} returned no content.`, 502)
    }
    return content
  }

  async function complete(model, request) {
    const startedAt = Date.now()
    const auditDir = process.env.AI_AUDIT_DIR || ''
    const cacheKey = promptCacheEnabled ? promptCacheKey(model, request) : ''

    if (cacheKey) {
      const cached = promptCache.get(cacheKey)
      if (cached && Date.now() - cached.createdAt < promptCacheTtlMs) {
        return cached.content
      }
      if (cached) promptCache.delete(cacheKey)
    }

    const baseTimeoutMs = model.timeoutMs ?? 120000
    const effectiveTimeoutMs = Math.min(baseTimeoutMs * 2, adaptiveTimeouts.get(model.id) ?? baseTimeoutMs)
    model.timeoutMs = effectiveTimeoutMs

    let content
    let error
    try {
      if (model.backend === 'colab-cli') content = await completeColab(model, request)
      else if (model.backend === 'kaggle-cli') content = await completeKaggle(model, request)
      else if (model.backend === 'opencode-cli') content = await completeOpencode(model, request)
      else if (model.backend === 'agy-cli') content = await completeAgy(model, request)
      else if (model.backend === 'ollama') content = await completeOllama(model, request)
      else content = await completeHttp(model, request)
      const observed = Date.now() - startedAt
      adaptiveTimeouts.set(model.id, Math.min(baseTimeoutMs * 2, Math.max(baseTimeoutMs, observed * 2)))
    } catch (caught) {
      const message = String(caught?.message || caught)
      if (/timed? ?out|timeout/i.test(message)) {
        adaptiveTimeouts.set(model.id, Math.min(baseTimeoutMs * 2, effectiveTimeoutMs * 2))
      }
      error = caught
    }

    if (cacheKey && content && !error) {
      if (promptCache.size >= promptCacheMaxEntries) {
        const oldestKey = promptCache.keys().next().value
        if (oldestKey) promptCache.delete(oldestKey)
      }
      promptCache.set(cacheKey, { content, createdAt: Date.now() })
    }

    if (auditDir) {
      try {
        await mkdir(auditDir, { recursive: true })
        await writeFile(
          join(auditDir, `${model.id}-${Date.now()}.json`),
          JSON.stringify({
            model: model.id,
            backend: model.backend,
            request: {
              messages: request.messages,
              task: request.task,
              maxTokens: request.maxTokens
            },
            content: content ?? null,
            error: error ? String(error.message || error) : null,
            durationMs: Date.now() - startedAt
          }, null, 2),
          'utf8'
        )
      } catch {
        // Auditing is best-effort and never blocks inference.
      }
    }

    if (error) throw error
    return content
  }

  return { complete, probe }
}

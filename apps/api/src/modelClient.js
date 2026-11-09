/**
 * Objective: Implement and maintain apps/api/src/modelClient.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/api/src/modelClient.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RESULT_SENTINEL = '__WORKSPACE_MODEL_RESULT__'
const PROBE_CACHE_MS = 60000
const DEFAULT_HTTP_TIMEOUT_MS = 120000
const DEFAULT_COLAB_TIMEOUT_MS = 900000
const DEFAULT_KAGGLE_TIMEOUT_MS = 3600000
const SCRIPTS_DIR = fileURLToPath(new URL('../../../scripts', import.meta.url))

export class ModelCallError extends Error {
  constructor(message, status = 502, { retryAfter } = {}) {
    super(message)
    this.name = 'ModelCallError'
    this.status = status
    if (Number.isFinite(retryAfter)) this.retryAfter = Math.max(0, Math.ceil(retryAfter))
  }
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
  signal
} = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
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
    const detail = String(error.stderr || error.stdout || error.message || '').trim()
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
  scriptsDir = SCRIPTS_DIR
} = {}) {
  const colabStates = new Map()
  const probeCache = new Map()

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

  async function probeColabSession(model) {
    try {
      const { stdout } = await runCommand(
        model.cli.command,
        ['status', '-s', model.cli.session],
        { timeoutMs: 15000 }
      )
      return /not found|no active session|not running/i.test(stdout)
        ? 'absent'
        : 'present'
    } catch {
      return 'unknown'
    }
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
        value.sessionState = await probeColabSession(model)
      }
    } catch {
      value = { ok: false }
    }
    probeCache.set(cacheKey, { value, at: now })
    return value
  }

  async function probe(model) {
    const cliBackend = model.backend === 'colab-cli' || model.backend === 'kaggle-cli'
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
    const attempts = []

    for (const accelerator of candidates) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          await runCommand(command, ['new', '-s', session, '--gpu', accelerator], {
            timeoutMs: 300000,
            signal
          })
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

    const retryAfterSeconds = Math.max(
      5,
      Math.ceil((Number.isFinite(retryBackoffMs) ? retryBackoffMs : 15000) / 1000)
    )
    throw new ModelCallError(
      `Colab could not allocate a GPU (${attempts.at(-1) || 'no accelerator available'}). `
        + 'Try again later or set COLAB_AI_GPUS to an accelerator your account can use.',
      503,
      { retryAfter: retryAfterSeconds }
    )
  }

  async function ensureColabSession(model, signal) {
    const state = colabState(model)
    if (state.ready) return

    const { command, session } = model.cli
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
      await writeColabAudit(model, {
        ...audit,
        status: 'ok',
        response: { content },
        durationMs: Date.now() - startedAt
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

    const directory = await mkdtemp(join(tmpdir(), 'workspace-kaggle-'))
    try {
      const taskPath = join(directory, 'task.json')
      const outputPath = join(directory, 'response.json')
      await writeFile(taskPath, JSON.stringify(request.task), 'utf8')

      const timeoutMs = model.timeoutMs ?? DEFAULT_KAGGLE_TIMEOUT_MS
      reportPhase(request, 'submitting')
      await runCommand(model.cli.python, [
        join(scriptsDir, 'kaggle_run.py'),
        '--task-json', taskPath,
        '--output', outputPath,
        '--timeout', String(Math.max(60, Math.floor(timeoutMs / 1000))),
        '--poll-interval', String(Math.max(1, model.cli.pollIntervalSeconds ?? 30)),
        '--cancel-fallback', model.cli.cancelFallback ?? 'none'
      ], { timeoutMs: timeoutMs + 120000, signal: request.signal })

      reportPhase(request, 'generating')
      const parsed = JSON.parse(await readFile(outputPath, 'utf8'))
      if (
        typeof parsed.description !== 'string' ||
        typeof parsed.acceptance_criteria !== 'string'
      ) {
        throw new ModelCallError('The Kaggle runner returned an invalid task response.', 502)
      }
      return JSON.stringify(parsed)
    } catch (error) {
      if (error instanceof ModelCallError) throw error
      throw new ModelCallError(`The Kaggle runner failed: ${error.message}`, 502)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async function complete(model, request) {
    if (model.backend === 'colab-cli') return completeColab(model, request)
    if (model.backend === 'kaggle-cli') return completeKaggle(model, request)
    return completeHttp(model, request)
  }

  return { complete, probe }
}

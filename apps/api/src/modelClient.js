import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  constructor(message, status = 502) {
    super(message)
    this.name = 'ModelCallError'
    this.status = status
  }
}

async function defaultRunCommand(command, args, {
  timeoutMs = 600000,
  env = process.env
} = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env
    })
    return { stdout, stderr }
  } catch (error) {
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

function parseContent(result) {
  const content = result?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new ModelCallError('The model returned an empty response.', 502)
  }
  return content
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
    for (const path of ['/health', '/v1/models']) {
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

  async function probeCli(model) {
    const command = model.cli.command
    const now = Date.now()
    const cached = probeCache.get(command)
    if (cached && now - cached.at < PROBE_CACHE_MS) return cached.ok

    let ok = false
    try {
      const args = model.cli.probeArgs
        ?? (command === 'colab' ? ['version'] : ['--version'])
      await runCommand(command, args, { timeoutMs: 20000 })
      ok = true
    } catch {
      ok = false
    }
    probeCache.set(command, { ok, at: now })
    return ok
  }

  async function probe(model) {
    const cliBackend = model.backend === 'colab-cli' || model.backend === 'kaggle-cli'
    let ok
    if (cliBackend) {
      ok = await probeCli(model)
    } else {
      ok = await probeHttp(model)
    }
    if (ok) return { ok: true }
    return {
      ok: false,
      error: cliBackend
        ? `The ${model.cli.command} CLI is not installed or not authenticated for ${model.label}.`
        : `Configured endpoint for ${model.label} is unavailable.`
    }
  }

  async function completeHttp(model, request) {
    let response
    try {
      response = await fetchImpl(`${model.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(model) },
        signal: AbortSignal.timeout(model.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
        body: JSON.stringify({
          model: model.id,
          temperature: 0.2,
          max_tokens: request.maxTokens,
          response_format: { type: 'json_object' },
          messages: request.messages
        })
      })
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ModelCallError(`The model ${model.label} took too long to respond.`, 504)
      }
      throw new ModelCallError(`The endpoint for ${model.label} is unavailable.`, 503)
    }

    if (!response.ok) {
      throw new ModelCallError(
        `The model ${model.label} rejected the request (HTTP ${response.status}).`,
        502
      )
    }
    return parseContent(await response.json().catch(() => null))
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

  async function bootstrapColab(model) {
    const { command, session, port, modelId, bootstrapTimeoutMs } = model.cli
    const bootstrapSeconds = Math.max(60, Math.ceil(bootstrapTimeoutMs / 1000))
    await runCommand(command, [
      'exec',
      '-s', session,
      '-f', join(scriptsDir, 'colab_model_server.py'),
      '--timeout', String(bootstrapSeconds),
      '--env', `WORKSPACE_MODEL_PORT=${port}`,
      '--env', `WORKSPACE_MODEL_ID=${modelId}`
    ], { timeoutMs: bootstrapTimeoutMs + 60000 })
  }

  async function ensureColabSession(model) {
    const state = colabState(model)
    if (state.ready) return

    const { command, session, gpu } = model.cli
    try {
      // `colab status` exits successfully even when the session is missing, so
      // probe by bootstrapping and create a session only for that specific
      // failure. Other errors (pip, model download) should surface as-is.
      await bootstrapColab(model)
    } catch (error) {
      if (!isMissingSessionError(error)) throw error
      await runCommand(command, ['new', '-s', session, '--gpu', gpu], {
        timeoutMs: 300000
      })
      await bootstrapColab(model)
    }
    state.ready = true
  }

  async function completeColab(model, request) {
    await ensureColabSession(model)
    const state = colabState(model)
    const { command, session, port } = model.cli
    const timeoutMs = model.timeoutMs ?? DEFAULT_COLAB_TIMEOUT_MS
    const payload = Buffer.from(JSON.stringify({
      messages: request.messages,
      max_tokens: request.maxTokens,
      response_format: { type: 'json_object' }
    })).toString('base64')

    let stdout
    try {
      ({ stdout } = await runCommand(command, [
        'exec',
        '-s', session,
        '-f', join(scriptsDir, 'colab_model_client.py'),
        '--timeout', String(Math.max(30, Math.ceil(timeoutMs / 1000))),
        '--env', `WORKSPACE_MODEL_PORT=${port}`,
        '--env', `WORKSPACE_MODEL_REQUEST=${payload}`
      ], { timeoutMs: timeoutMs + 60000 }))
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
    return parseContent(result)
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
      await runCommand(model.cli.python, [
        join(scriptsDir, 'kaggle_run.py'),
        '--task-json', taskPath,
        '--output', outputPath,
        '--timeout', String(Math.max(60, Math.floor(timeoutMs / 1000))),
        '--poll-interval', String(Math.max(1, model.cli.pollIntervalSeconds ?? 30))
      ], { timeoutMs: timeoutMs + 120000 })

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

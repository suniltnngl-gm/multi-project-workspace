import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModelClient, ModelCallError } from '../src/modelClient.js'

const SCRIPTS = '/workspace/scripts'
const RESULT_SENTINEL = '__WORKSPACE_MODEL_RESULT__'

function colabModel(overrides = {}) {
  return {
    id: 'colab-3b',
    label: 'Colab model',
    backend: 'colab-cli',
    remote: true,
    timeoutMs: 900000,
    cli: {
      command: 'colab',
      session: 'workspace-qwen',
      gpu: 'T4',
      port: 8765,
      modelId: 'Qwen/Qwen2.5-Coder-3B-Instruct',
      bootstrapTimeoutMs: 1800000
    },
    ...overrides
  }
}

function kaggleModel(overrides = {}) {
  return {
    id: 'kaggle-3b',
    label: 'Kaggle model',
    backend: 'kaggle-cli',
    remote: true,
    timeoutMs: 3600000,
    cli: {
      command: 'kaggle',
      python: 'python3',
      pollIntervalSeconds: 30
    },
    ...overrides
  }
}

function opencodeModel(overrides = {}) {
  return {
    id: 'opencode',
    label: 'OpenCode headless',
    backend: 'opencode-cli',
    remote: true,
    timeoutMs: 300000,
    cli: {
      command: 'opencode',
      model: 'big-pickle',
      agent: 'general'
    },
    ...overrides
  }
}

const REQUEST = {
  messages: [{ role: 'user', content: 'Draft a task' }],
  maxTokens: 120,
  task: {
    title: 'Draft a task',
    project: 'workspace',
    task_type: 'feature',
    description: '',
    acceptance_criteria: ''
  }
}

function envValue(args, key) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--env' && args[index + 1]?.startsWith(`${key}=`)) {
      return args[index + 1].slice(key.length + 1)
    }
  }
  return undefined
}

test('Colab creates a missing session, bootstraps once, and reuses it', async () => {
  const calls = []
  let bootstraps = 0
  let completions = 0
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === 'new') return { stdout: '', stderr: '' }
    if (args[0] === 'exec' && args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      bootstraps += 1
      if (bootstraps === 1) {
        throw new ModelCallError(
          "colab failed: [colab] Session 'workspace-qwen' not found.",
          502
        )
      }
      return { stdout: 'WORKSPACE_COLAB_READY\n', stderr: '' }
    }
    if (args[0] === 'exec' && args.includes(join(SCRIPTS, 'colab_model_client.py'))) {
      completions += 1
      return {
        stdout: [
          'noise',
          `${RESULT_SENTINEL}${JSON.stringify({
            choices: [{ message: { content: '{"description":"ok","acceptance_criteria":"done"}' } }]
          })}`
        ].join('\n'),
        stderr: ''
      }
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }

  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  const model = colabModel()

  const first = await client.complete(model, REQUEST)
  assert.match(first, /"description":"ok"/)
  assert.deepEqual(calls.map((call) => call.args[0]), ['exec', 'new', 'exec', 'exec'])
  assert.equal(bootstraps, 2)
  assert.equal(completions, 1)

  const bootstrapCall = calls[2]
  assert.equal(envValue(bootstrapCall.args, 'WORKSPACE_MODEL_PORT'), '8765')
  assert.equal(
    envValue(bootstrapCall.args, 'WORKSPACE_MODEL_ID'),
    'Qwen/Qwen2.5-Coder-3B-Instruct'
  )
  assert.equal(bootstrapCall.args[bootstrapCall.args.indexOf('--timeout') + 1], '1800')
  assert.equal(bootstrapCall.options.timeoutMs, 1800000 + 60000)

  const completionCall = calls[3]
  const payload = JSON.parse(
    Buffer.from(envValue(completionCall.args, 'WORKSPACE_MODEL_REQUEST'), 'base64').toString()
  )
  assert.deepEqual(payload.messages, REQUEST.messages)
  assert.equal(payload.max_tokens, REQUEST.maxTokens)
  assert.equal(completionCall.args[completionCall.args.indexOf('--timeout') + 1], '900')
  assert.equal(completionCall.options.timeoutMs, 900000 + 60000)

  await client.complete(model, REQUEST)
  assert.deepEqual(calls.map((call) => call.args[0]), [
    'exec', 'new', 'exec', 'exec', 'exec'
  ])
  assert.equal(bootstraps, 2)
  assert.equal(completions, 2)
})

test('Colab reuses an existing session without creating a new one', async () => {
  const calls = []
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args[0] === 'exec' && args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      return { stdout: '', stderr: '' }
    }
    return {
      stdout: `${RESULT_SENTINEL}${JSON.stringify({
        choices: [{ message: { content: 'draft' } }]
      })}`,
      stderr: ''
    }
  }

  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await client.complete(colabModel(), REQUEST)
  assert.deepEqual(calls.map((args) => args[0]), ['exec', 'exec'])
  assert.equal(calls.some((args) => args[0] === 'new'), false)
})

test('Colab surfaces bootstrap failures without creating a session', async () => {
  const calls = []
  const client = createModelClient({
    runCommand: async (command, args) => {
      calls.push(args)
      throw new ModelCallError('pip install failed', 502)
    },
    scriptsDir: SCRIPTS
  })

  await assert.rejects(
    () => client.complete(colabModel(), REQUEST),
    (error) => error instanceof ModelCallError && /pip install failed/.test(error.message)
  )
  assert.deepEqual(calls.map((args) => args[0]), ['exec'])
})

test('Colab reports missing or invalid sentinel output', async () => {
  const runCommand = async (command, args) => {
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) return { stdout: '', stderr: '' }
    return { stdout: 'no result here', stderr: '' }
  }
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(colabModel(), REQUEST),
    (error) => error instanceof ModelCallError && error.status === 502 && /no model output/.test(error.message)
  )

  const invalidRunCommand = async (command, args) => {
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) return { stdout: '', stderr: '' }
    return { stdout: `${RESULT_SENTINEL}{not-json`, stderr: '' }
  }
  const invalidClient = createModelClient({ runCommand: invalidRunCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => invalidClient.complete(colabModel(), REQUEST),
    (error) => error instanceof ModelCallError && /invalid output/.test(error.message)
  )
})

test('Colab re-bootstraps after a failed completion call', async () => {
  const calls = []
  let failCompletion = true
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) return { stdout: '', stderr: '' }
    if (failCompletion) {
      failCompletion = false
      throw new ModelCallError('session expired', 504)
    }
    return {
      stdout: `${RESULT_SENTINEL}${JSON.stringify({
        choices: [{ message: { content: 'draft' } }]
      })}`,
      stderr: ''
    }
  }

  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(() => client.complete(colabModel(), REQUEST), /session expired/)
  await client.complete(colabModel(), REQUEST)
  assert.deepEqual(calls.map((args) => args[0]), ['exec', 'exec', 'exec', 'exec'])
})

test('Colab writes optional request and response audit files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-colab-audit-'))
  const runCommand = async (command, args) => {
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      return { stdout: '', stderr: '' }
    }
    return {
      stdout: `${RESULT_SENTINEL}${JSON.stringify({
        choices: [{ message: { content: '{"description":"ok","acceptance_criteria":"done"}' } }]
      })}`,
      stderr: ''
    }
  }

  try {
    const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
    const model = colabModel({
      cli: { ...colabModel().cli, auditDir: directory }
    })
    await client.complete(model, REQUEST)

    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const entry = JSON.parse(await readFile(join(directory, files[0]), 'utf8'))
    assert.equal(entry.model, 'colab-3b')
    assert.equal(entry.session, 'workspace-qwen')
    assert.equal(entry.status, 'ok')
    assert.deepEqual(entry.request.messages, REQUEST.messages)
    assert.equal(entry.request.maxTokens, REQUEST.maxTokens)
    assert.match(entry.response.content, /"description":"ok"/)
    assert.equal(typeof entry.durationMs, 'number')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Colab audits failed completions without breaking the error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-colab-audit-error-'))
  const runCommand = async (command, args) => {
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      return { stdout: '', stderr: '' }
    }
    throw new ModelCallError('session expired', 504)
  }

  try {
    const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
    const model = colabModel({
      cli: { ...colabModel().cli, auditDir: directory }
    })
    await assert.rejects(
      () => client.complete(model, REQUEST),
      (error) => error instanceof ModelCallError && /session expired/.test(error.message)
    )

    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const entry = JSON.parse(await readFile(join(directory, files[0]), 'utf8'))
    assert.equal(entry.status, 'error')
    assert.equal(entry.error, 'session expired')
    assert.equal(entry.response, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Kaggle writes the task, runs the batch runner, and reads its response', async () => {
  let taskContent
  let invocation
  const runCommand = async (command, args, options) => {
    invocation = { command, args, options }
    taskContent = JSON.parse(await readFile(args[args.indexOf('--task-json') + 1], 'utf8'))
    await writeFile(
      args[args.indexOf('--output') + 1],
      JSON.stringify({
        description: 'Kaggle draft',
        acceptance_criteria: 'Kaggle criteria'
      }),
      'utf8'
    )
    return { stdout: '', stderr: '' }
  }

  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  const result = await client.complete(kaggleModel(), REQUEST)

  assert.equal(invocation.command, 'python3')
  assert.equal(invocation.args[0], join(SCRIPTS, 'kaggle_run.py'))
  assert.equal(invocation.args[invocation.args.indexOf('--timeout') + 1], '3600')
  assert.equal(invocation.args[invocation.args.indexOf('--poll-interval') + 1], '30')
  assert.equal(invocation.args[invocation.args.indexOf('--cancel-fallback') + 1], 'none')
  assert.equal(invocation.options.timeoutMs, 3600000 + 120000)
  assert.deepEqual(taskContent, REQUEST.task)
  assert.deepEqual(JSON.parse(result), {
    description: 'Kaggle draft',
    acceptance_criteria: 'Kaggle criteria'
  })
})

test('Kaggle rejects requests without task fields and invalid outputs', async () => {
  let called = false
  const client = createModelClient({
    runCommand: async () => {
      called = true
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })

  await assert.rejects(
    () => client.complete(kaggleModel(), { messages: REQUEST.messages }),
    (error) => error instanceof ModelCallError && error.status === 500
  )
  assert.equal(called, false)

  const invalidClient = createModelClient({
    runCommand: async (command, args) => {
      await writeFile(args[args.indexOf('--output') + 1], JSON.stringify({ description: 'only' }), 'utf8')
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })
  await assert.rejects(
    () => invalidClient.complete(kaggleModel(), REQUEST),
    (error) => error instanceof ModelCallError && /invalid task response/.test(error.message)
  )
})

test('OpenCode joins the prompt with newlines and parses text events', async () => {
  const calls = []
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options })
    return {
      stdout: [
        JSON.stringify({ type: 'status', part: { text: 'ignored' } }),
        'not a json log line',
        JSON.stringify({ type: 'text', part: { text: 'First chunk' } }),
        JSON.stringify({ type: 'text', part: { text: ' second chunk' } })
      ].join('\r\n'),
      stderr: ''
    }
  }
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  const request = {
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Draft a task' }
    ],
    maxTokens: 120
  }
  const content = await client.complete(opencodeModel(), request)
  assert.equal(content, 'First chunk second chunk')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'opencode')
  assert.equal(calls[0].args[0], 'run')
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'big-pickle')
  assert.equal(calls[0].args[calls[0].args.indexOf('--agent') + 1], 'general')
  assert.equal(calls[0].options.timeoutMs, 300000)

  // The prompt joins messages with real newlines, and the parser splits the
  // CLI's newline-separated events - both regressions of escaped backslashes.
  const prompt = calls[0].args[1]
  assert.equal(prompt, 'system: Be brief.\n\nuser: Draft a task')
})

test('prompt cache is per client instance', async () => {
  let calls = 0
  const runCommand = async () => {
    calls += 1
    return {
      stdout: JSON.stringify({ type: 'text', part: { text: `reply ${calls}` } }),
      stderr: ''
    }
  }
  const options = { runCommand, scriptsDir: SCRIPTS, promptCache: { enabled: true } }
  const first = createModelClient(options)
  assert.equal(await first.complete(opencodeModel(), REQUEST), 'reply 1')
  assert.equal(await first.complete(opencodeModel(), REQUEST), 'reply 1')
  assert.equal(calls, 1, 'the same client reuses its cached completion')

  const second = createModelClient(options)
  assert.equal(await second.complete(opencodeModel(), REQUEST), 'reply 2')
  assert.equal(calls, 2, 'a new client starts with an empty cache')
})

test('OpenCode reports empty CLI output as a model error', async () => {
  const client = createModelClient({
    runCommand: async () => ({ stdout: '\n\n', stderr: '' }),
    scriptsDir: SCRIPTS
  })
  await assert.rejects(
    () => client.complete(opencodeModel(), REQUEST),
    (error) => error instanceof ModelCallError &&
      error.status === 502 &&
      /no model output/.test(error.message)
  )
})

test('OpenCode surfaces CLI error events with status and retry delay', async () => {
  const client = createModelClient({
    runCommand: async () => ({
      stdout: [
        JSON.stringify({ type: 'step_start', part: { id: 'prt_1' } }),
        JSON.stringify({
          type: 'error',
          error: {
            type: 'provider.quota',
            message: 'You exceeded your current quota. Please retry in 19h13m55s.',
            status: 429,
            response: { body: '{"details":[{"retryInfo":{"retryDelay":"69235s"}}]}' }
          }
        })
      ].join('\n'),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })
  await assert.rejects(
    () => client.complete(opencodeModel(), REQUEST),
    (error) => error instanceof ModelCallError &&
      error.status === 429 &&
      error.retryAfter === 69235 &&
      /exceeded your current quota/.test(error.message)
  )
})

test('OpenCode error events honor numeric retry fields and default the status', async () => {
  const rated = createModelClient({
    runCommand: async () => ({
      stdout: JSON.stringify({
        type: 'error',
        error: { message: 'Rate limited.', status: 429, retryAfter: 42 }
      }),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })
  await assert.rejects(
    () => rated.complete(opencodeModel(), REQUEST),
    (error) => error instanceof ModelCallError && error.status === 429 && error.retryAfter === 42
  )

  const statusless = createModelClient({
    runCommand: async () => ({
      stdout: JSON.stringify({ type: 'error', error: { message: 'Something failed.' } }),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })
  await assert.rejects(
    () => statusless.complete(opencodeModel(), REQUEST),
    (error) => error instanceof ModelCallError &&
      error.status === 502 &&
      error.retryAfter === undefined &&
      /Something failed/.test(error.message)
  )
})

test('OpenCode text output wins over an accompanying error event', async () => {
  const client = createModelClient({
    runCommand: async () => ({
      stdout: [
        JSON.stringify({
          type: 'error',
          error: { message: 'A transient warning.', status: 429, retryAfter: 30 }
        }),
        JSON.stringify({ type: 'text', part: { text: 'Recovered output' } })
      ].join('\n'),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })
  const content = await client.complete(opencodeModel(), REQUEST)
  assert.equal(content, 'Recovered output')
})

test('CLI probes are cached per command', async () => {
  const calls = []
  const client = createModelClient({
    runCommand: async (command, args) => {
      calls.push({ command, args })
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })

  assert.deepEqual(await client.probe(colabModel()), {
    ok: true,
    sessionState: 'present'
  })
  assert.deepEqual(await client.probe(colabModel()), {
    ok: true,
    sessionState: 'present'
  })
  assert.deepEqual(await client.probe(kaggleModel()), { ok: true })
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ['colab', ['version']],
    ['colab', ['status', '-s', 'workspace-qwen']],
    ['kaggle', ['--version']]
  ])
})

test('Colab probes report a missing reusable session', async () => {
  const client = createModelClient({
    runCommand: async (command, args) => {
      if (command === 'colab' && args[0] === 'status') {
        return { stdout: "[colab] Session 'workspace-qwen' not found.\n", stderr: '' }
      }
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })

  assert.deepEqual(await client.probe(colabModel()), {
    ok: true,
    sessionState: 'absent'
  })
})

test('CLI probe failures report the missing CLI', async () => {
  const client = createModelClient({
    runCommand: async () => {
      throw new Error('not installed')
    },
    scriptsDir: SCRIPTS
  })
  assert.deepEqual(await client.probe(colabModel()), {
    ok: false,
    error: 'The colab CLI is not installed or not authenticated for Colab model.'
  })
})

test('HTTP probes accept /v1/models and only forward the matching bearer key', async () => {
  const requests = []
  const client = createModelClient({
    apiKey: 'local-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers })
      if (url.endsWith('/health')) return new Response('', { status: 404 })
      return Response.json({ data: [] })
    }
  })

  const local = {
    id: 'local-0.5b',
    label: 'Local',
    backend: 'http',
    remote: false,
    url: 'http://127.0.0.1:8080'
  }
  assert.deepEqual(await client.probe(local), { ok: true })
  assert.equal(requests[0].headers.Authorization, 'Bearer local-secret')

  const remote = {
    id: 'colab-3b',
    label: 'Colab',
    backend: 'http',
    remote: true,
    url: 'https://colab.example'
  }
  await client.probe(remote)
  assert.equal(requests[2].headers.Authorization, undefined)
})

test('Colab falls back through configured GPU shapes after capacity errors', async () => {
  const calls = []
  let bootstraps = 0
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args[0] === 'new') {
      if (args.includes('T4')) throw new ModelCallError('Service Unavailable', 502)
      return { stdout: '', stderr: '' }
    }
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      bootstraps += 1
      if (bootstraps === 1) {
        throw new ModelCallError(
          "colab failed: [colab] Session 'workspace-qwen' not found.",
          502
        )
      }
      return { stdout: '', stderr: '' }
    }
    return {
      stdout: `${RESULT_SENTINEL}${JSON.stringify({
        choices: [{ message: { content: 'draft' } }]
      })}`,
      stderr: ''
    }
  }

  const model = colabModel({
    cli: {
      ...colabModel().cli,
      gpus: ['T4', 'L4'],
      newRetries: 0,
      retryBackoffMs: 0
    }
  })
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  assert.equal(await client.complete(model, REQUEST), 'draft')
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['exec', '-s'],
    ['new', '-s'],
    ['new', '-s'],
    ['exec', '-s'],
    ['exec', '-s']
  ])
  assert.deepEqual(calls[1].slice(-2), ['--gpu', 'T4'])
  assert.deepEqual(calls[2].slice(-2), ['--gpu', 'L4'])
})

test('Colab reports capacity failures with a retry delay', async () => {
  const runCommand = async (command, args) => {
    if (args[0] === 'exec') {
      throw new ModelCallError(
        "colab failed: [colab] Session 'workspace-qwen' not found.",
        502
      )
    }
    throw new ModelCallError('Service Unavailable', 502)
  }

  const model = colabModel({
    cli: {
      ...colabModel().cli,
      gpus: ['T4', 'L4'],
      newRetries: 0,
      retryBackoffMs: 30000
    }
  })
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(model, REQUEST),
    (error) => (
      error instanceof ModelCallError
      && error.status === 503
      && error.retryAfter === 30
      && /could not allocate a GPU/.test(error.message)
    )
  )
})

test('Colab does not retry an accelerator the account cannot use', async () => {
  const calls = []
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args[0] === 'exec') {
      throw new ModelCallError(
        "colab failed: [colab] Session 'workspace-qwen' not found.",
        502
      )
    }
    throw new ModelCallError(
      'rejected accelerator: account does not have quota or entitlement for L4',
      502
    )
  }

  const model = colabModel({
    cli: {
      ...colabModel().cli,
      gpus: ['L4'],
      newRetries: 3,
      retryBackoffMs: 0
    }
  })
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(model, REQUEST),
    (error) => error instanceof ModelCallError && error.status === 503
  )
  assert.equal(calls.filter((args) => args[0] === 'new').length, 1)
})

test('model clients report job phases', async () => {
  const phases = []
  const client = createModelClient({
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: 'draft' } }]
    })
  })
  await client.complete(
    { id: 'http', label: 'HTTP', backend: 'http', url: 'http://model.test' },
    { ...REQUEST, onPhase: (phase) => phases.push(phase) }
  )
  assert.deepEqual(phases, ['generating'])

  const colabPhases = []
  const colabClient = createModelClient({
    runCommand: async (command, args) => {
      if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
        return { stdout: '', stderr: '' }
      }
      return {
        stdout: `${RESULT_SENTINEL}${JSON.stringify({
          choices: [{ message: { content: 'draft' } }]
        })}`,
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })
  await colabClient.complete(colabModel(), {
    ...REQUEST,
    onPhase: (phase) => colabPhases.push(phase)
  })
  assert.deepEqual(colabPhases, ['bootstrapping', 'generating'])

  const kagglePhases = []
  const kaggleClient = createModelClient({
    runCommand: async (command, args) => {
      await writeFile(
        args[args.indexOf('--output') + 1],
        JSON.stringify({ description: 'draft', acceptance_criteria: 'done' }),
        'utf8'
      )
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })
  await kaggleClient.complete(kaggleModel(), {
    ...REQUEST,
    onPhase: (phase) => kagglePhases.push(phase)
  })
  assert.deepEqual(kagglePhases, ['submitting', 'generating'])
})

test('HTTP completions honour a caller abort signal', async () => {
  const controller = new AbortController()
  const client = createModelClient({
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  })

  const pending = client.complete(
    { id: 'http', label: 'HTTP', backend: 'http', url: 'http://model.test', timeoutMs: 60000 },
    { ...REQUEST, signal: controller.signal }
  )
  controller.abort()
  await assert.rejects(
    () => pending,
    (error) => error instanceof ModelCallError && error.status === 499
  )
})

test('HTTP completions report timeouts and rejection statuses', async () => {
  const timeoutClient = createModelClient({
    fetchImpl: async () => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    }
  })
  await assert.rejects(
    () => timeoutClient.complete({ id: 'x', label: 'X', backend: 'http', url: 'http://x', timeoutMs: 10 }, REQUEST),
    (error) => error instanceof ModelCallError && error.status === 504
  )

  const rejectedClient = createModelClient({
    fetchImpl: async () => new Response('nope', { status: 500 })
  })
  await assert.rejects(
    () => rejectedClient.complete({ id: 'x', label: 'X', backend: 'http', url: 'http://x' }, REQUEST),
    (error) => error instanceof ModelCallError && error.status === 502
  )
})

test('HTTP completions send the provider model and gate JSON mode', async () => {
  const bodies = []
  const urls = []
  const client = createModelClient({
    fetchImpl: async (url, options) => {
      urls.push(url)
      bodies.push(JSON.parse(options.body))
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({ description: 'ok', acceptance_criteria: 'done' })
          }
        }]
      })
    }
  })

  await client.complete({
    id: 'serverless',
    label: 'Serverless',
    backend: 'http',
    url: 'https://api.test',
    apiModel: 'provider/model-slug',
    supportsJsonMode: false,
    timeoutMs: 1000
  }, REQUEST)

  assert.deepEqual(urls, ['https://api.test/v1/chat/completions'])
  assert.equal(bodies[0].model, 'provider/model-slug')
  assert.equal('response_format' in bodies[0], false)

  await client.complete({
    id: 'serverless',
    label: 'Serverless',
    backend: 'http',
    url: 'https://api.test',
    chatPath: '/chat/completions',
    timeoutMs: 1000
  }, REQUEST)

  assert.deepEqual(urls, [
    'https://api.test/v1/chat/completions',
    'https://api.test/chat/completions'
  ])
  assert.equal(bodies[1].model, 'serverless')
  assert.deepEqual(bodies[1].response_format, { type: 'json_object' })
})

test('HTTP 429 responses expose a numeric Retry-After', async () => {
  const client = createModelClient({
    fetchImpl: async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '17' }
    })
  })

  await assert.rejects(
    () => client.complete(
      { id: 'x', label: 'X', backend: 'http', url: 'http://x', timeoutMs: 10 },
      REQUEST
    ),
    (error) => error instanceof ModelCallError
      && error.status === 429
      && error.retryAfter === 17
      && /rate-limited/.test(error.message)
  )
})

test('HTTP 429 responses parse an HTTP-date Retry-After', async () => {
  const client = createModelClient({
    fetchImpl: async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': new Date(Date.now() + 30000).toUTCString() }
    })
  })

  await assert.rejects(
    () => client.complete(
      { id: 'x', label: 'X', backend: 'http', url: 'http://x', timeoutMs: 10 },
      REQUEST
    ),
    (error) => error instanceof ModelCallError
      && error.status === 429
      && error.retryAfter >= 25
      && error.retryAfter <= 31
  )
})

test('HTTP probes honour a configured health path', async () => {
  const urls = []
  const client = createModelClient({
    fetchImpl: async (url) => {
      urls.push(url)
      return new Response('', { status: url.endsWith('/models') ? 200 : 404 })
    }
  })

  const result = await client.probe({
    id: 'serverless',
    label: 'Serverless',
    backend: 'http',
    url: 'https://api.test',
    healthPath: '/models'
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(urls, ['https://api.test/health', 'https://api.test/models'])
})

test('HTTP completions report token usage to the caller', async () => {
  const usages = []
  const client = createModelClient({
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: 'draft' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
  })

  await client.complete(
    { id: 'x', label: 'X', backend: 'http', url: 'http://x', timeoutMs: 10 },
    { ...REQUEST, onUsage: (usage) => usages.push(usage) }
  )

  assert.deepEqual(usages, [
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
  ])
})

test('HTTP completions report missing usage instead of guessing', async () => {
  const usages = []
  const client = createModelClient({
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: 'draft' } }]
    })
  })

  await client.complete(
    { id: 'x', label: 'X', backend: 'http', url: 'http://x', timeoutMs: 10 },
    { ...REQUEST, onUsage: (usage) => usages.push(usage) }
  )

  assert.deepEqual(usages, [undefined])
})

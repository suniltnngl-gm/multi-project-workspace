import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createModelClient,
  ModelCallError,
  parseColabStatus,
  parseGeminiApiOutput,
  parseGeminiApiWhoami
} from '../src/modelClient.js'

const SCRIPTS = '/workspace/scripts'
const RESULT_SENTINEL = '__WORKSPACE_MODEL_RESULT__'

// Tests run through scripts/with-env.mjs under self-check, so the workspace
// .env can enable the prompt cache. An identical second request would then
// return the first reply and hide the behavior under test, so every client
// starts with the cache off; the cache-specific test opts back in.
function createClient(options = {}) {
  return createModelClient({ promptCache: { enabled: false }, ...options })
}

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

function agyModel(overrides = {}) {
  return {
    id: 'agy',
    label: 'Antigravity headless',
    backend: 'agy-cli',
    remote: true,
    timeoutMs: 300000,
    cli: {
      command: 'agy',
      probeArgs: ['--version'],
      model: 'gemini-3.8-flash-medium',
      agent: 'planner',
      effort: 'medium'
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

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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

test('Colab fails fast when the runtime is CPU-backed and a GPU is required', async () => {
  const calls = []
  const client = createClient({
    runCommand: async (command, args) => {
      calls.push(args)
      if (args[0] === 'status') {
        return {
          stdout: '[workspace-qwen] m-s-x | Hardware: CPU | Shape: Standard | Variant: DEFAULT | Status: IDLE',
          stderr: ''
        }
      }
      throw new Error(`unexpected ${args.join(' ')}`)
    },
    scriptsDir: SCRIPTS
  })
  const model = colabModel({ cli: { ...colabModel().cli, requireGpu: true } })

  await assert.rejects(
    () => client.complete(model, REQUEST),
    (error) => error instanceof ModelCallError
      && error.status === 503
      && error.code === 'gpu_unavailable'
      && error.retryAfter === 15
      && error.details.hardware === 'CPU'
      && /cannot load on CPU/.test(error.message)
  )
  // No bootstrap, no model download: the failure is decided by `status`.
  assert.deepEqual(calls, [['status', '-s', 'workspace-qwen']])
})

test('Colab verifies the GPU allocation after creating a session', async () => {
  const calls = []
  let statusCalls = 0
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args[0] === 'status') {
      statusCalls += 1
      return {
        stdout: statusCalls === 1
          ? "[colab] Session 'workspace-qwen' not found."
          : '[workspace-qwen] m-s-x | Hardware: T4 | Shape: Standard | Variant: GPU | Status: IDLE',
        stderr: ''
      }
    }
    if (args[0] === 'new') return { stdout: '', stderr: '' }
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      return { stdout: 'WORKSPACE_COLAB_READY\n', stderr: '' }
    }
    return {
      stdout: `${RESULT_SENTINEL}${JSON.stringify({
        choices: [{ message: { content: 'draft' } }]
      })}`,
      stderr: ''
    }
  }

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  const model = colabModel({ cli: { ...colabModel().cli, requireGpu: true } })
  assert.equal(await client.complete(model, REQUEST), 'draft')
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'new', 'status', 'exec', 'exec'])
})

test('Colab rejects a silent CPU allocation after creating a session', async () => {
  const calls = []
  let statusCalls = 0
  const client = createClient({
    runCommand: async (command, args) => {
      calls.push(args)
      if (args[0] === 'status') {
        statusCalls += 1
        return {
          stdout: statusCalls === 1
            ? "[colab] Session 'workspace-qwen' not found."
            : '[workspace-qwen] m-s-x | Hardware: CPU | Shape: Standard | Variant: DEFAULT | Status: IDLE',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })
  const model = colabModel({ cli: { ...colabModel().cli, requireGpu: true } })

  await assert.rejects(
    () => client.complete(model, REQUEST),
    (error) => error instanceof ModelCallError
      && error.code === 'gpu_unavailable'
      && /requires a GPU/.test(error.message)
  )
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'new', 'status'])
})

test('parseColabStatus distinguishes CPU, GPU, and missing hardware data', () => {
  assert.equal(parseColabStatus('Hardware: CPU | Variant: DEFAULT').gpu, false)
  assert.equal(parseColabStatus('Hardware: T4 | Variant: GPU').gpu, true)
  assert.equal(parseColabStatus('Hardware: L4 | Variant: DEFAULT').gpu, true)
  assert.equal(parseColabStatus('').gpu, null)
  assert.equal(parseColabStatus("[colab] Session 'x' not found.").absent, true)
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

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  await client.complete(colabModel(), REQUEST)
  assert.deepEqual(calls.map((args) => args[0]), ['exec', 'exec'])
  assert.equal(calls.some((args) => args[0] === 'new'), false)
})

test('Colab surfaces bootstrap failures without creating a session', async () => {
  const calls = []
  const client = createClient({
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
  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(colabModel(), REQUEST),
    (error) => error instanceof ModelCallError && error.status === 502 && /no model output/.test(error.message)
  )

  const invalidRunCommand = async (command, args) => {
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) return { stdout: '', stderr: '' }
    return { stdout: `${RESULT_SENTINEL}{not-json`, stderr: '' }
  }
  const invalidClient = createClient({ runCommand: invalidRunCommand, scriptsDir: SCRIPTS })
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

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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
    const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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
    const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  const result = await client.complete(kaggleModel(), REQUEST)

  assert.equal(invocation.command, 'python3')
  assert.equal(invocation.args[0], join(SCRIPTS, 'kaggle_run.py'))
  assert.equal(invocation.args[invocation.args.indexOf('--timeout') + 1], '3600')
  assert.equal(invocation.args[invocation.args.indexOf('--poll-interval') + 1], '30')
  assert.equal(invocation.args[invocation.args.indexOf('--cancel-fallback') + 1], 'none')
  assert.equal(invocation.args.includes('--manifest-dir'), false)
  assert.equal(invocation.options.timeoutMs, 3600000 + 120000)
  assert.deepEqual(taskContent, REQUEST.task)
  assert.deepEqual(JSON.parse(result), {
    description: 'Kaggle draft',
    acceptance_criteria: 'Kaggle criteria'
  })
})

test('Kaggle passes the resume manifest directory when configured', async () => {
  let invocation
  const runCommand = async (command, args) => {
    invocation = { command, args }
    await writeFile(
      args[args.indexOf('--output') + 1],
      JSON.stringify({ description: 'draft', acceptance_criteria: 'done' }),
      'utf8'
    )
    return { stdout: '', stderr: '' }
  }

  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  const model = kaggleModel({
    cli: { ...kaggleModel().cli, manifestDir: '/tmp/workspace-kaggle-runs' }
  })
  await client.complete(model, REQUEST)

  assert.equal(
    invocation.args[invocation.args.indexOf('--manifest-dir') + 1],
    '/tmp/workspace-kaggle-runs'
  )
})

test('Kaggle rejects requests without task fields and invalid outputs', async () => {
  let called = false
  const client = createClient({
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

  const invalidClient = createClient({
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
  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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
  const first = createClient(options)
  assert.equal(await first.complete(opencodeModel(), REQUEST), 'reply 1')
  assert.equal(await first.complete(opencodeModel(), REQUEST), 'reply 1')
  assert.equal(calls, 1, 'the same client reuses its cached completion')

  const second = createClient(options)
  assert.equal(await second.complete(opencodeModel(), REQUEST), 'reply 2')
  assert.equal(calls, 2, 'a new client starts with an empty cache')
})

test('prompt cache key includes the effective CLI model and agent', async () => {
  let calls = 0
  const runCommand = async () => {
    calls += 1
    return {
      stdout: JSON.stringify({ type: 'text', part: { text: `reply ${calls}` } }),
      stderr: ''
    }
  }
  const client = createClient({
    runCommand,
    scriptsDir: SCRIPTS,
    promptCache: { enabled: true }
  })

  const first = opencodeModel()
  assert.equal(await client.complete(first, REQUEST), 'reply 1')
  assert.equal(await client.complete(first, REQUEST), 'reply 1')
  assert.equal(calls, 1)

  const nextModel = opencodeModel({
    cli: { ...first.cli, model: 'console-groq/openai/gpt-oss-120b' }
  })
  assert.equal(await client.complete(nextModel, REQUEST), 'reply 2')
  assert.equal(calls, 2, 'a model switch must not reuse the previous model reply')

  const nextAgent = opencodeModel({
    cli: { ...first.cli, agent: 'build' }
  })
  assert.equal(await client.complete(nextAgent, REQUEST), 'reply 3')
  assert.equal(calls, 3, 'an agent switch must not reuse the previous agent reply')
})

test('OpenCode reports empty CLI output as a model error', async () => {
  const client = createClient({
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
  const client = createClient({
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
  const rated = createClient({
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

  const statusless = createClient({
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
  const client = createClient({
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

test('Colab, Kaggle, and OpenCode settle computeSeconds and token usage via onUsage', async () => {
  const colabUsages = []
  const colabClient = createClient({
    runCommand: async (_command, args) => {
      if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
        return { stdout: '', stderr: '' }
      }
      return {
        stdout: `${RESULT_SENTINEL}${JSON.stringify({
          choices: [{ message: { content: 'colab reply' } }]
        })}`,
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })
  assert.equal(
    await colabClient.complete(colabModel(), {
      ...REQUEST,
      onUsage: (usage) => colabUsages.push(usage)
    }),
    'colab reply'
  )
  assert.equal(colabUsages.length, 1)
  assert.ok(Number.isFinite(colabUsages[0].computeSeconds) && colabUsages[0].computeSeconds >= 1)

  const kaggleUsages = []
  const kaggleClient = createClient({
    runCommand: async (_command, args) => {
      const outputIndex = args.indexOf('--output')
      const outputPath = args[outputIndex + 1]
      await writeFile(
        outputPath,
        JSON.stringify({
          description: 'from kaggle',
          acceptance_criteria: 'done',
          compute_seconds: 42
        }),
        'utf8'
      )
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })
  await kaggleClient.complete(kaggleModel(), {
    ...REQUEST,
    onUsage: (usage) => kaggleUsages.push(usage)
  })
  assert.deepEqual(kaggleUsages, [{ computeSeconds: 42 }])

  const opencodeUsages = []
  const opencodeClient = createClient({
    runCommand: async () => ({
      stdout: [
        JSON.stringify({ type: 'text', sessionID: 'ses_usage', part: { text: 'opencode reply' } }),
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses_usage',
          part: {
            tokens: { input: 90, output: 25, reasoning: 5, total: 120 }
          }
        })
      ].join('\n'),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })
  assert.equal(
    await opencodeClient.complete(opencodeModel(), {
      ...REQUEST,
      onUsage: (usage) => opencodeUsages.push(usage)
    }),
    'opencode reply'
  )
  assert.deepEqual(opencodeUsages, [{
    promptTokens: 90,
    completionTokens: 30,
    totalTokens: 120
  }])
})

test('OpenCode reuses the session ID per model, agent, and worktree', async () => {
  const calls = []
  const sessionIds = ['ses_model_a', 'ses_model_b', 'ses_agent_build', 'ses_worktree_a']
  const client = createClient({
    runCommand: async (command, args) => {
      calls.push({ command, args })
      const sessionIndex = args.indexOf('--session')
      const sessionID = sessionIndex >= 0 ? args[sessionIndex + 1] : sessionIds.shift()
      return {
        stdout: JSON.stringify({
          type: 'text',
          sessionID,
          part: { text: `reply:${sessionID}` }
        }),
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })

  const base = opencodeModel()
  assert.equal(await client.complete(base, REQUEST), 'reply:ses_model_a')
  assert.equal(calls[0].args.includes('--session'), false)

  assert.equal(await client.complete(base, REQUEST), 'reply:ses_model_a')
  assert.equal(calls[1].args[calls[1].args.indexOf('--session') + 1], 'ses_model_a')

  const otherModel = opencodeModel({
    cli: { ...base.cli, model: 'console-groq/openai/gpt-oss-120b' }
  })
  assert.equal(await client.complete(otherModel, REQUEST), 'reply:ses_model_b')
  assert.equal(calls[2].args.includes('--session'), false)
  assert.equal(await client.complete(otherModel, REQUEST), 'reply:ses_model_b')
  assert.equal(calls[3].args[calls[3].args.indexOf('--session') + 1], 'ses_model_b')

  const otherAgent = opencodeModel({
    cli: { ...base.cli, agent: 'build' }
  })
  assert.equal(await client.complete(otherAgent, REQUEST), 'reply:ses_agent_build')
  assert.equal(calls[4].args.includes('--session'), false)

  assert.equal(
    await client.complete(base, { ...REQUEST, worktreePath: '/tmp/worktree-a' }),
    'reply:ses_worktree_a'
  )
  assert.equal(calls[5].args.includes('--session'), false)
})

test('OpenCode drops a missing cached session and retries with a fresh session', async () => {
  const calls = []
  const client = createClient({
    runCommand: async (command, args) => {
      calls.push(args)
      const sessionIndex = args.indexOf('--session')
      const passedSession = sessionIndex >= 0 ? args[sessionIndex + 1] : null
      if (calls.length === 1) {
        return {
          stdout: JSON.stringify({
            type: 'text',
            sessionID: 'ses_stale',
            part: { text: 'initial' }
          }),
          stderr: ''
        }
      }
      if (passedSession === 'ses_stale') {
        return {
          stdout: JSON.stringify({
            type: 'error',
            sessionID: 'ses_stale',
            error: { message: 'SessionNotFoundError: Session not found' }
          }),
          stderr: ''
        }
      }
      return {
        stdout: JSON.stringify({
          type: 'text',
          sessionID: 'ses_fresh',
          part: { text: 'recovered' }
        }),
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })

  const model = opencodeModel()
  assert.equal(await client.complete(model, REQUEST), 'initial')
  assert.equal(await client.complete(model, REQUEST), 'recovered')
  assert.equal(calls.length, 3)
  assert.equal(calls[1][calls[1].indexOf('--session') + 1], 'ses_stale')
  assert.equal(calls[2].includes('--session'), false)

  assert.equal(await client.complete(model, REQUEST), 'recovered')
  assert.equal(calls[3][calls[3].indexOf('--session') + 1], 'ses_fresh')
})

test('agy probes with --version and completes headless JSON with usage accounting', async () => {
  const calls = []
  const reportedUsage = []
  const client = createClient({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === '--version') {
        return { stdout: '1.5.8\n', stderr: '' }
      }
      return {
        stdout: JSON.stringify({
          conversation_id: 'conv-1',
          status: 'SUCCESS',
          response: 'draft from agy',
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            thinking_tokens: 10,
            total_tokens: 160
          }
        }),
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })

  assert.deepEqual(await client.probe(agyModel()), { ok: true })
  assert.deepEqual(calls[0].args, ['--version'])

  const content = await client.complete(agyModel(), {
    ...REQUEST,
    onUsage: (usage) => reportedUsage.push(usage)
  })
  assert.equal(content, 'draft from agy')
  assert.equal(calls[1].command, 'agy')
  assert.equal(calls[1].args[0], '--print')
  assert.ok(calls[1].args.includes('--output-format'))
  assert.equal(calls[1].args[calls[1].args.indexOf('--output-format') + 1], 'json')
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'gemini-3.8-flash-medium')
  assert.equal(calls[1].args[calls[1].args.indexOf('--agent') + 1], 'planner')
  assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'medium')
  assert.deepEqual(reportedUsage, [{
    promptTokens: 120,
    completionTokens: 40,
    totalTokens: 160
  }])
})

test('agy reuses conversation IDs per model, agent, effort, and worktree', async () => {
  const calls = []
  const conversationIds = ['conv-a', 'conv-b', 'conv-agent', 'conv-effort', 'conv-wt']
  const client = createClient({
    runCommand: async (command, args) => {
      calls.push({ command, args })
      const index = args.indexOf('--conversation')
      const conversationId = index >= 0 ? args[index + 1] : conversationIds.shift()
      return {
        stdout: JSON.stringify({
          conversation_id: conversationId,
          status: 'SUCCESS',
          response: `reply:${conversationId}`
        }),
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })

  const base = agyModel()
  assert.equal(await client.complete(base, REQUEST), 'reply:conv-a')
  assert.equal(calls[0].args.includes('--conversation'), false)

  assert.equal(await client.complete(base, REQUEST), 'reply:conv-a')
  assert.equal(calls[1].args[calls[1].args.indexOf('--conversation') + 1], 'conv-a')

  const otherModel = agyModel({ cli: { ...base.cli, model: 'gemini-4-argon-high' } })
  assert.equal(await client.complete(otherModel, REQUEST), 'reply:conv-b')
  assert.equal(calls[2].args.includes('--conversation'), false)

  const otherAgent = agyModel({ cli: { ...base.cli, agent: 'coder' } })
  assert.equal(await client.complete(otherAgent, REQUEST), 'reply:conv-agent')
  assert.equal(calls[3].args.includes('--conversation'), false)

  const otherEffort = agyModel({ cli: { ...base.cli, effort: 'high' } })
  assert.equal(await client.complete(otherEffort, REQUEST), 'reply:conv-effort')
  assert.equal(calls[4].args.includes('--conversation'), false)

  assert.equal(
    await client.complete(base, { ...REQUEST, worktreePath: '/tmp/worktree-agy' }),
    'reply:conv-wt'
  )
  assert.equal(calls[5].args.includes('--conversation'), false)
})

test('agy drops a missing cached conversation and retries with a fresh one', async () => {
  const calls = []
  const client = createClient({
    runCommand: async (_command, args) => {
      calls.push(args)
      const index = args.indexOf('--conversation')
      const passed = index >= 0 ? args[index + 1] : null
      if (calls.length === 1) {
        return {
          stdout: JSON.stringify({
            conversation_id: 'conv-stale',
            status: 'SUCCESS',
            response: 'initial'
          }),
          stderr: ''
        }
      }
      if (passed === 'conv-stale') {
        return {
          stdout: JSON.stringify({
            status: 'ERROR',
            error: 'Conversation not found: conv-stale'
          }),
          stderr: ''
        }
      }
      return {
        stdout: JSON.stringify({
          conversation_id: 'conv-fresh',
          status: 'SUCCESS',
          response: 'recovered'
        }),
        stderr: ''
      }
    },
    scriptsDir: SCRIPTS
  })

  const model = agyModel()
  assert.equal(await client.complete(model, REQUEST), 'initial')
  assert.equal(await client.complete(model, REQUEST), 'recovered')
  assert.equal(calls.length, 3)
  assert.equal(calls[1][calls[1].indexOf('--conversation') + 1], 'conv-stale')
  assert.equal(calls[2].includes('--conversation'), false)

  assert.equal(await client.complete(model, REQUEST), 'recovered')
  assert.equal(calls[3][calls[3].indexOf('--conversation') + 1], 'conv-fresh')
})

test('agy maps rate-limit responses to HTTP 429 with retryAfter', async () => {
  const client = createClient({
    runCommand: async () => ({
      stdout: JSON.stringify({
        status: 'ERROR',
        error: 'RESOURCE_EXHAUSTED: rate limit exceeded, retry after 42s'
      }),
      stderr: ''
    }),
    scriptsDir: SCRIPTS
  })

  await assert.rejects(
    () => client.complete(agyModel(), REQUEST),
    (error) => {
      assert.ok(error instanceof ModelCallError)
      assert.equal(error.status, 429)
      assert.equal(error.retryAfter, 42)
      return true
    }
  )
})

test('CLI probes are cached per command', async () => {
  const calls = []
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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
  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
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
  const client = createClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(model, REQUEST),
    (error) => error instanceof ModelCallError && error.status === 503
  )
  assert.equal(calls.filter((args) => args[0] === 'new').length, 1)
})

test('model clients report job phases', async () => {
  const phases = []
  const client = createClient({
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
  const colabClient = createClient({
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
  const kaggleClient = createClient({
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
  const client = createClient({
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
  const timeoutClient = createClient({
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

  const rejectedClient = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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
  const client = createClient({
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

test('gemini-api probes via whoami [keyring], strips GEMINI_API_KEY, and parses interactions JSON + errors', async () => {
  const whoamiOk = parseGeminiApiWhoami(`
Configuration
=============
Credentials:
  --api-key                   [keyring] AQ******Iw
  --access-token              [unset  ] (not set)
`)
  assert.deepEqual(whoamiOk, { ok: true, source: 'keyring' })

  const whoamiUnset = parseGeminiApiWhoami(`
Credentials:
  --api-key                   [unset  ] (not set)
`)
  assert.equal(whoamiUnset.ok, false)
  assert.match(whoamiUnset.error, /\[keyring\]/)

  const parsedInteraction = parseGeminiApiOutput(JSON.stringify({
    id: 'v1_interaction_123',
    status: 'completed',
    model: 'gemini-3.8-flash',
    steps: [
      { type: 'thought', signature: 'sig' },
      { type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }
    ],
    usage: {
      total_input_tokens: 12,
      total_output_tokens: 6,
      total_thought_tokens: 8,
      total_tokens: 26
    }
  }))
  assert.equal(parsedInteraction.interactionId, 'v1_interaction_123')
  assert.equal(parsedInteraction.text, '{"ok":true}')
  assert.deepEqual(parsedInteraction.usage, {
    promptTokens: 12,
    completionTokens: 14,
    totalTokens: 26
  })

  const calls = []
  const usages = []
  const prevEnvKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'should-never-reach-gemini-api-child'
  try {
    const client = createClient({
      runCommand: async (command, args, options) => {
        calls.push({ command, args, envHasGeminiApiKey: 'GEMINI_API_KEY' in (options?.env ?? {}) })
        if (args[0] === 'whoami') {
          return {
            stdout: '  --api-key                   [keyring] AQ******Iw\n',
            stderr: ''
          }
        }
        if (args.includes('--model') && args[args.indexOf('--model') + 1] === 'gemini-3.5-flash-lite') {
          return {
            stdout: '',
            stderr: 'Error 403 FREE_TIER_VERIFICATION_REQUIRED: verify your AI Studio project'
          }
        }
        return {
          stdout: JSON.stringify({
            id: `v1_turn_${calls.length}`,
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }],
            usage: { total_input_tokens: 4, total_output_tokens: 1, total_thought_tokens: 5, total_tokens: 10 }
          }),
          stderr: ''
        }
      }
    })

    const geminiModel = {
      id: 'gemini-api',
      label: 'Gemini API CLI',
      backend: 'gemini-api-cli',
      remote: true,
      timeoutMs: 30000,
      cli: {
        command: 'gemini-api',
        probeArgs: ['whoami'],
        model: 'gemini-3.8-flash'
      }
    }

    const probeResult = await client.probe(geminiModel)
    assert.deepEqual(probeResult, { ok: true, source: 'keyring' })
    assert.equal(calls[0].envHasGeminiApiKey, false)

    const reply1 = await client.complete(geminiModel, {
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Reply OK' }
      ],
      sessionKey: 's1',
      onUsage: (u) => usages.push(u)
    })
    assert.equal(reply1, 'OK')
    assert.equal(calls[1].command, 'gemini-api')
    assert.equal(calls[1].envHasGeminiApiKey, false)
    assert.ok(!calls[1].args.includes('--api-key'))
    assert.ok(calls[1].args.includes('--stream=false'))
    assert.ok(calls[1].args.includes('--output-format'))
    assert.ok(calls[1].args.includes('json'))
    assert.ok(calls[1].args.includes('--system'))
    assert.deepEqual(usages[0], { promptTokens: 4, completionTokens: 6, totalTokens: 10 })

    await client.complete(geminiModel, {
      messages: [{ role: 'user', content: 'Follow up' }],
      sessionKey: 's1'
    })
    assert.ok(calls[2].args.includes('--previous-interaction-id'))
    assert.equal(calls[2].args[calls[2].args.indexOf('--previous-interaction-id') + 1], 'v1_turn_2')

    await assert.rejects(
      () => client.complete({
        ...geminiModel,
        cli: { ...geminiModel.cli, model: 'gemini-3.5-flash-lite' }
      }, { messages: [{ role: 'user', content: 'hi' }] }),
      (error) => error instanceof ModelCallError && error.status === 403 && error.code === 'free_tier_verification_required'
    )

    await assert.rejects(
      () => client.complete({
        ...geminiModel,
        cli: { ...geminiModel.cli, model: 'gemini-4-argon-medium' }
      }, { messages: [{ role: 'user', content: 'hi' }] }),
      (error) => error instanceof ModelCallError && error.status === 400 && error.code === 'pro_only_model'
    )
  } finally {
    if (prevEnvKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = prevEnvKey
  }
})

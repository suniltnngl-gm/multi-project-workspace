import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
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

test('Colab calls bootstrap a session once and reuse it for later requests', async () => {
  const calls = []
  let bootstraps = 0
  let completions = 0
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === 'status') throw new Error('session not found')
    if (args[0] === 'new') return { stdout: '', stderr: '' }
    if (args[0] === 'exec' && args.includes(join(SCRIPTS, 'colab_model_server.py'))) {
      bootstraps += 1
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
  assert.deepEqual(calls.map((call) => call.args[0]), ['status', 'new', 'exec', 'exec'])
  assert.equal(bootstraps, 1)
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
    'status', 'new', 'exec', 'exec', 'exec'
  ])
  assert.equal(bootstraps, 1)
  assert.equal(completions, 2)
})

test('Colab reuses an existing session without creating a new one', async () => {
  const calls = []
  const runCommand = async (command, args) => {
    calls.push(args)
    if (args[0] === 'status') return { stdout: 'active', stderr: '' }
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
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'exec', 'exec'])
  assert.equal(calls.some((args) => args[0] === 'new'), false)
})

test('Colab reports missing or invalid sentinel output', async () => {
  const runCommand = async (command, args) => {
    if (args[0] === 'status') return { stdout: '', stderr: '' }
    if (args.includes(join(SCRIPTS, 'colab_model_server.py'))) return { stdout: '', stderr: '' }
    return { stdout: 'no result here', stderr: '' }
  }
  const client = createModelClient({ runCommand, scriptsDir: SCRIPTS })
  await assert.rejects(
    () => client.complete(colabModel(), REQUEST),
    (error) => error instanceof ModelCallError && error.status === 502 && /no model output/.test(error.message)
  )

  const invalidRunCommand = async (command, args) => {
    if (args[0] === 'status') return { stdout: '', stderr: '' }
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
    if (args[0] === 'status') return { stdout: '', stderr: '' }
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
  assert.deepEqual(calls.map((args) => args[0]), ['status', 'exec', 'exec', 'status', 'exec', 'exec'])
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

test('CLI probes are cached per command', async () => {
  const calls = []
  const client = createModelClient({
    runCommand: async (command, args) => {
      calls.push({ command, args })
      return { stdout: '', stderr: '' }
    },
    scriptsDir: SCRIPTS
  })

  assert.deepEqual(await client.probe(colabModel()), { ok: true })
  assert.deepEqual(await client.probe(colabModel()), { ok: true })
  assert.deepEqual(await client.probe(kaggleModel()), { ok: true })
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ['colab', ['version']],
    ['kaggle', ['--version']]
  ])
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
    error: 'The colab CLI is not available for Colab model.'
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

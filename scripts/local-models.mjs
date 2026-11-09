import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EXTERNAL_MODEL_DEFINITIONS, planLocalModelLaunches } from '../apps/api/src/modelRegistry.js'

async function getAvailableMemoryMb() {
  if (process.platform !== 'linux') return Infinity
  try {
    const contents = await readFile('/proc/meminfo', 'utf8')
    const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
    return match ? Number(match[1]) / 1024 : Infinity
  } catch {
    return Infinity
  }
}

function readIntegerEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

const requested = process.argv[2] ?? 'all'
const availableMemoryMb = await getAvailableMemoryMb()
const plans = planLocalModelLaunches({ requested, availableMemoryMb })
const llamaServer = process.env.LLAMA_SERVER || path.join(os.homedir(), '.local/bin/llama-server')
const context = readIntegerEnv('LOCAL_AI_CONTEXT', 1024)
const threads = readIntegerEnv('LOCAL_AI_THREADS', 2)

for (const plan of plans) {
  if (!plan.exists) {
    console.warn(`Skipping ${plan.label}: model file not found at ${plan.modelPath}`)
  } else if (!plan.fits) {
    console.warn(
      `Skipping ${plan.label}: needs ${plan.minAvailableMemoryMb} MB free, ` +
      `only ${Math.floor(availableMemoryMb)} MB available`
    )
  }
}

const startable = plans.filter((plan) => plan.exists && plan.fits)
if (startable.length === 0) {
  console.error('No local models could be started.')
  process.exit(1)
}

if (!existsSync(llamaServer)) {
  console.error(`llama-server is not executable: ${llamaServer}`)
  process.exit(1)
}

const children = new Map()
let stopping = false
let forced = false

function stopAll(signal = 'SIGTERM') {
  if (stopping) {
    if (!forced) {
      forced = true
      for (const child of children.values()) child.kill('SIGKILL')
    }
    return
  }
  stopping = true
  for (const child of children.values()) {
    if (child.exitCode === null) child.kill(signal)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(signal))
}

for (const plan of startable) {
  const args = [
    '-m', plan.modelPath,
    '--host', '127.0.0.1',
    '--port', String(plan.port),
    '-c', String(context),
    '-t', String(threads)
  ]
  console.log(`Starting ${plan.label} on http://127.0.0.1:${plan.port}`)
  const child = spawn(llamaServer, args, { stdio: 'inherit' })
  children.set(plan.id, child)

  child.on('error', (error) => {
    console.error(`Could not start ${plan.label}: ${error.message}`)
    stopAll()
    process.exitCode = 1
  })

  child.on('exit', (code, signal) => {
    children.delete(plan.id)
    if (stopping) {
      if (children.size === 0) process.exitCode = process.exitCode ?? 0
      return
    }
    console.error(`${plan.label} exited (${code ?? signal}). Stopping the other local models.`)
    stopAll()
    process.exitCode = code || 1
  })
}

const externalLabels = EXTERNAL_MODEL_DEFINITIONS
  .map((model) => `${model.label} [${model.execution}]`)
  .join(', ')
console.log(`External models are tracked but not launched: ${externalLabels}.`)

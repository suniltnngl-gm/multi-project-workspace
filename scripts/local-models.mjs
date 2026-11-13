import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EXTERNAL_MODEL_DEFINITIONS, planLocalModelLaunches } from '../apps/api/src/modelRegistry.js'

async function getAvailableMemoryMb() {
  if (process.platform !== 'linux') {
    // freemem() is available on macOS and Windows. It is conservative on
    // macOS, which only means a model may be skipped rather than overcommitted.
    const bytes = os.freemem()
    return Number.isFinite(bytes) && bytes > 0 ? bytes / (1024 * 1024) : Infinity
  }
  try {
    const contents = await readFile('/proc/meminfo', 'utf8')
    const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
    return match ? Number(match[1]) / 1024 : Infinity
  } catch {
    return Infinity
  }
}

// Resolve a command against PATH so llama-server works from any install
// location, including a PATH entry on Windows with an .exe suffix.
function resolveExecutable(command) {
  if (!command) return null
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    if (!cleanDirectory) continue
    for (const extension of extensions) {
      const candidate = path.join(cleanDirectory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
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
const llamaServer = resolveExecutable(process.env.LLAMA_SERVER || 'llama-server')
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

if (!llamaServer) {
  console.error(
    'llama-server was not found. Add llama.cpp to PATH or set LLAMA_SERVER to its full path.'
  )
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

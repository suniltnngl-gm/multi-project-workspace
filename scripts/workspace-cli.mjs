#!/usr/bin/env node
// Objective: Provide one cross-platform launcher for every workspace command.
// Requirements: Match the historical ./workspace commands on Linux, macOS, and native Windows; never call POSIX-only tools directly; keep output and exit codes stable.
// Decisions: Node owns process spawning, ports, HTTP requests, and file work so the same code runs on every OS; the POSIX `workspace` and Windows `workspace.cmd` files are thin shims around this script.
// Relevant Files: workspace-cli.mjs, workspace, workspace.cmd, scripts/env.mjs, scripts/with-env.mjs, package.json
// Important Context: User file. The CLI loads the workspace .env once and passes it to every child process.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { connect } from 'node:net'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'

const SCRIPT_PATH = join(ROOT_DIR, 'scripts', 'workspace-cli.mjs')
const ENV_FILE = join(ROOT_DIR, '.env')

loadWorkspaceEnv()

const WEB_PORT = process.env.WEB_PORT || '5173'
const API_PORT = process.env.PORT || '3001'
const PYTHON_PORT = process.env.PYTHON_PORT || '3002'
process.env.WEB_PORT = WEB_PORT
process.env.PYTHON_PORT = PYTHON_PORT

const useColor = Boolean(process.stdout.isTTY)
const C = {
  reset: useColor ? '\u001b[0m' : '',
  bold: useColor ? '\u001b[1m' : '',
  blue: useColor ? '\u001b[34m' : '',
  green: useColor ? '\u001b[32m' : '',
  yellow: useColor ? '\u001b[33m' : '',
  red: useColor ? '\u001b[31m' : ''
}

const log = (message) => console.log(message)
const info = (message) => console.log(`${C.blue}${message}${C.reset}`)
const success = (message) => console.log(`${C.green}${message}${C.reset}`)
const warn = (message) => console.error(`${C.yellow}${message}${C.reset}`)
const error = (message) => console.error(`${C.red}${message}${C.reset}`)

class CliError extends Error {
  constructor(message, code = 1, { printed = false } = {}) {
    super(message)
    this.code = code
    this.printed = printed
  }
}

function fail(message, code = 1) {
  error(message)
  throw new CliError(message, code, { printed: true })
}

function reportFailure(cause) {
  if (cause instanceof CliError) {
    if (!cause.printed) error(cause.message)
    return cause.code
  }
  error(cause instanceof Error ? cause.message : String(cause))
  return 1
}

function which(command) {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    if (!cleanDirectory) continue
    for (const extension of extensions) {
      const candidate = join(cleanDirectory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
      if (process.platform === 'win32' && existsSync(join(cleanDirectory, command))) {
        return join(cleanDirectory, command)
      }
    }
  }
  return null
}

function requireNpm() {
  const npm = which('npm')
  if (!npm) fail('npm is required for this command. Install Node.js/npm first.')
  return npm
}

function requireUv() {
  const uvBin = process.env.UV || 'uv'
  const uv = which(uvBin)
  if (!uv) {
    fail('uv is required. Install it from https://docs.astral.sh/uv/getting-started/installation/')
  }
  process.env.UV = uvBin
  if (process.env.VIRTUAL_ENV) {
    process.env.UV_PROJECT_ENVIRONMENT = process.env.VIRTUAL_ENV
  } else if (!process.env.UV_PROJECT_ENVIRONMENT) {
    process.env.UV_PROJECT_ENVIRONMENT = join(ROOT_DIR, 'apps', 'python', '.venv')
  } else if (!isAbsolute(process.env.UV_PROJECT_ENVIRONMENT)) {
    process.env.UV_PROJECT_ENVIRONMENT = resolve(
      ROOT_DIR,
      'apps',
      'python',
      process.env.UV_PROJECT_ENVIRONMENT
    )
  }
  return uvBin
}

function venvPython() {
  const environment = process.env.UV_PROJECT_ENVIRONMENT ||
    join(ROOT_DIR, 'apps', 'python', '.venv')
  return process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
}

function spawnProcess(command, args, { env = process.env, cwd = ROOT_DIR } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    child.on('error', (cause) => {
      error(`Could not start ${command}: ${cause.message}`)
      resolvePromise(1)
    })
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

function runWithEnv(args) {
  return spawnProcess(process.execPath, [join(ROOT_DIR, 'scripts', 'with-env.mjs'), ...args])
}

function runNodeScript(script, args = []) {
  return spawnProcess(process.execPath, [join(ROOT_DIR, 'scripts', script), ...args])
}

function capture(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', () => resolvePromise({ status: 1, output }))
    child.on('close', (status) => resolvePromise({ status: status ?? 1, output }))
  })
}

function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port) })
    const finish = (inUse) => {
      socket.destroy()
      resolvePromise(inUse)
    }
    socket.setTimeout(400)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function checkPorts() {
  for (const port of [WEB_PORT, API_PORT, PYTHON_PORT]) {
    if (await portInUse(port)) {
      fail(`Port ${port} is already in use. Stop the existing process or run ./workspace stop.`)
    }
  }
}

async function findPidsOnPort(port) {
  if (process.platform === 'win32') {
    const { output } = await capture('netstat', ['-ano', '-p', 'tcp'])
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue
      const columns = line.trim().split(/\s+/)
      const local = columns[1] || ''
      if (local.endsWith(`:${port}`)) {
        const pid = columns[columns.length - 1]
        if (/^\d+$/.test(pid)) pids.add(Number(pid))
      }
    }
    return [...pids]
  }

  if (which('lsof')) {
    const { output } = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    const pids = output
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
    if (pids.length > 0) return [...new Set(pids)]
  }

  if (which('fuser')) {
    const { output } = await capture('fuser', [`${port}/tcp`])
    const pids = output
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
    return [...new Set(pids)]
  }

  return []
}

async function stopPorts() {
  const ports = [WEB_PORT, API_PORT, PYTHON_PORT]
  let stopped = 0
  const available = process.platform === 'win32' || which('lsof') || which('fuser')
  if (!available) {
    fail('Neither lsof nor fuser is available; cannot stop processes automatically.')
  }
  for (const port of ports) {
    const pids = await findPidsOnPort(port)
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          const { status } = await capture('taskkill', ['/PID', String(pid), '/F', '/T'])
          if (status === 0) stopped += 1
        } else {
          process.kill(pid, 'SIGTERM')
          stopped += 1
        }
      } catch {
        // The process may have already exited; keep checking the other ports.
      }
    }
  }
  if (stopped > 0) {
    success(`Stopped processes on ports ${ports.join(', ')}.`)
  } else {
    info(`No processes were stopped on ports ${ports.join(', ')}.`)
  }
}

function cleanArtifacts() {
  rmSync(join(ROOT_DIR, 'apps', 'web', 'dist'), { recursive: true, force: true })
  const stack = [ROOT_DIR]
  while (stack.length > 0) {
    const directory = stack.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.venv') continue
      const target = join(directory, entry.name)
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache') {
        rmSync(target, { recursive: true, force: true })
      } else {
        stack.push(target)
      }
    }
  }
  success('Removed frontend build output and Python caches.')
}

async function commandVersion(command, args = ['--version']) {
  if (!which(command)) return 'missing'
  const { status, output } = await capture(command, args)
  if (status !== 0 && !output.trim()) return 'missing'
  return output.trim().split(/\r?\n/)[0] || 'missing'
}

async function printStatus() {
  info('Tool versions:')
  const pythonCommand = which('python3') ? 'python3' : 'python'
  log(`  node:   ${process.version}`)
  log(`  npm:    ${await commandVersion('npm')}`)
  log(`  uv:     ${await commandVersion(process.env.UV || 'uv')}`)
  log(`  python: ${await commandVersion(pythonCommand)}`)
  info('Service ports:')
  for (const port of [WEB_PORT, API_PORT, PYTHON_PORT]) {
    log(`  ${port}: ${(await portInUse(port)) ? 'in use' : 'free'}`)
  }
}

function row(label, description) {
  return `  ${label.padEnd(32)} ${description}`
}

function printHelp() {
  log(`${C.bold}${C.blue}Workspace commands${C.reset}\n`)
  log('Usage: ./workspace <command> [arguments]')
  log('       .\\workspace.cmd <command> [arguments]   (Windows PowerShell/CMD)\n')
  log(`${C.bold}Core${C.reset}`)
  log(row('dev', 'Start frontend, Node API, and Python satellite'))
  log(row('web', 'Start only the Vite frontend'))
  log(row('node, api', 'Start only the Node API'))
  log(row('python', 'Start only the Python satellite'))
  log(row('stop', 'Stop processes on the dev service ports'))
  log(row('restart', 'Stop, then start all services'))
  log(row('status', 'Show tool versions and service port state'))
  log(`\n${C.bold}User files${C.reset}`)
  log(row('repos list', 'List registered repository roots'))
  log(row('repos add <path>', 'Register a repository root for tracking'))
  log(row('files scan', 'Scan user files of every repository and sync headers'))
  log(row('files list', 'List centrally tracked user files'))
  log(row('files check', 'Verify every user file is tracked'))
  log(row('folders scan', 'Scan and register folders in SQLite'))
  log(row('folders list', 'List centrally tracked folders'))
  log(row('folders check', 'Verify every folder is tracked'))
  log(row('git-context scan', 'Scan and track Git worktrees'))
  log(row('git-context list', 'List tracked Git worktrees'))
  log(row('git-context check', 'Verify Git worktrees are tracked'))
  log(row('tools scan', 'Scan and track workflow tools'))
  log(row('tools list', 'List tracked workflow tools'))
  log(row('tools check', 'Verify tracked tools are available'))
  log(row('environment scan', 'Scan and track runtime environment'))
  log(row('environment list', 'List tracked environment facts'))
  log(row('environment check', 'Verify environment facts are populated'))
  log(row('mcp scan', 'Scan and track MCP servers and resources'))
  log(row('mcp list', 'List tracked MCP servers and resources'))
  log(row('mcp check', 'Verify discovered MCP entries are tracked'))
  log(row('tracks', 'List available tracking domains'))
  log(`\n${C.bold}Sensors${C.reset}`)
  log(row('sensors scan', 'Detect workspace gaps without spending quota'))
  log(row('sensors cycle', 'Run an atomic improvement cycle'))
  log(row('sensors suggestions', 'List evidence-backed sensor suggestions'))
  log(row('sensors list', 'List actionable sensor findings'))
  log(row('sensors show <id>', 'Show one finding with its event trail'))
  log(row('sensors runs', 'List recent sensor scan runs'))
  log(row('sensors catalog', 'List registered sensor detectors and ideas'))
  log(row('sensors ack|dismiss|resolve|reopen <id>', 'Change a finding lifecycle state'))
  log(row('sensors promote <id>', 'Create a task from an open finding'))
  log(row('--new-env "KEY=value"', 'Add or update one .env value'))
  log(row('env set KEY=value ...', 'Add or update .env values'))
  log(row('env get KEY', 'Read one .env value'))
  log(row('env list', 'Show .env contents'))
  log(row('env encrypt [src] [dst]', 'Encrypt .env into .env.enc'))
  log(row('maintain', 'Run tracking scans and self-check'))
  log(row('backup', 'Back up the SQLite database'))
  log(row('env-encrypt [src] [dst]', 'Encrypt a .env file into .env.enc'))
  log(row('status', 'Show tools, ports, and tracking counts'))
  log(`\n${C.bold}Tasks${C.reset}`)
  log(row('task worktree <id>', 'Show the worktree linked to a task'))
  log(row('task worktree create <id>', 'Create and link an isolated task worktree'))
  log(row('task worktree remove <id>', 'Remove the linked worktree and unlink the task'))
  log(`\n${C.bold}AI and remote${C.reset}`)
  log(row('local-ai [all|0.5b|1.5b]', 'Start local models within memory limits'))
  log(row('colab [status|stop] [session]', 'Inspect or stop the reusable Colab session'))
  log(row('ai doctor [...]', 'Check local and remote model configuration'))
  log(row('ai improve [SUBCMD] ...', 'Run the AI improvement flow on draft proposals'))
  log(row('ai ask [--model ID] ...', 'Ask the running API a direct AI question'))
  log(row('ai model [rotate|study]', 'Rotate or study OpenCode models daily'))
  log(row('doctor', 'Alias for ai doctor'))
  log(`\n${C.bold}Dependencies${C.reset}`)
  log(row('install', 'Install npm dependencies and sync the Python project'))
  log(row('python-add <pkg...>', 'Add managed Python dependencies with uv'))
  log(row('python-pip <cmd...>', 'Run uv pip against the workspace Python environment'))
  log(`\n${C.bold}Build, test, and quality${C.reset}`)
  log(row('build', 'Build the frontend'))
  log(row('build:web', 'Alias for build'))
  log(row('lint', 'Lint the frontend'))
  log(row('lint:web', 'Alias for lint'))
  log(row('test', 'Run frontend, Node, and Python tests'))
  log(row('test:web', 'Run frontend tests only'))
  log(row('test:api, test:node', 'Run Node API tests only'))
  log(row('test:python', 'Run Python tests only'))
  log(row('check', 'Run lint and tests'))
  log(row('clean', 'Remove frontend build output and Python caches'))
  log(`\n${C.bold}Examples${C.reset}`)
  log('  ./workspace dev')
  log('  ./workspace test:api')
  log('  ./workspace local-ai 0.5b')
  log('  ./workspace ai doctor --strict')
}

function installGitHook() {
  const sourceHook = join(ROOT_DIR, 'scripts', 'hooks', 'post-commit')
  return capture('git', ['rev-parse', '--git-path', 'hooks/post-commit']).then(({ status, output }) => {
    if (status !== 0) {
      warn('Could not locate the Git hooks directory; skipping the post-commit tracking hook.')
      return
    }
    const reported = output.trim()
    const target = isAbsolute(reported) ? reported : resolve(ROOT_DIR, reported)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8')
      // Recognize both the current hook and the older `"$ROOT/workspace"
      // files scan` version so an upgrade replaces its own hook but never
      // clobbers a user-authored one.
      const ours =
        existing.includes('workspace-cli.mjs') ||
        existing.includes('workspace files scan') ||
        existing.includes('$ROOT/workspace')
      if (!ours) {
        warn(
          'An existing post-commit hook was left untouched; see scripts/hooks/post-commit ' +
          'to integrate tracking sync manually.'
        )
        return
      }
    }
    copyFileSync(sourceHook, target)
    try {
      chmodSync(target, 0o755)
    } catch {
      // Windows does not use POSIX execute bits.
    }
    info('Installed the post-commit tracking sync hook.')
  })
}

async function requestApi(method, path, body, timeoutMs = 120000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: response.status, ok: response.ok, data }
  } finally {
    clearTimeout(timer)
  }
}

async function requireApi() {
  if (!(await portInUse(API_PORT))) {
    fail(
      `The Node API is not running on port ${API_PORT}. ` +
      'Start it with ./workspace dev or ./workspace node.'
    )
  }
}

function apiErrorMessage(data, fallback) {
  if (data && typeof data === 'object' && typeof data.error === 'string') return data.error
  return fallback
}

function parsePositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(value ?? '') ? Number(value) : null
}

function parseArgs(args, spec) {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const option = spec[argument]
    if (option) {
      if (index + 1 >= args.length) fail(`Option ${argument} requires a value.`, 2)
      options[option] = args[index + 1]
      index += 1
    } else if (argument.startsWith('--')) {
      fail(`Unknown option: ${argument}`, 2)
    } else {
      positionals.push(argument)
    }
  }
  return { options, positionals }
}

async function taskWorktree(args) {
  const action = args[0] ?? 'show'
  if (action === 'show') {
    const ids = args.filter((value) => parsePositiveInteger(value))
    const first = parsePositiveInteger(args[0]) ? args[0] : ids[0]
    if (!first) fail('Usage: ./workspace task worktree <id>', 2)
    await requireApi()
    const response = await requestApi('GET', `/api/tasks/${first}`)
    if (!response.ok) fail(`Could not read task #${first} (HTTP ${response.status}).`)
    const path = response.data?.worktree_path || ''
    log(path || 'No worktree linked.')
    return 0
  }

  if (action === 'create') {
    const { options, positionals } = parseArgs(args.slice(1), {
      '--branch': 'branch',
      '--name': 'name'
    })
    const id = positionals.map((value) => parsePositiveInteger(value)).find(Boolean)
    if (!id) fail('Usage: ./workspace task worktree create <id> [--branch NAME] [--name NAME]', 2)
    await requireApi()
    const payload = {}
    if (options.branch) payload.branch = options.branch
    if (options.name) payload.name = options.name
    const response = await requestApi('POST', `/api/tasks/${id}/worktree`, payload)
    if (!response.ok) fail(apiErrorMessage(response.data, `The worktree request failed (HTTP ${response.status}).`))
    log(`Linked ${response.data.worktreePath} (branch ${response.data.branch}).`)
    return 0
  }

  if (action === 'remove') {
    const positionals = []
    let force = false
    for (const argument of args.slice(1)) {
      if (argument === '--force') {
        force = true
      } else if (parsePositiveInteger(argument)) {
        positionals.push(argument)
      } else {
        fail(`Unknown task worktree option: ${argument}`, 2)
      }
    }
    const id = parsePositiveInteger(positionals[0])
    if (!id) fail('Usage: ./workspace task worktree remove <id> [--force]', 2)
    await requireApi()
    const response = await requestApi('DELETE', `/api/tasks/${id}/worktree${force ? '?force=1' : ''}`)
    if (!response.ok) fail(apiErrorMessage(response.data, `The worktree request failed (HTTP ${response.status}).`))
    log(`Removed ${response.data.removedPath}.`)
    return 0
  }

  fail(
    `Unknown task worktree action: ${action}\n` +
    'Usage: ./workspace task worktree <id>\n' +
    '       ./workspace task worktree create <id> [--branch NAME] [--name NAME]\n' +
    '       ./workspace task worktree remove <id> [--force]',
    2
  )
}

async function aiImprove(args) {
  const subcommand = args[0] ?? 'run'

  if (subcommand === 'run') {
    await requireApi()
    const response = await requestApi('POST', '/api/ai/improve', {})
    if (!response.ok) {
      fail(apiErrorMessage(response.data, `The improvement run failed (HTTP ${response.status}).`))
    }
    const proposals = response.data?.proposals || []
    for (const proposal of proposals) {
      log(`#${proposal.id} [${proposal.status ?? 'proposed'}] ${proposal.title}`)
      if (proposal.description) log(`    ${proposal.description}`)
    }
    log(
      `${proposals.length} proposal(s) created, ${response.data?.skipped || 0} skipped ` +
      `(job ${response.data?.jobId ?? ''}).`
    )
    log('Review with ./workspace ai improve list, then ./workspace ai improve approve|reject <id>.')
    return 0
  }

  if (subcommand === 'list') {
    const { options } = parseArgs(args.slice(1), { '--status': 'status' })
    await requireApi()
    const query = options.status ? `?status=${encodeURIComponent(options.status)}` : ''
    const response = await requestApi('GET', `/api/proposals${query}`)
    if (!response.ok) fail(`Could not list task proposals (HTTP ${response.status}).`)
    const proposals = Array.isArray(response.data) ? response.data : []
    if (proposals.length === 0) {
      log('No task proposals.')
      return 0
    }
    for (const proposal of proposals) {
      const created = proposal.createdTaskId ? ` -> task #${proposal.createdTaskId}` : ''
      log(`#${proposal.id} | ${proposal.status} | ${proposal.title} | ${proposal.priority}${created}`)
    }
    return 0
  }

  if (['approve', 'reject', 'rollback'].includes(subcommand)) {
    const id = parsePositiveInteger(args[1])
    if (!id) fail(`Usage: ./workspace ai improve ${subcommand} <id>`, 2)
    await requireApi()
    const response = await requestApi('POST', `/api/proposals/${id}/${subcommand}`)
    if (!response.ok) {
      fail(apiErrorMessage(response.data, `The proposal decision failed (HTTP ${response.status}).`))
    }
    const proposal = response.data?.proposal || {}
    const task = response.data?.task || {}
    if (subcommand === 'approve') {
      log(`Approved proposal #${proposal.id}: created task #${task.id} (${task.title ?? ''}).`)
    } else if (subcommand === 'rollback') {
      log(`Rolled back proposal #${proposal.id}: the task it created was deleted.`)
    } else {
      log(`Rejected proposal #${proposal.id}: ${proposal.title ?? ''}.`)
    }
    return 0
  }

  fail(
    `Unknown ai improve subcommand: ${subcommand}\n` +
    'Usage: ./workspace ai improve [run|list|approve <id>|reject <id>|rollback <id>]',
    2
  )
}

async function aiAsk(args) {
  const { options, positionals } = parseArgs(args, {
    '--model': 'model',
    '--session': 'session'
  })
  const prompt = positionals[0]
  if (!prompt) fail('Usage: ./workspace ai ask [--model ID] [--session ID] "prompt"', 2)
  if (options.session && !parsePositiveInteger(options.session)) {
    fail('Session ID must be a positive integer.', 2)
  }
  await requireApi()
  const payload = { prompt }
  if (options.model) payload.model = options.model
  if (options.session) payload.session_id = Number(options.session)
  let response
  try {
    response = await requestApi('POST', '/api/ai/complete', payload)
  } catch (cause) {
    fail(`The AI request failed: ${cause.message}. Check ./workspace ai doctor or the API logs.`)
  }
  if (!response.ok) {
    const message = apiErrorMessage(response.data, `The AI request failed (HTTP ${response.status}).`)
    const retryAfter = response.data?.retryAfter
    fail(retryAfter ? `${message}\nRetry after about ${retryAfter} seconds.` : message)
  }
  if (response.data && typeof response.data === 'object' && 'content' in response.data) {
    log(response.data.content)
  } else {
    log(JSON.stringify(response.data, null, 2))
  }
  return 0
}

async function aiModel(args) {
  const subcommand = args[0] ?? 'status'
  if (subcommand === 'rotate') {
    return runNodeScript('rotate-model.mjs')
  }
  if (subcommand === 'list') {
    return runNodeScript('opencode-console.mjs', ['list'])
  }
  if (subcommand === 'status') {
    let current = '<not set>'
    if (existsSync(ENV_FILE)) {
      const line = readFileSync(ENV_FILE, 'utf8')
        .split(/\r?\n/)
        .find((entry) => entry.startsWith('OPENCODE_AI_MODEL='))
      if (line) current = line.slice('OPENCODE_AI_MODEL='.length)
    }
    info(`Current OPENCODE_AI_MODEL: ${current}`)
    info('Available providers/models via OpenCode console:')
    return runNodeScript('opencode-console.mjs', ['list'])
  }
  if (subcommand === 'study') {
    return runNodeScript('model-study.mjs', args.slice(1))
  }
  fail(
    `Unknown ai model subcommand: ${subcommand}\n` +
    'Usage: ./workspace ai model [rotate|status|list|study] [--dry-run] [--all]',
    2
  )
}

function isSecretKey(key) {
  return /(KEY|TOKEN|SECRET|PASSWORD)/.test(key)
}

function envSet(assignments) {
  if (assignments.length === 0) fail('Usage: ./workspace env set KEY=value [KEY=value ...]', 2)
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=')
    if (separator <= 0) fail(`Invalid assignment: ${assignment}`, 2)
    const key = assignment.slice(0, separator)
    const value = assignment.slice(separator + 1)
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`))
    if (index >= 0) {
      lines[index] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
    success(`Set ${key} in .env`)
  }
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`)
  return 0
}

function envGet(key) {
  if (!key) fail('Usage: ./workspace env get KEY', 2)
  if (!existsSync(ENV_FILE)) fail('.env does not exist.')
  const matches = readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith(`${key}=`))
  if (matches.length === 0) return 0
  if (isSecretKey(key)) {
    log(`${key}=***`)
  } else {
    log(matches[matches.length - 1])
  }
  return 0
}

function envList() {
  if (!existsSync(ENV_FILE)) {
    info('.env does not exist.')
    return 0
  }
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match && isSecretKey(match[1])) {
      log(`${match[1]}=***`)
    } else {
      log(line)
    }
  }
  return 0
}

async function envEncrypt(args) {
  const uvBin = requireUv()
  const source = args[0] ?? '.env'
  const destination = args[1] ?? '.env.enc'
  return spawnProcess(
    uvBin,
    ['run', '--project', 'apps/python', 'python', join(ROOT_DIR, 'scripts', 'encrypt_env.py'), source, destination],
    { env: { ...process.env, WORKSPACE_ENV_KEY: process.env.WORKSPACE_ENV_KEY || '' } }
  )
}

async function backupDatabase() {
  const directory = join(ROOT_DIR, 'apps', 'api', 'data', 'backups')
  mkdirSync(directory, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const target = join(directory, `workspace-${timestamp}.sqlite`)
  const source = resolveDatabasePath()
  if (!existsSync(source)) fail(`Database not found: ${source}`)
  copyFileSync(source, target)
  success(`Backed up database to ${target}`)
  return 0
}

const TRACKING_SCRIPTS = {
  repos: { script: 'repos.mjs', subcommands: ['list', 'add'], fallback: 'list' },
  files: { script: 'scan-user-files.mjs', subcommands: ['scan', 'list', 'check'], fallback: 'scan' },
  folders: { script: 'scan-folders.mjs', subcommands: ['scan', 'list', 'check'], fallback: 'scan' },
  'git-context': { script: 'scan-git-context.mjs', subcommands: ['scan', 'list', 'check'], fallback: 'scan' },
  mcp: { script: 'scan-mcp.mjs', subcommands: ['scan', 'list', 'check'], fallback: 'scan' }
}

async function runTrackingCommand(name, args) {
  const definition = TRACKING_SCRIPTS[name]
  const subcommand = args[0] ?? definition.fallback
  if (!definition.subcommands.includes(subcommand)) {
    fail(
      `Unknown ${name} subcommand: ${subcommand}\n` +
      `Usage: ./workspace ${name} [${definition.subcommands.join('|')}]`,
      2
    )
  }
  requireNpm()
  return runNodeScript(definition.script, [subcommand, ...args.slice(1)])
}

async function runPythonTracking(name, args) {
  const uvBin = requireUv()
  const definition = {
    environment: { script: 'scan_environments.py', subcommands: ['scan', 'list', 'check'] },
    tools: { script: 'scan_tools.py', subcommands: ['scan', 'list', 'check'] }
  }[name]
  const subcommand = args[0] ?? 'scan'
  if (!definition.subcommands.includes(subcommand)) {
    fail(
      `Unknown ${name} subcommand: ${subcommand}\n` +
      `Usage: ./workspace ${name} [${definition.subcommands.join('|')}]`,
      2
    )
  }
  return spawnProcess(uvBin, [
    'run', '--project', 'apps/python', 'python',
    join(ROOT_DIR, 'scripts', definition.script),
    subcommand, '--database', resolveDatabasePath()
  ])
}

const SENSOR_SUBCOMMANDS = new Set([
  'scan', 'cycle', 'suggestions', 'list', 'runs', 'catalog',
  'show', 'ack', 'dismiss', 'resolve', 'reopen', 'promote'
])

async function dispatch(argv) {
  let args = argv.slice()
  if (args[0] === '--new-env') {
    if (args.length < 2 || !args[1].includes('=')) {
      fail('Usage: ./workspace --new-env "KEY=value"', 2)
    }
    args = ['env', 'set', args[1]]
  }
  const command = args[0] ?? 'help'
  const rest = args.slice(1)

  switch (command) {
    case 'dev':
      requireNpm()
      requireUv()
      await checkPorts()
      return runWithEnv(['npm', 'run', 'dev'])
    case 'web':
      requireNpm()
      return runWithEnv(['npm', 'run', 'dev:web'])
    case 'node':
    case 'api':
      requireNpm()
      return runWithEnv(['npm', 'run', 'dev:api'])
    case 'python': {
      requireUv()
      return runWithEnv([
        process.env.UV,
        'run', '--project', 'apps/python', 'python', 'apps/python/src/server.py'
      ])
    }
    case 'local-ai':
      return runNodeScript('local-models.mjs', [rest[0] ?? 'all'])
    case 'colab':
      return runNodeScript('colab-session.mjs', [rest[0] ?? 'status', rest[1] ?? ''])
    case 'doctor':
      return runNodeScript('ai-doctor.mjs', rest)
    case 'install': {
      const npm = requireNpm()
      const uvBin = requireUv()
      const npmCode = await spawnProcess(npm, ['install'])
      if (npmCode !== 0) return npmCode
      const pythonVersion = readFileSync(join(ROOT_DIR, 'apps', 'python', '.python-version'), 'utf8').trim()
      const pythonCode = await spawnProcess(uvBin, ['python', 'install', pythonVersion])
      if (pythonCode !== 0) return pythonCode
      await installGitHook()
      return spawnProcess(uvBin, ['sync', '--project', 'apps/python'])
    }
    case 'python-add': {
      const uvBin = requireUv()
      if (rest.length === 0) fail('Usage: ./workspace python-add <package> [package ...]', 2)
      return spawnProcess(uvBin, ['add', '--project', 'apps/python', ...rest])
    }
    case 'python-pip': {
      const uvBin = requireUv()
      if (rest.length === 0) {
        fail(
          'Usage: ./workspace python-pip <uv-pip-command> [arguments ...]\n' +
          'Example: ./workspace python-pip install <package>',
          2
        )
      }
      const syncCode = await spawnProcess(uvBin, ['sync', '--project', 'apps/python'])
      if (syncCode !== 0) return syncCode
      return spawnProcess(uvBin, ['pip', ...rest, '--python', venvPython()])
    }
    case 'build':
    case 'build:web':
      requireNpm()
      return runWithEnv(['npm', 'run', 'build'])
    case 'lint':
    case 'lint:web':
      requireNpm()
      return runWithEnv(['npm', 'run', 'lint'])
    case 'test':
      requireNpm()
      requireUv()
      return runWithEnv(['npm', 'test'])
    case 'test:web':
      requireNpm()
      return runWithEnv(['npm', 'run', 'test', '--workspace', 'apps/web'])
    case 'test:api':
    case 'test:node':
      requireNpm()
      return runWithEnv(['npm', 'run', 'test', '--workspace', 'apps/api'])
    case 'test:python': {
      requireUv()
      process.env.PYTHONPATH = join(ROOT_DIR, 'apps', 'python', 'src')
      return runWithEnv([
        process.env.UV,
        'run', '--project', 'apps/python', 'python', '-m', 'unittest',
        'discover', '-s', 'apps/python/tests'
      ])
    }
    case 'check': {
      requireNpm()
      requireUv()
      const lintCode = await runWithEnv(['npm', 'run', 'lint'])
      if (lintCode !== 0) return lintCode
      return dispatch(['test'])
    }
    case 'clean':
      cleanArtifacts()
      return 0
    case 'status': {
      await printStatus()
      info('Tracking counts:')
      const uvBin = requireUv()
      return spawnProcess(uvBin, [
        'run', '--project', 'apps/python', 'python',
        join(ROOT_DIR, 'scripts', 'tracking_status.py')
      ])
    }
    case 'stop':
      await stopPorts()
      return 0
    case 'restart': {
      await stopPorts()
      requireNpm()
      requireUv()
      await checkPorts()
      return runWithEnv(['npm', 'run', 'dev'])
    }
    case 'git-context':
    case 'files':
    case 'folders':
    case 'repos':
    case 'mcp':
      return runTrackingCommand(command, rest)
    case 'environment':
    case 'tools':
      return runPythonTracking(command, rest)
    case 'tracks':
      info('Tracking domains:')
      log('  tasks, repositories, user_files, folders, git_worktrees, tools, environments, mcp_servers, mcp_resources')
      info('Use ./workspace <domain> scan|list|check for each domain.')
      return 0
    case 'sensors': {
      const subcommand = rest[0] ?? 'scan'
      if (!SENSOR_SUBCOMMANDS.has(subcommand)) {
        fail(
          `Unknown sensors subcommand: ${subcommand}\n` +
          'Usage: ./workspace sensors [scan|cycle|suggestions|list|show <id>|runs|catalog|ack|dismiss|resolve|reopen|promote] [options]',
          2
        )
      }
      requireNpm()
      return runNodeScript('sensors.mjs', [subcommand, ...rest.slice(1)])
    }
    case 'self-check': {
      info('Running deterministic workspace self-check...')
      requireNpm()
      requireUv()
      let statusCode = 0
      // The database is gitignored, so a fresh clone has no tracking rows.
      // Scan first so the checks below verify a healthy baseline instead of
      // failing every file as untracked.
      const steps = [
        ['lint'],
        ['test'],
        ['build'],
        ['files', 'scan'],
        ['folders', 'scan'],
        ['git-context', 'scan'],
        ['tools', 'scan'],
        ['environment', 'scan'],
        ['files', 'check'],
        ['folders', 'check'],
        ['git-context', 'check'],
        ['tools', 'check'],
        ['environment', 'check'],
        ['ai-doctor.mjs', '--strict']
      ]
      for (const step of steps) {
        try {
          if (step[0] === 'ai-doctor.mjs') {
            const code = await runNodeScript('ai-doctor.mjs', step.slice(1))
            if (code !== 0) statusCode = 1
          } else {
            const code = await dispatch(step)
            if (code !== 0) statusCode = 1
          }
        } catch (cause) {
          reportFailure(cause)
          statusCode = 1
        }
      }
      if (statusCode === 0) {
        success('Self-check passed.')
      } else {
        error('Self-check found failures.')
      }
      return statusCode
    }
    case 'ai': {
      const subcommand = rest[0] ?? 'doctor'
      if (subcommand === 'doctor') return runNodeScript('ai-doctor.mjs', rest.slice(1))
      if (subcommand === 'improve') return aiImprove(rest.slice(1))
      if (subcommand === 'ask') return aiAsk(rest.slice(1))
      if (subcommand === 'model') return aiModel(rest.slice(1))
      fail(
        `Unknown ai subcommand: ${subcommand}\n` +
        'Usage: ./workspace ai doctor [--json] [--strict] [--offline]\n' +
        '       ./workspace ai improve [run|list|approve <id>|reject <id>|rollback <id>]\n' +
        '       ./workspace ai ask [--model ID] [--session ID] "prompt"\n' +
        '       ./workspace ai model [rotate|status|list|study]',
        2
      )
      break
    }
    case 'task': {
      const subcommand = rest[0] ?? ''
      if (subcommand !== 'worktree') {
        fail(
          `Unknown task subcommand: ${subcommand}\n` +
          'Usage: ./workspace task worktree <id>\n' +
          '       ./workspace task worktree create <id> [--branch NAME] [--name NAME]\n' +
          '       ./workspace task worktree remove <id> [--force]',
          2
        )
      }
      return taskWorktree(rest.slice(1))
    }
    case 'maintain':
      info('Running maintenance cycle...')
      requireUv()
      await dispatch(['files', 'scan'])
      await dispatch(['folders', 'scan'])
      await dispatch(['git-context', 'scan'])
      await dispatch(['tools', 'scan'])
      await dispatch(['environment', 'scan'])
      return dispatch(['self-check'])
    case 'env-encrypt':
      return envEncrypt(rest)
    case 'backup':
      return backupDatabase()
    case 'env': {
      const subcommand = rest[0] ?? 'list'
      if (subcommand === 'set') return envSet(rest.slice(1))
      if (subcommand === 'get') return envGet(rest[1])
      if (subcommand === 'list') return envList()
      if (subcommand === 'encrypt') return envEncrypt(rest.slice(1))
      fail(
        `Unknown env subcommand: ${subcommand}\nUsage: ./workspace env [set|get|list|encrypt]`,
        2
      )
      break
    }
    case 'help':
    case '-h':
    case '--help':
      printHelp()
      return 0
    default:
      fail(`Unknown command: ${command}\nRun ./workspace help for available commands.`, 2)
  }
  return 0
}

try {
  process.exitCode = await dispatch(process.argv.slice(2))
} catch (cause) {
  process.exitCode = reportFailure(cause)
}

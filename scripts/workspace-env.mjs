// Objective: Manage declarative workspace profiles, agy plugin state, scoped env checks, Python venv binding, and local inference status.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
const EXAMPLE_PROFILES_PATH = path.join(ROOT_DIR, 'config', 'workspace-profiles.example.json')
const LOCAL_PROFILES_PATH = path.join(ROOT_DIR, 'config', 'workspace-profiles.local.json')
const STATE_PATH = path.join(ROOT_DIR, '.workspace-env.json')

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export function loadProfiles() {
  const base = readJsonSafe(EXAMPLE_PROFILES_PATH, { defaultProfile: 'default', profiles: {} })
  const local = readJsonSafe(LOCAL_PROFILES_PATH, { profiles: {} })
  return {
    defaultProfile: local.defaultProfile || base.defaultProfile || 'default',
    profiles: {
      ...(base.profiles || {}),
      ...(local.profiles || {}),
    },
  }
}

export function getActiveProfileName() {
  const state = readJsonSafe(STATE_PATH, null)
  const { defaultProfile, profiles } = loadProfiles()
  if (state?.activeProfile && profiles[state.activeProfile]) {
    return state.activeProfile
  }
  return defaultProfile
}

function runCommandSafe(cmd, args, timeoutMs = 4000) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
    return { ok: true, stdout: stdout.trim() }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : error.message,
    }
  }
}

function parseDotEnvKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set()
  const keys = new Set()
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (key && val) keys.add(key)
    }
  }
  return keys
}

export function getAgyPluginState() {
  const cliResult = runCommandSafe('agy', ['plugin', 'list', '--json'])
  if (cliResult.ok && cliResult.stdout) {
    try {
      const parsed = JSON.parse(cliResult.stdout)
      const list = Array.isArray(parsed) ? parsed : parsed.plugins || []
      return {
        source: 'agy-cli',
        plugins: list.map((p) => ({
          name: p.name || p.id,
          enabled: p.enabled !== false && p.disabled !== true,
          version: p.version || null,
        })),
      }
    } catch {
      // Fall through to directory inspection.
    }
  }

  const pluginsDir = path.join(os.homedir(), '.gemini', 'config', 'plugins')
  if (!fs.existsSync(pluginsDir)) {
    return { source: 'unavailable', plugins: [] }
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
  const plugins = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, enabled: true, version: null }))
  return { source: 'filesystem-fallback', plugins }
}

export function isPythonVersionCompatible(versionText) {
  const match = String(versionText || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 3 || (major === 3 && minor >= 12)
}

export function getPythonVenvState(_profile, { rootDir = ROOT_DIR, probePython } = {}) {
  const venvAbs = path.join(rootDir, 'apps', 'python', '.venv')
  const pyBin = process.platform === 'win32'
    ? path.join(venvAbs, 'Scripts', 'python.exe')
    : path.join(venvAbs, 'bin', 'python')

  if (!fs.existsSync(pyBin)) {
    return { exists: false, path: pyBin, version: null, compatible: false, matchesPreferredPin: false, preferredPin: null }
  }

  const probe = probePython
    ? probePython(pyBin)
    : runCommandSafe(pyBin, ['--version'])
  const versionText = probe?.ok ? probe.stdout : null
  const compatible = isPythonVersionCompatible(versionText)
  let preferredPin = null
  try {
    preferredPin = fs.readFileSync(path.join(rootDir, 'apps', 'python', '.python-version'), 'utf8').trim() || null
  } catch {
    // The compatibility floor remains authoritative when no preference pin is present.
  }
  return {
    exists: true,
    path: pyBin,
    version: versionText,
    compatible,
    matchesPreferredPin: Boolean(versionText && preferredPin && versionText.includes(preferredPin)),
    preferredPin,
  }
}

export function evaluateReadiness({ nodeVersion = process.versions.node, requiredEnv = [], python, agy, operation = 'core' } = {}) {
  const nodeMatch = String(nodeVersion).match(/^(\d+)\./)
  const nodeOk = Boolean(nodeMatch && Number(nodeMatch[1]) >= 22)
  const missingRequired = requiredEnv.filter((item) => !item.present)
  const pythonOk = Boolean(python?.exists && python?.compatible)
  const pluginToolingOk = Boolean(agy && agy.source !== 'unavailable')
  const diagnostics = [
    ...(!nodeOk ? [{ code: 'NODE_VERSION_UNSUPPORTED', lane: 'execution', severity: 'error', message: 'Node.js >=22 is required.' }] : []),
    ...missingRequired.map((item) => ({ code: 'REQUIRED_ENV_MISSING', lane: 'execution', severity: 'error', key: item.key, message: `Missing required env var: ${item.key}` })),
    ...(!pythonOk ? [{
      code: !python?.exists ? 'PYTHON_TOOLING_VENV_MISSING' : 'PYTHON_TOOLING_VERSION_UNSUPPORTED',
      lane: operation === 'python' ? 'execution' : 'tooling',
      severity: operation === 'python' ? 'error' : 'warning',
      message: !python?.exists ? 'Python satellite venv is missing.' : 'Python >=3.12 is required for Python satellite operations.',
    }] : []),
    ...(!pluginToolingOk ? [{ code: 'AGY_PLUGIN_TOOLING_UNAVAILABLE', lane: 'tooling', severity: 'warning', message: 'Optional AGY plugin discovery is unavailable.' }] : []),
    ...(pythonOk && python.matchesPreferredPin === false && python.preferredPin
      ? [{ code: 'PYTHON_PREFERRED_PIN_MISMATCH', lane: 'tooling', severity: 'info', message: `Preferred Python pin: ${python.preferredPin}` }]
      : []),
  ]
  const executionReady = nodeOk && missingRequired.length === 0 && (operation !== 'python' || pythonOk)
  const toolingReady = pythonOk && pluginToolingOk
  const issues = diagnostics
    .filter((item) => item.severity === 'error' || item.severity === 'warning')
    .map((item) => item.message)
  return { executionReady, toolingReady, ok: executionReady && toolingReady, diagnostics, issues }
}

function getLocalInferenceState() {
  const pgrep = runCommandSafe('pgrep', ['-af', 'llama-server'])
  const running = pgrep.ok && pgrep.stdout.length > 0
  return {
    resourceGated: true,
    running,
    status: running ? 'running' : 'idle (resource-gated, on-demand)',
  }
}

export function getEnvSnapshot(profileName = getActiveProfileName(), { operation = 'core' } = {}) {
  const { profiles } = loadProfiles()
  const profile = profiles[profileName] || profiles.default || {}

  const dotEnvKeys = parseDotEnvKeys(path.join(ROOT_DIR, '.env'))
  const profileEnvKeys = parseDotEnvKeys(path.join(ROOT_DIR, `.env.${profileName}`))
  const hasKey = (k) => Boolean(process.env[k] || profileEnvKeys.has(k) || dotEnvKeys.has(k))

  const requiredEnv = (profile.env?.required || []).map((k) => ({ key: k, present: hasKey(k) }))
  const optionalEnv = (profile.env?.optional || []).map((k) => ({ key: k, present: hasKey(k) }))

  const agy = getAgyPluginState()
  const python = getPythonVenvState(profile)
  const localInference = getLocalInferenceState()
  const readiness = evaluateReadiness({ requiredEnv, python, agy, operation })

  return {
    activeProfile: profileName,
    description: profile.description || '',
    agy: {
      pluginSource: agy.source,
      plugins: agy.plugins,
      conserveModels: profile.agy?.conserveModels || ['agy@gemini-4-argon'],
      preferredPools: profile.agy?.preferredPools || ['agy@gemini', 'agy@claude-gpt'],
    },
    env: { required: requiredEnv, optional: optionalEnv },
    python,
    cloud: profile.cloud || {},
    localInference,
    executionReady: readiness.executionReady,
    toolingReady: readiness.toolingReady,
    diagnostics: readiness.diagnostics,
    issues: readiness.issues,
    ok: readiness.ok,
  }
}

export function applyProfile(profileName, { dryRun = false } = {}) {
  const { profiles } = loadProfiles()
  const profile = profiles[profileName]
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(', ')}`)
  }

  const actions = []
  for (const name of profile.plugins?.enable || []) {
    if (dryRun) {
      actions.push({ action: 'enable-plugin', target: name, status: 'dry-run' })
    } else {
      const res = runCommandSafe('agy', ['plugin', 'enable', name], 8000)
      actions.push({ action: 'enable-plugin', target: name, status: res.ok ? 'ok' : 'skipped', detail: res.ok ? '' : res.stderr })
    }
  }
  for (const name of profile.plugins?.disable || []) {
    if (dryRun) {
      actions.push({ action: 'disable-plugin', target: name, status: 'dry-run' })
    } else {
      const res = runCommandSafe('agy', ['plugin', 'disable', name], 8000)
      actions.push({ action: 'disable-plugin', target: name, status: res.ok ? 'ok' : 'skipped', detail: res.ok ? '' : res.stderr })
    }
  }

  if (!dryRun) {
    fs.writeFileSync(
      STATE_PATH,
      `${JSON.stringify({ activeProfile: profileName, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  }

  return {
    profile: profileName,
    dryRun,
    actions,
    snapshot: getEnvSnapshot(profileName),
  }
}

export function formatEnvStatus(snapshot) {
  const lines = []
  lines.push(`Active profile: ${snapshot.activeProfile}${snapshot.description ? ` — ${snapshot.description}` : ''}`)
  const enabledPlugins = snapshot.agy.plugins.filter((p) => p.enabled).map((p) => p.name)
  lines.push(`AGY plugins (${snapshot.agy.pluginSource}): ${enabledPlugins.length ? enabledPlugins.join(', ') : 'none'}`)
  lines.push(`AGY pools: ${snapshot.agy.preferredPools.join(', ')} | [CONSERVE]: ${snapshot.agy.conserveModels.join(', ')}`)
  lines.push(`Python satellite venv: ${snapshot.python.exists ? `${snapshot.python.version || 'found'} (${snapshot.python.path})` : `missing (${snapshot.python.path})`}`)
  lines.push(`Readiness: execution=${snapshot.executionReady ? 'ready' : 'blocked'}, tooling=${snapshot.toolingReady ? 'ready' : 'incomplete'}`)
  lines.push(`Local inference: ${snapshot.localInference.status}`)
  if (snapshot.env.required.length > 0) {
    lines.push(`Required env: ${snapshot.env.required.map((e) => `${e.key}=${e.present ? 'set' : 'MISSING'}`).join(', ')}`)
  }
  if (snapshot.issues.length > 0) {
    lines.push(`Issues: ${snapshot.issues.join('; ')}`)
  }
  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const sub = args[0] || 'status'
  const json = args.includes('--json')
  const dryRun = args.includes('--dry-run')
  const strict = args.includes('--strict')

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(
      'Usage:\n' +
        '  ./workspace env status [--json]\n' +
        '  ./workspace env list [--json]\n' +
        '  ./workspace env use <profile> [--dry-run] [--json]\n' +
        '  ./workspace env check [--strict] [--json]',
    )
    return
  }

  if (sub === 'list') {
    const { defaultProfile, profiles } = loadProfiles()
    const active = getActiveProfileName()
    if (json) {
      console.log(JSON.stringify({ activeProfile: active, defaultProfile, profiles }, null, 2))
      return
    }
    for (const [name, cfg] of Object.entries(profiles)) {
      const marker = name === active ? '*' : ' '
      console.log(`${marker} ${name}: ${cfg.description || ''}`)
    }
    return
  }

  if (sub === 'use') {
    const target = args.find((a, idx) => idx > 0 && !a.startsWith('-'))
    if (!target) {
      console.error('Usage: ./workspace env use <profile> [--dry-run] [--json]')
      process.exit(2)
    }
    const result = applyProfile(target, { dryRun })
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`${dryRun ? '[dry-run] ' : ''}Switched to profile "${target}".`)
      console.log(formatEnvStatus(result.snapshot))
    }
    return
  }

  const snapshot = getEnvSnapshot()
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2))
  } else {
    console.log(formatEnvStatus(snapshot))
  }
  if (sub === 'check' && strict && !snapshot.ok) {
    process.exit(1)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

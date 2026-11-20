import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Strictly allowlisted toolchain/environment keys that the portable loader will
 * read from .env / .env.local / process.env. Non-allowlisted keys (such as API
 * keys, tokens, or passwords) are never extracted or emitted.
 */
export const TOOLCHAIN_ENV_ALLOWLIST = Object.freeze([
  // Node.js & npm ecosystem
  'NODE_BIN',
  'NPM_CONFIG_PREFIX',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  'NVM_DIR',
  'NVM_BIN',
  'NVM_HOME',
  'NVM_SYMLINK',
  'VOLTA_HOME',
  'COREPACK_HOME',
  // Python & uv ecosystem
  'PYTHON_BIN',
  'UV_BIN',
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'UV_TOOL_DIR',
  'UV_TOOL_BIN_DIR',
  'VIRTUAL_ENV',
  'PIP_CACHE_DIR',
  // Shells
  'PWSH_BIN',
  'POWERSHELL_BIN',
  'GIT_BASH_BIN',
  // Workspace & workflow utilities
  'GIT_BIN',
  'GH_BIN',
  'CURL_BIN',
  'JQ_BIN',
  'RG_BIN',
  'SQLITE3_BIN',
  'DOCKER_BIN',
  // AI CLIs
  'OPENCODE_BIN',
  'CODEX_BIN',
  'CLAUDE_BIN',
  'AGY_BIN',
  'HERMES_BIN',
  'COPILOT_BIN',
  // Companion repository roots
  'MPW_ROOT',
  'CAB_ROOT'
])

const ALLOWLIST_SET = new Set(TOOLCHAIN_ENV_ALLOWLIST)

export function isSafeSingleLineValue(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value)
}

export function parseDotEnv(content) {
  const result = {}
  if (!content || typeof content !== 'string') return result
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex).trim().replace(/^export\s+/, '')
    if (!ALLOWLIST_SET.has(key)) continue
    let value = line.slice(eqIndex + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      // Strip inline comment preceded by whitespace on unquoted values
      value = value.replace(/\s+#.*$/, '').trim()
    }
    if (isSafeSingleLineValue(value)) {
      result[key] = value
    }
  }
  return result
}

function defaultReadText(targetPath) {
  try {
    return existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * Load portable, non-secret toolchain configuration with layered precedence:
 *   1. Explicit process.env overrides (highest)
 *   2. Project .env.local
 *   3. Project .env
 *   4. Discovered inventory defaults (lowest, when provided)
 */
export function loadToolchainEnvConfig({
  cwd = process.cwd(),
  env = process.env,
  inventory = null,
  readText = defaultReadText
} = {}) {
  const dotEnvPath = path.join(cwd, '.env')
  const dotEnvLocalPath = path.join(cwd, '.env.local')

  const fromDotEnv = parseDotEnv(readText(dotEnvPath))
  const fromDotEnvLocal = parseDotEnv(readText(dotEnvLocalPath))

  const fromProcessEnv = {}
  for (const key of TOOLCHAIN_ENV_ALLOWLIST) {
    if (typeof env[key] === 'string') {
      const trimmed = env[key].trim()
      if (isSafeSingleLineValue(trimmed)) {
        fromProcessEnv[key] = trimmed
      }
    }
  }

  const fromDiscovery = {}
  if (inventory) {
    if (inventory.node?.active?.path) fromDiscovery.NODE_BIN = inventory.node.active.path
    if (inventory.node?.npm?.globalPrefix) fromDiscovery.NPM_CONFIG_PREFIX = inventory.node.npm.globalPrefix
    if (inventory.node?.managers?.fnm?.fnmDir && inventory.node.managers.fnm.detected) {
      fromDiscovery.FNM_DIR = inventory.node.managers.fnm.fnmDir
    }
    if (inventory.node?.managers?.fnm?.multishellPath) {
      fromDiscovery.FNM_MULTISHELL_PATH = inventory.node.managers.fnm.multishellPath
    }
    if (inventory.node?.managers?.nvm?.nvmDir) fromDiscovery.NVM_DIR = inventory.node.managers.nvm.nvmDir
    if (inventory.python?.active?.path) fromDiscovery.PYTHON_BIN = inventory.python.active.path
    if (inventory.python?.uv?.path) fromDiscovery.UV_BIN = inventory.python.uv.path
    if (inventory.python?.uv?.cacheDir) fromDiscovery.UV_CACHE_DIR = inventory.python.uv.cacheDir
    if (inventory.python?.activeVirtualEnv) fromDiscovery.VIRTUAL_ENV = inventory.python.activeVirtualEnv
    for (const util of inventory.utilities || []) {
      const key = `${util.name.toUpperCase()}_BIN`
      if (util.available && util.path && ALLOWLIST_SET.has(key)) {
        fromDiscovery[key] = util.path
      }
    }
    for (const cli of inventory.aiClis || []) {
      const key = `${cli.name.toUpperCase()}_BIN`
      if (cli.available && cli.path && ALLOWLIST_SET.has(key)) {
        fromDiscovery[key] = cli.path
      }
    }
  }

  const values = {}
  const sources = {}
  for (const key of TOOLCHAIN_ENV_ALLOWLIST) {
    if (key in fromProcessEnv) {
      values[key] = fromProcessEnv[key]
      sources[key] = 'process.env'
    } else if (key in fromDotEnvLocal) {
      values[key] = fromDotEnvLocal[key]
      sources[key] = '.env.local'
    } else if (key in fromDotEnv) {
      values[key] = fromDotEnv[key]
      sources[key] = '.env'
    } else if (key in fromDiscovery) {
      values[key] = fromDiscovery[key]
      sources[key] = 'discovery'
    }
  }

  return {
    schemaVersion: 'toolchain-env-config/v1.0',
    readOnly: true,
    values,
    sources,
    loadedFiles: [
      ...(Object.keys(fromDotEnv).length > 0 ? ['.env'] : []),
      ...(Object.keys(fromDotEnvLocal).length > 0 ? ['.env.local'] : [])
    ]
  }
}

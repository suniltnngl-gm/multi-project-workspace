// Objective: Locate executables consistently on Linux, macOS, and Windows.
// Requirements: Never shell out to `command -v`; honor PATHEXT on Windows; prefer python3 but fall back to python.
// Decisions: A tiny module so routes and scanners use the same PATH rules.
// Relevant Files: apps/api/src/executables.js, apps/api/src/routes/tools.js
// Important Context: User file. Availability is based on PATH membership, not on a successful --version call.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { loadToolchainEnvConfig } from './toolchain/configuration/env-config-loader.js'
import { probeOnPath } from './toolchain/discovery/shared.js'

const COMMAND_ENV_KEY = Object.freeze({
  node: 'NODE_BIN',
  uv: 'UV_BIN',
  python: 'PYTHON_BIN',
  python3: 'PYTHON_BIN',
  git: 'GIT_BIN',
  gh: 'GH_BIN',
  curl: 'CURL_BIN',
  jq: 'JQ_BIN',
  rg: 'RG_BIN',
  sqlite3: 'SQLITE3_BIN',
  docker: 'DOCKER_BIN',
  opencode: 'OPENCODE_BIN',
  codex: 'CODEX_BIN',
  claude: 'CLAUDE_BIN',
  agy: 'AGY_BIN',
  hermes: 'HERMES_BIN',
  copilot: 'COPILOT_BIN'
})

export function findExecutable(
  command,
  { env = process.env, platform = process.platform, fileExists = existsSync } = {}
) {
  if (!command) return null
  if (command.includes('/') || command.includes('\\')) {
    return fileExists(command) ? command : null
  }
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const directory of (env.PATH || '').split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    if (!cleanDirectory) continue
    for (const extension of extensions) {
      const candidate = join(cleanDirectory, `${command}${extension}`)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

export function resolvePythonCommand(options = {}) {
  for (const candidate of ['python3', 'python']) {
    if (findExecutable(candidate, options)) return candidate
  }
  return 'python'
}

export function resolveToolchainExecutable(
  command,
  {
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    fileExists = existsSync,
    isBrokenSymlink,
    readText
  } = {}
) {
  if (!command) {
    return { path: null, brokenSymlink: false, brokenSymlinkPath: null, source: 'not-found' }
  }
  const envKey = COMMAND_ENV_KEY[String(command).toLowerCase()]
  if (envKey) {
    const cfg = loadToolchainEnvConfig({ cwd, env, ...(readText ? { readText } : {}) })
    const configured = cfg.values[envKey]
    if (configured) {
      if (fileExists(configured)) {
        return {
          path: configured,
          brokenSymlink: false,
          brokenSymlinkPath: null,
          source: cfg.sources[envKey] || 'env-config'
        }
      }
      if (typeof isBrokenSymlink === 'function' && isBrokenSymlink(configured)) {
        return {
          path: null,
          brokenSymlink: true,
          brokenSymlinkPath: configured,
          source: 'broken-symlink'
        }
      }
    }
  }
  const probed = probeOnPath(command, {
    env,
    platform,
    fileExists,
    ...(isBrokenSymlink ? { isBrokenSymlink } : {})
  })
  if (probed.path) {
    return { path: probed.path, brokenSymlink: false, brokenSymlinkPath: null, source: 'PATH' }
  }
  if (probed.brokenSymlinkPath) {
    return { path: null, brokenSymlink: true, brokenSymlinkPath: probed.brokenSymlinkPath, source: 'broken-symlink' }
  }
  return { path: null, brokenSymlink: false, brokenSymlinkPath: null, source: 'not-found' }
}

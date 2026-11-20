import { existsSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function isWindowsPlatform(platform = process.platform) {
  return platform === 'win32'
}

export function pathModuleFor(platform = process.platform) {
  return isWindowsPlatform(platform) ? path.win32 : path.posix
}

export function pathDelimiterFor(platform = process.platform) {
  return isWindowsPlatform(platform) ? ';' : ':'
}

export function splitEnvPath(env = process.env, platform = process.platform) {
  const raw = env.PATH || env.Path || ''
  if (!raw) return []
  return raw
    .split(pathDelimiterFor(platform))
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

export function homeDirFor(env = process.env, platform = process.platform) {
  if (isWindowsPlatform(platform)) {
    return env.USERPROFILE || env.HOME || 'C:\\Users\\Default'
  }
  return env.HOME || '/root'
}

export function defaultFileExists(targetPath) {
  try {
    return existsSync(targetPath)
  } catch {
    return false
  }
}

export function defaultIsBrokenSymlink(targetPath) {
  try {
    const stat = lstatSync(targetPath)
    return stat.isSymbolicLink() && !existsSync(targetPath)
  } catch {
    return false
  }
}

export function defaultRunCommand(command, args = [], { env = process.env, timeoutMs = 3000 } = {}) {
  try {
    const stdout = execFileSync(command, args, {
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, stdout: stdout.trim(), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || '').trim()
    }
  }
}

export function probeOnPath(
  command,
  {
    env = process.env,
    platform = process.platform,
    fileExists = defaultFileExists,
    isBrokenSymlink = defaultIsBrokenSymlink
  } = {}
) {
  if (!command) return { path: null, brokenSymlinkPath: null }
  const p = pathModuleFor(platform)
  if (command.includes('/') || command.includes('\\')) {
    if (fileExists(command)) return { path: command, brokenSymlinkPath: null }
    if (isBrokenSymlink(command)) return { path: null, brokenSymlinkPath: command }
    return { path: null, brokenSymlinkPath: null }
  }
  const extensions = isWindowsPlatform(platform)
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  const hasExt = isWindowsPlatform(platform) && /\.[a-z0-9]+$/i.test(command)
  let brokenSymlinkPath = null
  for (const dir of splitEnvPath(env, platform)) {
    const tryExts = hasExt ? [''] : extensions
    for (const ext of tryExts) {
      const candidate = p.join(dir, `${command}${ext}`)
      if (fileExists(candidate)) return { path: candidate, brokenSymlinkPath: null }
      if (!brokenSymlinkPath && isBrokenSymlink(candidate)) {
        brokenSymlinkPath = candidate
      }
    }
  }
  return { path: null, brokenSymlinkPath }
}

export function findOnPath(command, options = {}) {
  return probeOnPath(command, options).path
}

export function detectInstallMethod(executablePath, { platform = process.platform } = {}) {
  if (!executablePath) return 'missing'
  const norm = executablePath.replace(/\\/g, '/').toLowerCase()
  if (norm.includes('/fnm_multishells/') || norm.includes('/fnm/')) return 'fnm'
  if (norm.includes('/.nvm/') || norm.includes('/nvm/')) return 'nvm'
  if (norm.includes('/.volta/')) return 'volta'
  if (norm.includes('/mise/')) return 'mise'
  if (norm.includes('/.asdf/')) return 'asdf'
  if (norm.includes('/uv/python/') || norm.includes('/uv/tools/')) return 'uv'
  if (norm.includes('/.venv/') || norm.includes('/venv/')) return 'venv'
  if (norm.includes('/winget/') || norm.includes('/microsoft/winget/')) return 'winget'
  if (norm.includes('/npm-global/') || norm.includes('/appdata/roaming/npm/')) return 'npm'
  if (norm.includes('/.local/bin/') || norm.includes('/.cargo/bin/')) return 'user-local'
  if (norm.includes('/program files/') || norm.includes('/appdata/local/programs/')) return 'direct-install'
  if (norm.startsWith('/usr/bin/') || norm.startsWith('/bin/')) return isWindowsPlatform(platform) ? 'git-bash' : 'system-package'
  if (norm.startsWith('/usr/local/bin/')) return 'local-system'
  if (norm.includes('/windows/system32/')) return 'system'
  return 'unknown'
}

export function deriveInstallRoot(executablePath, { platform = process.platform } = {}) {
  if (!executablePath) return null
  const p = pathModuleFor(platform)
  const dir = p.dirname(executablePath)
  const base = p.basename(dir).toLowerCase()
  if (base === 'bin' || base === 'scripts') {
    return p.dirname(dir)
  }
  return dir
}

export function detectManager(installMethod) {
  if (['fnm', 'nvm', 'volta', 'mise', 'asdf', 'uv', 'winget', 'npm'].includes(installMethod)) {
    return installMethod
  }
  return null
}

export function probeVersion(executablePath, versionArgs, { runCommand = defaultRunCommand, env = process.env } = {}) {
  if (!executablePath || !versionArgs) return { version: null, usable: false }
  const res = runCommand(executablePath, versionArgs, { env })
  const text = (res.stdout || res.stderr || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null
  return { version: res.ok ? text : null, usable: res.ok }
}

export function createToolRecord({
  name,
  executablePath = null,
  version = null,
  installMethod = null,
  installRoot = null,
  discoverySource = 'not-found',
  active = false,
  managedBy = null,
  availableInCurrentShell = false,
  usableByChildProcess = false,
  brokenSymlinkPath = null,
  platform = process.platform,
  extra = {}
}) {
  const available = Boolean(executablePath)
  const brokenSymlink = !available && Boolean(brokenSymlinkPath)
  const resolvedMethod = installMethod || (brokenSymlink ? 'broken-symlink' : detectInstallMethod(executablePath, { platform }))
  return {
    name,
    available,
    path: executablePath,
    version,
    installMethod: available ? resolvedMethod : (brokenSymlink ? 'broken-symlink' : 'missing'),
    installRoot: available ? (installRoot || deriveInstallRoot(executablePath, { platform })) : null,
    discoverySource: brokenSymlink ? 'broken-symlink' : discoverySource,
    active,
    managedBy: available ? (managedBy ?? detectManager(resolvedMethod)) : null,
    availableInCurrentShell,
    usableByChildProcess,
    brokenSymlink,
    brokenSymlinkPath: brokenSymlink ? brokenSymlinkPath : null,
    ...extra
  }
}

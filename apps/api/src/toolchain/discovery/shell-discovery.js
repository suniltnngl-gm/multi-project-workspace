import {
  createToolRecord,
  defaultFileExists,
  defaultIsBrokenSymlink,
  defaultRunCommand,
  isWindowsPlatform,
  probeOnPath,
  probeVersion
} from './shared.js'

export function discoverShells({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  const candidates = win
    ? [
        { name: 'powershell5', cmd: 'powershell.exe', fallbacks: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], versionArgs: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
        { name: 'pwsh7', cmd: 'pwsh.exe', fallbacks: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'], versionArgs: ['--version'] },
        { name: 'git-bash', cmd: 'bash.exe', fallbacks: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'], versionArgs: ['--version'] },
        { name: 'cmd', cmd: 'cmd.exe', fallbacks: ['C:\\Windows\\System32\\cmd.exe'], versionArgs: ['/c', 'ver'] },
        { name: 'wsl', cmd: 'wsl.exe', fallbacks: ['C:\\Windows\\System32\\wsl.exe'], versionArgs: ['--status'] }
      ]
    : [
        { name: 'bash', cmd: 'bash', fallbacks: ['/usr/bin/bash', '/bin/bash'], versionArgs: ['--version'] },
        { name: 'zsh', cmd: 'zsh', fallbacks: ['/usr/bin/zsh', '/bin/zsh'], versionArgs: ['--version'] },
        { name: 'sh', cmd: 'sh', fallbacks: ['/usr/bin/sh', '/bin/sh'], versionArgs: null }
      ]

  const detected = []
  for (const spec of candidates) {
    const { path: onPath, brokenSymlinkPath } = probeOnPath(spec.cmd, { env, platform, fileExists, isBrokenSymlink })
    let resolved = onPath
    let source = onPath ? 'PATH' : 'not-found'
    if (!resolved) {
      for (const fallback of spec.fallbacks) {
        if (fileExists(fallback)) {
          resolved = fallback
          source = 'known-install-path'
          break
        }
      }
    }
    const { version, usable } = resolved && spec.versionArgs
      ? probeVersion(resolved, spec.versionArgs, { runCommand, env })
      : { version: null, usable: Boolean(resolved) }

    detected.push(createToolRecord({
      name: spec.name,
      executablePath: resolved,
      version,
      discoverySource: source,
      active: Boolean(onPath),
      availableInCurrentShell: Boolean(onPath),
      usableByChildProcess: usable,
      brokenSymlinkPath: resolved ? null : brokenSymlinkPath,
      platform
    }))
  }

  let currentShell = 'unknown'
  if (win) {
    if (env.MSYSTEM) {
      currentShell = 'git-bash'
    } else if (env.PSModulePath) {
      const psPath = env.PSModulePath.toLowerCase()
      if (psPath.includes('powershell\\7') || psPath.includes('powershell/7')) {
        currentShell = 'pwsh7'
      } else if (psPath.includes('windowspowershell')) {
        currentShell = 'powershell5'
      } else {
        currentShell = 'unknown'
      }
    } else if (env.PROMPT) {
      currentShell = 'cmd'
    }
  } else {
    currentShell = env.SHELL || 'unknown'
  }

  return {
    currentShell,
    detected
  }
}

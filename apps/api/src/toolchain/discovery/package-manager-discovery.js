import {
  createToolRecord,
  defaultFileExists,
  defaultIsBrokenSymlink,
  defaultRunCommand,
  isWindowsPlatform,
  probeOnPath,
  probeVersion
} from './shared.js'

export function discoverPackageManagers({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  const specs = win
    ? [
        { name: 'winget', cmd: 'winget.exe', args: ['--version'] },
        { name: 'npm', cmd: 'npm.cmd', args: ['--version'] },
        { name: 'uv', cmd: 'uv.exe', args: ['--version'] },
        { name: 'pip', cmd: 'pip.exe', args: ['--version'] }
      ]
    : [
        { name: 'apt', cmd: 'apt-get', args: ['--version'] },
        { name: 'npm', cmd: 'npm', args: ['--version'] },
        { name: 'uv', cmd: 'uv', args: ['--version'] },
        { name: 'pip', cmd: 'pip3', args: ['--version'] }
      ]

  const managers = {}
  for (const spec of specs) {
    const { path: resolved, brokenSymlinkPath } = probeOnPath(spec.cmd, { env, platform, fileExists, isBrokenSymlink })
    const probe = resolved ? probeVersion(resolved, spec.args, { runCommand, env }) : { version: null, usable: false }
    managers[spec.name] = createToolRecord({
      name: spec.name,
      executablePath: resolved,
      version: probe.version,
      discoverySource: resolved ? 'PATH' : 'not-found',
      active: Boolean(resolved),
      availableInCurrentShell: Boolean(resolved),
      usableByChildProcess: probe.usable,
      brokenSymlinkPath,
      platform
    })
  }
  return managers
}

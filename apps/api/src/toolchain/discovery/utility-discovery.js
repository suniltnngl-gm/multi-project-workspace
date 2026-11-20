import {
  createToolRecord,
  defaultFileExists,
  defaultIsBrokenSymlink,
  defaultRunCommand,
  isWindowsPlatform,
  probeOnPath,
  probeVersion
} from './shared.js'

const CORE_UTILITIES = [
  { name: 'git', cmd: 'git', args: ['--version'] },
  { name: 'gh', cmd: 'gh', args: ['--version'] },
  { name: 'curl', cmd: 'curl', args: ['--version'] },
  { name: 'jq', cmd: 'jq', args: ['--version'] },
  { name: 'rg', cmd: 'rg', args: ['--version'] },
  { name: 'sqlite3', cmd: 'sqlite3', args: ['--version'] },
  { name: 'docker', cmd: 'docker', args: ['--version'] }
]

export function discoverUtilities({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  return CORE_UTILITIES.map((spec) => {
    const cmd = win ? `${spec.cmd}.exe` : spec.cmd
    const { path: resolved, brokenSymlinkPath } = probeOnPath(cmd, { env, platform, fileExists, isBrokenSymlink })
    const probe = resolved ? probeVersion(resolved, spec.args, { runCommand, env }) : { version: null, usable: false }
    return createToolRecord({
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
  })
}

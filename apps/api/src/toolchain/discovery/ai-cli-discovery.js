import {
  createToolRecord,
  defaultFileExists,
  defaultIsBrokenSymlink,
  defaultRunCommand,
  isWindowsPlatform,
  probeOnPath,
  probeVersion
} from './shared.js'

const AI_CLI_SPECS = [
  { name: 'opencode', cmd: 'opencode', args: ['--version'] },
  { name: 'codex', cmd: 'codex', args: ['--version'] },
  { name: 'claude', cmd: 'claude', args: ['--version'] },
  { name: 'agy', cmd: 'agy', args: ['--version'] },
  { name: 'hermes', cmd: 'hermes', args: ['--version'] },
  { name: 'copilot', cmd: 'copilot', args: ['--version'] },
  { name: 'cline', cmd: 'cline', args: ['--version'] },
  { name: 'vibe', cmd: 'vibe', args: ['--version'] },
  { name: 'kilo', cmd: 'kilo', args: ['--version'] },
  { name: 'gemini-api', cmd: 'gemini-api', args: ['--version'] },
  { name: 'llama-server', cmd: 'llama-server', args: ['--version'] },
  { name: 'colab', cmd: 'colab', args: ['--version'] },
  { name: 'kaggle', cmd: 'kaggle', args: ['--version'] }
]

export function discoverAiClis({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  return AI_CLI_SPECS.map((spec) => {
    const primary = probeOnPath(spec.cmd, { env, platform, fileExists, isBrokenSymlink })
    const fallback = !primary.path && win
      ? probeOnPath(`${spec.cmd}.cmd`, { env, platform, fileExists, isBrokenSymlink })
      : { path: null, brokenSymlinkPath: null }
    const resolved = primary.path || fallback.path
    const brokenSymlinkPath = resolved ? null : (primary.brokenSymlinkPath || fallback.brokenSymlinkPath)
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

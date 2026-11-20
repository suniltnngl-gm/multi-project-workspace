import {
  createToolRecord,
  defaultFileExists,
  defaultIsBrokenSymlink,
  defaultRunCommand,
  findOnPath,
  homeDirFor,
  isWindowsPlatform,
  pathModuleFor,
  probeOnPath,
  probeVersion
} from './shared.js'

export function discoverNode({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  const p = pathModuleFor(platform)
  const home = homeDirFor(env, platform)
  const nodeBinName = win ? 'node.exe' : 'node'
  const npmBinName = win ? 'npm.cmd' : 'npm'

  const { path: activeNodePath, brokenSymlinkPath: nodeBrokenSymlink } = probeOnPath(nodeBinName, { env, platform, fileExists, isBrokenSymlink })
  const activeVersion = activeNodePath
    ? probeVersion(activeNodePath, ['--version'], { runCommand, env })
    : { version: null, usable: false }

  const activeNode = createToolRecord({
    name: 'node',
    executablePath: activeNodePath,
    version: activeVersion.version,
    discoverySource: activeNodePath ? 'PATH' : 'not-found',
    active: Boolean(activeNodePath),
    availableInCurrentShell: Boolean(activeNodePath),
    usableByChildProcess: activeVersion.usable,
    brokenSymlinkPath: nodeBrokenSymlink,
    platform
  })

  const fnmProbe = probeOnPath(win ? 'fnm.exe' : 'fnm', { env, platform, fileExists, isBrokenSymlink })
  const voltaProbe = probeOnPath(win ? 'volta.exe' : 'volta', { env, platform, fileExists, isBrokenSymlink })
  const miseProbe = probeOnPath(win ? 'mise.exe' : 'mise', { env, platform, fileExists, isBrokenSymlink })
  const asdfProbe = probeOnPath('asdf', { env, platform, fileExists, isBrokenSymlink })

  const managers = {
    fnm: {
      detected: Boolean(fnmProbe.path || env.FNM_DIR || env.FNM_MULTISHELL_PATH),
      path: fnmProbe.path,
      brokenSymlink: !fnmProbe.path && Boolean(fnmProbe.brokenSymlinkPath),
      brokenSymlinkPath: fnmProbe.path ? null : fnmProbe.brokenSymlinkPath,
      fnmDir: env.FNM_DIR || (win ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'fnm') : p.join(home, '.local', 'share', 'fnm')),
      multishellPath: env.FNM_MULTISHELL_PATH || null,
      multishellActive: Boolean(env.FNM_MULTISHELL_PATH)
    },
    nvm: {
      detected: Boolean(env.NVM_DIR || env.NVM_BIN || env.NVM_HOME || env.NVM_SYMLINK || fileExists(p.join(home, '.nvm', 'nvm.sh'))),
      nvmDir: env.NVM_DIR || env.NVM_HOME || (fileExists(p.join(home, '.nvm', 'nvm.sh')) ? p.join(home, '.nvm') : null),
      nvmBin: env.NVM_BIN || env.NVM_SYMLINK || null
    },
    volta: {
      detected: Boolean(voltaProbe.path || env.VOLTA_HOME),
      path: voltaProbe.path,
      brokenSymlink: !voltaProbe.path && Boolean(voltaProbe.brokenSymlinkPath),
      brokenSymlinkPath: voltaProbe.path ? null : voltaProbe.brokenSymlinkPath
    },
    mise: {
      detected: Boolean(miseProbe.path),
      path: miseProbe.path,
      brokenSymlink: !miseProbe.path && Boolean(miseProbe.brokenSymlinkPath),
      brokenSymlinkPath: miseProbe.path ? null : miseProbe.brokenSymlinkPath
    },
    asdf: {
      detected: Boolean(asdfProbe.path || env.ASDF_DIR),
      path: asdfProbe.path,
      brokenSymlink: !asdfProbe.path && Boolean(asdfProbe.brokenSymlinkPath),
      brokenSymlinkPath: asdfProbe.path ? null : asdfProbe.brokenSymlinkPath
    }
  }

  const { path: npmPath, brokenSymlinkPath: npmBrokenSymlink } = probeOnPath(npmBinName, { env, platform, fileExists, isBrokenSymlink })
  const npmProbe = npmPath ? probeVersion(npmPath, ['--version'], { runCommand, env }) : { version: null, usable: false }
  const npmGlobalPrefix = env.NPM_CONFIG_PREFIX
    || env.npm_config_prefix
    || (win ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm') : (fileExists(p.join(home, '.npm-global')) ? p.join(home, '.npm-global') : null))
  const npmGlobalBin = npmGlobalPrefix
    ? (win ? npmGlobalPrefix : p.join(npmGlobalPrefix, 'bin'))
    : null

  const npm = createToolRecord({
    name: 'npm',
    executablePath: npmPath,
    version: npmProbe.version,
    discoverySource: npmPath ? 'PATH' : 'not-found',
    active: Boolean(npmPath),
    availableInCurrentShell: Boolean(npmPath),
    usableByChildProcess: npmProbe.usable,
    brokenSymlinkPath: npmBrokenSymlink,
    platform,
    extra: {
      globalPrefix: npmGlobalPrefix,
      globalBin: npmGlobalBin
    }
  })

  const companionTools = ['pnpm', 'yarn', 'corepack'].map((name) => {
    const cmd = win ? `${name}.cmd` : name
    const { path: resolved, brokenSymlinkPath } = probeOnPath(cmd, { env, platform, fileExists, isBrokenSymlink })
    const probe = resolved ? probeVersion(resolved, ['--version'], { runCommand, env }) : { version: null, usable: false }
    return createToolRecord({
      name,
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

  return {
    active: activeNode,
    managers,
    npm,
    companions: companionTools
  }
}

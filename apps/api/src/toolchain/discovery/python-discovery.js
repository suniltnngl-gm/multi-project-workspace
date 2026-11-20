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

function classifyPythonKind(executablePath, { env = process.env, projectRoot = null } = {}) {
  if (!executablePath) return 'missing'
  const norm = executablePath.replace(/\\/g, '/').toLowerCase()
  const activeVenv = env.VIRTUAL_ENV ? env.VIRTUAL_ENV.replace(/\\/g, '/').toLowerCase() : null
  if (activeVenv && norm.startsWith(activeVenv)) return 'active-venv'
  if (projectRoot && norm.startsWith(projectRoot.replace(/\\/g, '/').toLowerCase()) && norm.includes('/.venv/')) {
    return 'project-venv'
  }
  if (norm.includes('/.venv/') || norm.includes('/venv/')) return 'venv'
  if (norm.includes('/uv/python/')) return 'uv-managed'
  if (norm.endsWith('/py.exe') || norm.endsWith('/py')) return 'windows-py-launcher'
  return 'system'
}

export function discoverPython({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  fileExists = defaultFileExists,
  isBrokenSymlink = defaultIsBrokenSymlink,
  runCommand = defaultRunCommand
} = {}) {
  const win = isWindowsPlatform(platform)
  const p = pathModuleFor(platform)
  const home = homeDirFor(env, platform)

  const uvCmd = win ? 'uv.exe' : 'uv'
  const uvPathProbe = probeOnPath(uvCmd, { env, platform, fileExists, isBrokenSymlink })
  const uvPath = uvPathProbe.path
    || (fileExists(p.join(home, '.local', 'bin', uvCmd)) ? p.join(home, '.local', 'bin', uvCmd) : null)
    || (fileExists(p.join(home, '.cargo', 'bin', uvCmd)) ? p.join(home, '.cargo', 'bin', uvCmd) : null)
  const uvProbe = uvPath ? probeVersion(uvPath, ['--version'], { runCommand, env }) : { version: null, usable: false }
  const uvOnPath = Boolean(uvPathProbe.path)

  const uvRecord = createToolRecord({
    name: 'uv',
    executablePath: uvPath,
    version: uvProbe.version,
    discoverySource: uvOnPath ? 'PATH' : (uvPath ? 'known-install-path' : 'not-found'),
    active: uvOnPath,
    availableInCurrentShell: uvOnPath,
    usableByChildProcess: uvProbe.usable,
    brokenSymlinkPath: uvPath ? null : uvPathProbe.brokenSymlinkPath,
    platform,
    extra: {
      cacheDir: env.UV_CACHE_DIR || null,
      uvPipAvailable: uvProbe.usable
    }
  })

  let uvManagedPythonPath = null
  if (uvPath && uvProbe.usable) {
    const found = runCommand(uvPath, ['python', 'find'], { env })
    if (found.ok && found.stdout) {
      uvManagedPythonPath = found.stdout.split(/\r?\n/)[0].trim() || null
    }
  }

  const primaryCmd = win ? 'python.exe' : 'python3'
  const fallbackCmd = win ? 'python3.exe' : 'python'
  const primaryPy = probeOnPath(primaryCmd, { env, platform, fileExists, isBrokenSymlink })
  const fallbackPy = !primaryPy.path ? probeOnPath(fallbackCmd, { env, platform, fileExists, isBrokenSymlink }) : { path: null, brokenSymlinkPath: null }
  const activePythonPath = primaryPy.path || fallbackPy.path
  const activePythonBroken = activePythonPath ? null : (primaryPy.brokenSymlinkPath || fallbackPy.brokenSymlinkPath)
  const activePyProbe = activePythonPath
    ? probeVersion(activePythonPath, ['--version'], { runCommand, env })
    : { version: null, usable: false }

  const activePython = createToolRecord({
    name: 'python',
    executablePath: activePythonPath,
    version: activePyProbe.version,
    discoverySource: activePythonPath ? 'PATH' : 'not-found',
    active: Boolean(activePythonPath),
    availableInCurrentShell: Boolean(activePythonPath),
    usableByChildProcess: activePyProbe.usable,
    brokenSymlinkPath: activePythonBroken,
    platform,
    extra: {
      pythonKind: classifyPythonKind(activePythonPath, { env, projectRoot: cwd })
    }
  })

  const pyLauncherProbeResult = win ? probeOnPath('py.exe', { env, platform, fileExists, isBrokenSymlink }) : { path: null, brokenSymlinkPath: null }
  const pyLauncherPath = pyLauncherProbeResult.path
  const pyLauncherProbe = pyLauncherPath ? probeVersion(pyLauncherPath, ['-0p'], { runCommand, env }) : { version: null, usable: false }
  const windowsPyLauncher = createToolRecord({
    name: 'py',
    executablePath: pyLauncherPath,
    version: pyLauncherProbe.version,
    discoverySource: pyLauncherPath ? 'PATH' : 'not-found',
    active: Boolean(pyLauncherPath),
    availableInCurrentShell: Boolean(pyLauncherPath),
    usableByChildProcess: pyLauncherProbe.usable,
    brokenSymlinkPath: pyLauncherProbeResult.brokenSymlinkPath,
    platform
  })

  const venvRoot = p.join(cwd, '.venv')
  const venvPython = win ? p.join(venvRoot, 'Scripts', 'python.exe') : p.join(venvRoot, 'bin', 'python')
  const venvExists = fileExists(venvPython)
  const activationScripts = {
    bash: p.join(venvRoot, win ? 'Scripts' : 'bin', 'activate'),
    powershell: p.join(venvRoot, win ? 'Scripts' : 'bin', 'Activate.ps1'),
    cmd: win ? p.join(venvRoot, 'Scripts', 'activate.bat') : null
  }
  const availableActivationScripts = Object.fromEntries(
    Object.entries(activationScripts).map(([shell, scriptPath]) => [
      shell,
      scriptPath && fileExists(scriptPath) ? scriptPath : null
    ])
  )

  const pipCmd = win ? 'pip.exe' : 'pip3'
  const primaryPip = probeOnPath(pipCmd, { env, platform, fileExists, isBrokenSymlink })
  const fallbackPip = !primaryPip.path ? probeOnPath('pip', { env, platform, fileExists, isBrokenSymlink }) : { path: null, brokenSymlinkPath: null }
  const pipPath = primaryPip.path || fallbackPip.path
  const pipBroken = pipPath ? null : (primaryPip.brokenSymlinkPath || fallbackPip.brokenSymlinkPath)
  const pipProbe = pipPath ? probeVersion(pipPath, ['--version'], { runCommand, env }) : { version: null, usable: false }
  const pipxPathProbe = probeOnPath(win ? 'pipx.exe' : 'pipx', { env, platform, fileExists, isBrokenSymlink })
  const pipxPath = pipxPathProbe.path
  const pipxProbe = pipxPath ? probeVersion(pipxPath, ['--version'], { runCommand, env }) : { version: null, usable: false }

  const uvPythonIsManaged = Boolean(uvManagedPythonPath && uvManagedPythonPath.replace(/\\/g, '/').toLowerCase().includes('/uv/python/'))

  return {
    active: activePython,
    uv: uvRecord,
    uvManagedPython: createToolRecord({
      name: 'uv-python',
      executablePath: uvManagedPythonPath,
      version: uvManagedPythonPath ? probeVersion(uvManagedPythonPath, ['--version'], { runCommand, env }).version : null,
      installMethod: uvPythonIsManaged ? 'uv' : null,
      discoverySource: uvManagedPythonPath ? 'uv-python-find' : 'not-found',
      active: Boolean(uvManagedPythonPath && activePythonPath === uvManagedPythonPath),
      managedBy: uvPythonIsManaged ? 'uv' : null,
      availableInCurrentShell: Boolean(uvManagedPythonPath && activePythonPath === uvManagedPythonPath),
      usableByChildProcess: Boolean(uvManagedPythonPath),
      platform,
      extra: {
        pythonKind: classifyPythonKind(uvManagedPythonPath, { env, projectRoot: cwd })
      }
    }),
    windowsPyLauncher,
    projectVenv: {
      detected: venvExists,
      root: venvExists ? venvRoot : null,
      interpreter: venvExists ? venvPython : null,
      activationScripts: availableActivationScripts
    },
    activeVirtualEnv: env.VIRTUAL_ENV || null,
    pip: createToolRecord({
      name: 'pip',
      executablePath: pipPath,
      version: pipProbe.version,
      discoverySource: pipPath ? 'PATH' : 'not-found',
      active: Boolean(pipPath),
      availableInCurrentShell: Boolean(pipPath),
      usableByChildProcess: pipProbe.usable,
      brokenSymlinkPath: pipBroken,
      platform
    }),
    pipx: createToolRecord({
      name: 'pipx',
      executablePath: pipxPath,
      version: pipxProbe.version,
      discoverySource: pipxPath ? 'PATH' : 'not-found',
      active: Boolean(pipxPath),
      availableInCurrentShell: Boolean(pipxPath),
      usableByChildProcess: pipxProbe.usable,
      brokenSymlinkPath: pipxPathProbe.brokenSymlinkPath,
      platform
    })
  }
}

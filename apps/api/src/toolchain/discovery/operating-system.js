import os from 'node:os'
import { readFileSync } from 'node:fs'
import { isWindowsPlatform } from './shared.js'

function defaultReadText(targetPath) {
  try {
    return readFileSync(targetPath, 'utf8')
  } catch {
    return null
  }
}

export function discoverOperatingSystem({
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
  env = process.env,
  readText = defaultReadText
} = {}) {
  const isWindows = isWindowsPlatform(platform)
  const isLinux = platform === 'linux'
  const family = isWindows ? 'windows' : isLinux ? 'linux' : platform === 'darwin' ? 'macos' : 'other'

  const wslDistro = isLinux ? (env.WSL_DISTRO_NAME || null) : null
  const isWsl = isLinux && Boolean(wslDistro || env.WSL_INTEROP || /microsoft/i.test(release))

  let distro = null
  if (isLinux) {
    const osRelease = readText('/etc/os-release')
    const match = osRelease?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
    distro = match ? match[1] : null
  } else if (isWindows) {
    distro = 'Windows'
  }

  return {
    platform,
    arch,
    release,
    family,
    distro,
    isWindows,
    isLinux,
    isWsl,
    wslDistro
  }
}

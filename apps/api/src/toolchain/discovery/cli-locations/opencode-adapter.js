import { homeDirFor, isWindowsPlatform, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverOpenCodeLocations({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  version = null,
  observedAt = new Date().toISOString(),
  fileExists,
  lstat,
  canRead,
  canWrite
} = {}) {
  const p = pathModuleFor(platform)
  const home = homeDirFor(env, platform)
  const win = isWindowsPlatform(platform)
  const configBase = env.OPENCODE_CONFIG_DIR
    || (win
      ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'opencode')
      : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'opencode'))
  const dataBase = win
    ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'opencode')
    : p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'opencode')

  const check = (spec) => inspectLocation({ ...spec, fileExists, lstat, canRead, canWrite })
  const locations = createEmptyLocations()
  locations.config.push(
    check({ path: configBase, kind: 'config', scope: 'user' }),
    check({ path: p.join(cwd, 'opencode.json'), kind: 'config', scope: 'workspace' })
  )
  locations.agents.push(check({ path: p.join(configBase, 'agents'), kind: 'agents', scope: 'user' }))
  locations.skills.push(check({ path: p.join(configBase, 'skills'), kind: 'skills', scope: 'user' }))
  locations.plugins.push(check({ path: p.join(configBase, 'plugins'), kind: 'plugins', scope: 'user' }))
  locations.mcp.push(check({ path: p.join(configBase, 'opencode.json'), kind: 'mcp', scope: 'user' }))
  locations.cache.push(check({ path: dataBase, kind: 'cache', scope: 'user' }))

  return createCliManifest({ cli: 'opencode', version, platform, locations, observedAt })
}

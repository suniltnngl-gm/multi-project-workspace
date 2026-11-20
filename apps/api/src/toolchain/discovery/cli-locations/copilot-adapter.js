import { homeDirFor, isWindowsPlatform, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverCopilotLocations({
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
  const copilotRoot = env.COPILOT_HOME || p.join(home, '.copilot')
  const ghConfigDir = env.GH_CONFIG_DIR
    || (win
      ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'GitHub CLI')
      : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'gh'))

  const check = (spec) => inspectLocation({ ...spec, fileExists, lstat, canRead, canWrite })
  const locations = createEmptyLocations()
  locations.config.push(
    check({ path: copilotRoot, kind: 'config', scope: 'user' }),
    check({ path: ghConfigDir, kind: 'config', scope: 'user' })
  )
  locations.skills.push(
    check({ path: p.join(copilotRoot, 'skills'), kind: 'skills', scope: 'user' }),
    check({ path: p.join(cwd, '.github', 'copilot-instructions.md'), kind: 'skills', scope: 'workspace' })
  )
  locations.mcp.push(check({ path: p.join(copilotRoot, 'mcp-config.json'), kind: 'mcp', scope: 'user' }))

  return createCliManifest({ cli: 'copilot', version, platform, locations, observedAt })
}

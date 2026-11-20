import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverHermesLocations({
  env = process.env,
  platform = process.platform,
  version = null,
  observedAt = new Date().toISOString(),
  fileExists,
  lstat,
  canRead,
  canWrite
} = {}) {
  const p = pathModuleFor(platform)
  const home = homeDirFor(env, platform)
  const hermesRoot = env.HERMES_HOME || p.join(home, '.hermes')

  const check = (spec) => inspectLocation({ ...spec, fileExists, lstat, canRead, canWrite })
  const locations = createEmptyLocations()
  locations.config.push(check({ path: p.join(hermesRoot, 'config.yaml'), kind: 'config', scope: 'user' }))
  locations.agents.push(check({ path: p.join(hermesRoot, 'hermes-agent'), kind: 'agents', scope: 'user' }))
  locations.sessions.push(check({ path: p.join(hermesRoot, 'sessions'), kind: 'sessions', scope: 'user' }))

  return createCliManifest({ cli: 'hermes', version, platform, locations, observedAt })
}

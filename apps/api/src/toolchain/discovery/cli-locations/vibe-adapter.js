import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverVibeLocations({
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
  const root = env.VIBE_HOME || p.join(home, '.vibe')
  const check = (spec) => inspectLocation({ ...spec, fileExists, lstat, canRead, canWrite })

  const locations = createEmptyLocations()
  locations.config.push(
    check({ path: root, kind: 'config', scope: 'user' }),
    check({ path: p.join(cwd, '.vibe'), kind: 'config', scope: 'workspace' })
  )
  locations.skills.push(check({ path: p.join(root, 'skills'), kind: 'skills', scope: 'user' }))
  locations.sessions.push(check({ path: p.join(root, 'sessions'), kind: 'sessions', scope: 'user' }))

  return createCliManifest({ cli: 'vibe', version, platform, locations, observedAt })
}

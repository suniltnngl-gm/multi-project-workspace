import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverClineLocations({
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
  const root = env.CLINE_DIR || p.join(home, '.cline')
  const check = (spec) => inspectLocation({ ...spec, fileExists, lstat, canRead, canWrite })

  const locations = createEmptyLocations()
  locations.config.push(check({ path: root, kind: 'config', scope: 'user' }))
  locations.skills.push(
    check({ path: p.join(root, 'skills'), kind: 'skills', scope: 'user' }),
    check({ path: p.join(cwd, '.clinerules'), kind: 'skills', scope: 'workspace' })
  )
  locations.sessions.push(check({ path: p.join(root, 'sessions'), kind: 'sessions', scope: 'user' }))

  return createCliManifest({ cli: 'cline', version, platform, locations, observedAt })
}

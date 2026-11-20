import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverCodexLocations({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  version = null,
  observedAt = new Date().toISOString(),
  fileExists,
  canRead,
  canWrite
} = {}) {
  const p = pathModuleFor(platform)
  const home = homeDirFor(env, platform)
  const codexRoot = env.CODEX_HOME || p.join(home, '.codex')
  const check = (spec) => inspectLocation({ ...spec, fileExists, canRead, canWrite })

  const locations = createEmptyLocations()
  locations.config.push(
    check({ path: codexRoot, kind: 'config', scope: 'user' }),
    check({ path: p.join(cwd, '.codex'), kind: 'config', scope: 'workspace' })
  )
  locations.skills.push(check({ path: p.join(codexRoot, 'skills'), kind: 'skills', scope: 'user' }))
  locations.sessions.push(check({ path: p.join(codexRoot, 'sessions'), kind: 'sessions', scope: 'user' }))

  return createCliManifest({ cli: 'codex', version, platform, locations, observedAt })
}

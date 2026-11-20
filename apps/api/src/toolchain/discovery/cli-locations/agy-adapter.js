import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverAgyLocations({
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
  const geminiRoot = env.GEMINI_HOME || p.join(home, '.gemini')
  const agyDataRoot = p.join(geminiRoot, 'antigravity-cli')
  const check = (spec) => inspectLocation({ ...spec, fileExists, canRead, canWrite })

  const locations = createEmptyLocations()
  locations.config.push(check({ path: p.join(geminiRoot, 'config'), kind: 'config', scope: 'user' }))
  locations.skills.push(
    check({ path: p.join(geminiRoot, 'config', 'skills'), kind: 'skills', scope: 'user' }),
    check({ path: p.join(cwd, '.agents', 'skills'), kind: 'skills', scope: 'workspace' })
  )
  locations.plugins.push(check({ path: p.join(geminiRoot, 'config', 'plugins'), kind: 'plugins', scope: 'user' }))
  locations.mcp.push(check({ path: p.join(agyDataRoot, 'mcp'), kind: 'mcp', scope: 'user' }))
  locations.artifacts.push(check({ path: p.join(agyDataRoot, 'brain'), kind: 'artifacts', scope: 'user' }))

  return createCliManifest({ cli: 'agy', version, platform, locations, observedAt })
}

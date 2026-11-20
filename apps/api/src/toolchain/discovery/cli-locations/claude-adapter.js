import { homeDirFor, pathModuleFor } from '../shared.js'
import { createCliManifest, createEmptyLocations, inspectLocation } from './shared.js'

export function discoverClaudeLocations({
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
  const claudeRoot = env.CLAUDE_CONFIG_DIR || p.join(home, '.claude')
  const check = (spec) => inspectLocation({ ...spec, fileExists, canRead, canWrite })

  const locations = createEmptyLocations()
  locations.config.push(
    check({ path: claudeRoot, kind: 'config', scope: 'user' }),
    check({ path: p.join(cwd, '.claude'), kind: 'config', scope: 'workspace' })
  )
  locations.skills.push(check({ path: p.join(claudeRoot, 'commands'), kind: 'skills', scope: 'user' }))
  locations.agents.push(check({ path: p.join(claudeRoot, 'agents'), kind: 'agents', scope: 'user' }))
  locations.mcp.push(check({ path: p.join(home, '.claude.json'), kind: 'mcp', scope: 'user' }))
  locations.sessions.push(check({ path: p.join(claudeRoot, 'projects'), kind: 'sessions', scope: 'user' }))

  return createCliManifest({ cli: 'claude', version, platform, locations, observedAt })
}

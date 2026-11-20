import { CLI_LOCATION_SCHEMA_VERSION } from './shared.js'
import { discoverAgyLocations } from './agy-adapter.js'
import { discoverClaudeLocations } from './claude-adapter.js'
import { discoverCodexLocations } from './codex-adapter.js'

export { CLI_LOCATION_SCHEMA_VERSION }

export function discoverCliLocations(options = {}) {
  const observedAt = typeof options.now === 'function'
    ? new Date(options.now()).toISOString()
    : new Date().toISOString()
  const platform = options.platform || process.platform
  const shared = { ...options, platform, observedAt }

  return {
    schemaVersion: CLI_LOCATION_SCHEMA_VERSION,
    mode: 'scan',
    readOnly: true,
    observedAt,
    platform,
    clis: [
      discoverAgyLocations(shared),
      discoverClaudeLocations(shared),
      discoverCodexLocations(shared)
    ]
  }
}

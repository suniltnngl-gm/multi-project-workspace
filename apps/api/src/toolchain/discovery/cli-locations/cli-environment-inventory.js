import { discoverCliLocations } from './index.js'
import { correlateSessions } from './session-correlator.js'

export const CLI_ENVIRONMENT_INVENTORY_SCHEMA_VERSION = 'cli-environment-inventory/v1.0'

export function buildCliEnvironmentInventory({ sessions = [], ...options } = {}) {
  const cliLocations = discoverCliLocations(options)
  const sessionCorrelations = correlateSessions({
    sessions,
    cliLocationManifest: cliLocations,
    now: options.now
  })
  return {
    schemaVersion: CLI_ENVIRONMENT_INVENTORY_SCHEMA_VERSION,
    mode: 'scan',
    readOnly: true,
    observedAt: cliLocations.observedAt,
    cliLocations,
    sessionCorrelations
  }
}

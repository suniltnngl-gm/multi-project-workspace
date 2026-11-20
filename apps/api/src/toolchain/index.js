import { discoverOperatingSystem } from './discovery/operating-system.js'
import { discoverShells } from './discovery/shell-discovery.js'
import { discoverNode } from './discovery/node-discovery.js'
import { discoverPython } from './discovery/python-discovery.js'
import { discoverPackageManagers } from './discovery/package-manager-discovery.js'
import { discoverUtilities } from './discovery/utility-discovery.js'
import { discoverAiClis } from './discovery/ai-cli-discovery.js'

export const TOOLCHAIN_SCHEMA_VERSION = 'toolchain-inventory/v1.0'

export function scanToolchain(options = {}) {
  const scannedAt = typeof options.now === 'function'
    ? new Date(options.now()).toISOString()
    : new Date().toISOString()

  return {
    schemaVersion: TOOLCHAIN_SCHEMA_VERSION,
    mode: 'scan',
    readOnly: true,
    scannedAt,
    os: discoverOperatingSystem(options),
    shells: discoverShells(options),
    node: discoverNode(options),
    python: discoverPython(options),
    packageManagers: discoverPackageManagers(options),
    utilities: discoverUtilities(options),
    aiClis: discoverAiClis(options)
  }
}

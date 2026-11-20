#!/usr/bin/env node
import { buildCliEnvironmentInventory } from '../apps/api/src/toolchain/discovery/cli-locations/cli-environment-inventory.js'

const args = new Set(process.argv.slice(2))
const inventory = buildCliEnvironmentInventory()

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  process.exit(0)
}

const lines = [`CLI Environment Inventory (${inventory.schemaVersion}, read-only) observed ${inventory.observedAt}`]
for (const cli of inventory.cliLocations.clis) {
  const counts = {}
  for (const list of Object.values(cli.locations)) {
    for (const loc of list) counts[loc.status] = (counts[loc.status] || 0) + 1
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no locations'
  lines.push(`- ${cli.cli}: verified=${cli.discovery.verified} (${summary})`)
}
lines.push(`Sessions correlated: ${inventory.sessionCorrelations.correlations.length}`)
process.stdout.write(`${lines.join('\n')}\n`)

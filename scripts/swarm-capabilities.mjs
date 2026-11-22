#!/usr/bin/env node
/**
 * D5 CLI: emits the canonical MPW-owned capability-manifest/v1.0.
 */
import { buildCapabilityManifest } from '../apps/api/src/toolchain/dispatch/capability-manifest.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-capabilities.mjs [--json]
      --json    Output full capability-manifest/v1.0 JSON (default)
  -h, --help    Show this help
`)
  process.exit(0)
}

const manifest = buildCapabilityManifest()
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)

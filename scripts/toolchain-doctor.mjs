#!/usr/bin/env node
import { scanToolchain } from '../apps/api/src/toolchain/index.js'
import { runToolchainDoctor } from '../apps/api/src/toolchain/diagnostics/toolchain-doctor.js'

const args = new Set(process.argv.slice(2))
const noFail = args.has('--no-fail')
const inventory = scanToolchain()
const report = runToolchainDoctor(inventory)
const exitCode = report.healthy || noFail ? 0 : 1

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(exitCode)
}

const lines = [
  `Toolchain Doctor (${report.schemaVersion}, read-only) — healthy=${report.healthy} (ok=${report.summary.ok}, warn=${report.summary.warn}, error=${report.summary.error})`,
  ...report.checks.map((c) => `[${c.level.toUpperCase()}] (${c.area}) ${c.message}${c.recommendation ? ` -> ${c.recommendation}` : ''}`)
]
process.stdout.write(`${lines.join('\n')}\n`)
process.exit(exitCode)

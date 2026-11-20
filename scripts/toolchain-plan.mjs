#!/usr/bin/env node
import { scanToolchain } from '../apps/api/src/toolchain/index.js'
import { loadToolchainEnvConfig } from '../apps/api/src/toolchain/configuration/env-config-loader.js'
import { generateToolchainPlan } from '../apps/api/src/toolchain/configuration/shell-config-generator.js'

const argv = process.argv.slice(2)
const isJson = argv.includes('--json')
const shellIdx = argv.indexOf('--shell')
const requestedShell = shellIdx >= 0 ? argv[shellIdx + 1] : null

const inventory = scanToolchain()
const envConfig = loadToolchainEnvConfig({ inventory })
const plan = generateToolchainPlan(inventory, envConfig)

if (isJson) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  process.exit(0)
}

if (requestedShell && requestedShell in plan.snippets) {
  process.stdout.write(`${plan.snippets[requestedShell]}\n`)
  process.exit(0)
}

process.stdout.write(`${plan.snippets.bash}\n\n${plan.snippets.dotenv}\n`)

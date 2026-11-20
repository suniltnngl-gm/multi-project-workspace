import { readFile, writeFile, mkdirSync, existsSync } from 'node:fs/promises'
import path from 'node:path'
import { resolveDispatchStateDir, createLeaseStore } from '../src/toolchain/dispatch/lease-store.js'
import { gatherTelemetry } from '../src/toolchain/dispatch/host-telemetry.js'
import { resolveGateConfig, evaluateResourceGate } from '../src/toolchain/dispatch/resource-gate.js'
import { runDispatch } from '../src/toolchain/dispatch/dispatch-executor.js'

const args = process.argv.slice(2)
const flags = {
  plan: null,
  dryRun: true,
  execute: false,
  stateDir: resolveDispatchStateDir({ env: process.env }),
  now: null,
  json: false
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan' && args[i+1]) flags.plan = args[++i]
  else if (args[i] === '--dry-run') flags.dryRun = true
  else if (args[i] === '--execute') { flags.execute = true; flags.dryRun = false }
  else if (args[i] === '--state-dir' && args[i+1]) flags.stateDir = args[++i]
  else if (args[i] === '--now') flags.now = Date.now()
  else if (args[i] === '--json') flags.json = true
}

if (!flags.plan) {
  console.error('Missing --plan <file>')
  process.exit(1)
}

async function main() {
  try {
    const plan = JSON.parse(await readFile(flags.plan, 'utf8'))
    const store = createLeaseStore({ stateDir: flags.stateDir, now: flags.now || (() => Date.now()) })
    const gateConfig = resolveGateConfig({ env: process.env })
    const telemetry = gatherTelemetry()
    
    const gate = {
      evaluateResourceGate: (params) => evaluateResourceGate({ ...params, config: gateConfig })
    }

    const result = await runDispatch({
      plan,
      mode: flags.execute ? 'execute' : 'dry-run',
      store,
      gate,
      telemetry,
      now: flags.now || (() => Date.now())
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('Outcome:', result.outcome)
      if (result.reason) console.log('Reason:', result.reason)
      if (result.wouldSpawn) {
        console.log('Would spawn:', result.wouldSpawn.bin, ...result.wouldSpawn.argv)
      }
    }

    process.exit(result.outcome === 'succeeded' || result.mode === 'dry-run' ? 0 : 1)
  } catch (err) {
    console.error('Execution failed:', err)
    process.exit(1)
  }
}

main()

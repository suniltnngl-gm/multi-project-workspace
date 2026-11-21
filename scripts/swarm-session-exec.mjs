import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveDispatchStateDir, createLeaseStore } from '../apps/api/src/toolchain/dispatch/lease-store.js'
import { gatherTelemetry } from '../apps/api/src/toolchain/dispatch/host-telemetry.js'
import { resolveGateConfig, evaluateResourceGate } from '../apps/api/src/toolchain/dispatch/resource-gate.js'
import { runDispatch } from '../apps/api/src/toolchain/dispatch/dispatch-executor.js'
import { normalizeExecutionRequest } from '../apps/api/src/toolchain/dispatch/execution-request-adapter.js'
import { parseIsoStrict } from '../apps/api/src/toolchain/dispatch/portability.js'

const args = process.argv.slice(2)
const flags = {
  plan: null,
  dryRun: true,
  execute: false,
  stateDir: resolveDispatchStateDir({ env: process.env }),
  now: null,
  prompt: '',
  cwd: process.cwd(),
  json: false
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan' && args[i+1]) flags.plan = args[++i]
  else if (args[i] === '--dry-run') flags.dryRun = true
  else if (args[i] === '--execute') { flags.execute = true; flags.dryRun = false }
  else if (args[i] === '--state-dir' && args[i+1]) flags.stateDir = args[++i]
  else if (args[i] === '--now' && args[i+1]) { const value = args[++i]; const parsed = parseIsoStrict(value); if (parsed === null) throw new Error(`--now must be an ISO-8601 timestamp with Z or offset, got: ${value}`); flags.now = parsed }
  else if (args[i] === '--prompt' && args[i+1]) flags.prompt = args[++i]
  else if (args[i] === '--cwd' && args[i+1]) flags.cwd = args[++i]
  else if (args[i] === '--json') flags.json = true
}

if (!flags.plan) {
  console.error('Missing --plan <file>')
  process.exit(1)
}

async function main() {
  try {
    const plannerPlan = JSON.parse(await readFile(flags.plan, 'utf8'))
    const normalized = normalizeExecutionRequest(plannerPlan, { prompt: flags.prompt, cwd: flags.cwd })
    if (!normalized.executable) {
      const result = normalized.record
      if (flags.json) console.log(JSON.stringify(result, null, 2))
      else { console.log('Outcome:', result.outcome); if (result.reason) console.log('Reason:', result.reason) }
      process.exit(result.exitCode)
    }
    const plan = normalized.plan
    const store = createLeaseStore({ stateDir: flags.stateDir, now: flags.now === null ? (() => Date.now()) : (() => flags.now) })
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
      now: flags.now === null ? (() => Date.now()) : (() => flags.now)
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('Outcome:', result.mode === 'dry-run' ? 'dry-run' : result.outcome)
      if (result.reason) console.log('Reason:', result.reason)
      if (result.wouldSpawn) {
        console.log('Would spawn:', result.wouldSpawn.bin, ...result.wouldSpawn.argv)
      }
    }

    process.exit(result.mode === 'dry-run' || result.outcome === 'succeeded' ? 0 : result.outcome === 'deferred' || result.outcome === 'await_in_flight' ? 3 : result.outcome === 'blocked' ? 2 : 1)
  } catch (err) {
    console.error('Execution failed:', err)
    process.exit(1)
  }
}

main()

#!/usr/bin/env node
import { scanToolchain } from '../apps/api/src/toolchain/index.js'
import {
  buildToolchainUpdatePlan,
  executeToolchainUpdatePlan
} from '../apps/api/src/toolchain/update-planner.js'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const isJson = argv.includes('--json')
const wantApply = argv.includes('--apply')
// --dry-run is accepted explicitly; the planner always emits a dry-run plan
// unless --apply is passed, in which case steps are executed for real.
const wantDryRun = argv.includes('--dry-run') || !wantApply

const inventory = scanToolchain()
const plan = buildToolchainUpdatePlan(inventory)

function spawnPromise(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false })
    child.on('error', (error) =>
      resolve({ ok: false, exitCode: null, error: error.message })
    )
    child.on('close', (exitCode) => resolve({ ok: exitCode === 0, exitCode }))
  })
}

let output = plan
if (wantApply) {
  const execution = await executeToolchainUpdatePlan(plan, {
    apply: true,
    spawnFn: spawnPromise
  })
  output = { plan, execution, dryRun: false }
}

if (isJson) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(`Toolchain update plan (${plan.schemaVersion})\n`)
process.stdout.write(`platform: ${plan.platform}\n`)
process.stdout.write(`dry-run: ${wantDryRun && !wantApply}\n`)
process.stdout.write(`steps: ${plan.steps.length}\n`)
for (const step of plan.steps) {
  process.stdout.write(`  - ${step.id} (${step.tool}): ${[step.bin, ...step.args].join(' ')}\n`)
  process.stdout.write(`      ${step.reason}\n`)
}
if (wantApply && output.execution) {
  process.stdout.write(`\nExecution results:\n`)
  for (const result of output.execution.results) {
    process.stdout.write(
      `  [${result.ok ? 'ok' : 'fail'}] ${result.id} (${result.tool}) exitCode=${result.exitCode}${
        result.error ? ` error=${result.error}` : ''
      }\n`
    )
  }
}
process.stdout.write(`\nScheduler: ${plan.scheduler.kind}\n${plan.scheduler.snippet}\n`)
process.exit(0)
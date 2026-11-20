#!/usr/bin/env node
import path from 'node:path'
import { scanToolchain } from '../apps/api/src/toolchain/index.js'
import { loadToolchainEnvConfig } from '../apps/api/src/toolchain/configuration/env-config-loader.js'
import { generateToolchainPlan } from '../apps/api/src/toolchain/configuration/shell-config-generator.js'
import { applyToolchainConfig, restoreToolchainConfig } from '../apps/api/src/toolchain/configuration/configure-apply.js'

const argv = process.argv.slice(2)
const isJson = argv.includes('--json')
const applyFlag = argv.includes('--apply')

function readArg(flag) {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : null
}

const targetArg = readArg('--target')
const shellArg = readArg('--shell') || 'dotenv'
const restoreArg = readArg('--restore')
const backupDirArg = readArg('--backup-dir')

if (!targetArg) {
  process.stderr.write('Usage: node scripts/toolchain-configure.mjs --target <absolute-path> [--shell bash|powershell5|pwsh7|cmd|dotenv] [--apply] [--restore <backup-path>] [--json]\n')
  process.exit(2)
}

const targetPath = path.resolve(targetArg)

let result
if (restoreArg) {
  result = restoreToolchainConfig({
    targetPath,
    backupPath: path.resolve(restoreArg),
    authorize: applyFlag
  })
} else {
  const inventory = scanToolchain()
  const envConfig = loadToolchainEnvConfig({ inventory })
  const plan = generateToolchainPlan(inventory, envConfig)
  if (!(shellArg in plan.snippets)) {
    process.stderr.write(`Unknown shell snippet: ${shellArg}\n`)
    process.exit(2)
  }
  result = applyToolchainConfig({
    targetPath,
    content: plan.snippets[shellArg],
    shell: shellArg,
    dryRun: !applyFlag,
    authorize: applyFlag,
    backupDir: backupDirArg ? path.resolve(backupDirArg) : null
  })
}

if (isJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else {
  process.stdout.write(`Toolchain Configure: mode=${result.mode} applied=${Boolean(result.applied || result.restored)} target=${result.targetPath}${result.backupPath ? ` backup=${result.backupPath}` : ''}\n`)
}

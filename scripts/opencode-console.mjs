#!/usr/bin/env node
// Objective: List the models available through OpenCode (4+1 providers) and Antigravity (agy) CLIs so rotation and study can see the live roster.
// Requirements: Delegate to `opencode models` and `agy models`; group OpenCode models across the 4+1 providers; propagate failures; never cache a stale roster.
// Decisions: A thin wrapper keeps the workspace command independent of each CLI's argument and output shape.
// Relevant Files: scripts/opencode-console.mjs, scripts/model-study.mjs, scripts/rotate-model.mjs, workspace
// Important Context: User file. OpenCode outputs provider-prefixed model ids across 4 console providers + 1 built-in provider; agy outputs tab-separated ids.
// Work State: Completed: Updated for OpenCode 4+1 provider grouping and agy roster support; Active: None; Blocked: None; Next Move: Maintain as needed.
import { spawn } from 'node:child_process'
import { loadWorkspaceEnv } from './env.mjs'

loadWorkspaceEnv()

const OPENCODE_CONSOLE_PROVIDERS = [
  'console-google',
  'console-groq',
  'console-nvidia',
  'console-openrouter',
  'opencode'
]

function runModelsCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to list models via ${command} CLI`))
        return
      }
      resolve(stdout)
    })
  })
}

async function listOpenCodeModels() {
  const stdout = await runModelsCommand('opencode')
  return stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)
}

async function listAgyModels() {
  const stdout = await runModelsCommand('agy')
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const entries = []
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.split('\r').pop().trim()
    if (!line) continue
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\t+(.*))?$/i)
    if (match) {
      entries.push({ id: match[1], label: (match[2] || '').trim() })
    }
  }
  return entries
}

function groupByProvider(models) {
  const groups = new Map(OPENCODE_CONSOLE_PROVIDERS.map((provider) => [provider, []]))
  for (const model of models) {
    const slash = model.indexOf('/')
    const provider = slash > 0 ? model.slice(0, slash) : 'opencode'
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  return groups
}

async function main() {
  const args = process.argv.slice(2)
  const useAgy = args.includes('--agy') || args[0] === 'agy'
  const positional = args.filter((arg) => arg !== '--agy')
  const subcommand = positional[0] || 'list'

  if (useAgy) {
    const entries = await listAgyModels()
    console.log(`Antigravity (agy) models (${entries.length}):`)
    for (const entry of entries) {
      console.log(entry.label ? `  ${entry.id}\t${entry.label}` : `  ${entry.id}`)
    }
    return
  }

  const lines = await listOpenCodeModels()

  if (subcommand === 'list') {
    for (const line of lines) {
      console.log(`  ${line}`)
    }
    return
  }

  const groups = groupByProvider(lines)
  console.log(`OpenCode 4+1 providers (${lines.length} models across ${groups.size} providers):`)
  for (const [provider, providerModels] of groups.entries()) {
    console.log(`  [${provider}] (${providerModels.length})`)
    for (const model of providerModels) {
      console.log(`    ${model}`)
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
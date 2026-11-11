#!/usr/bin/env node
import { loadWorkspaceEnv } from './env.mjs'

loadWorkspaceEnv()

async function listModels() {
  const { spawn } = await import('node:child_process')
  const child = spawn('opencode', ['models'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  child.stdout.on('data', (d) => stdout += d)
  child.stderr.on('data', (d) => process.stderr.write(d))

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Failed to list models via opencode CLI'))
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      resolve(lines)
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const subcommand = args[0] || 'list'

  if (subcommand === 'list') {
    try {
      const lines = await listModels()
      for (const line of lines) {
        console.log(`  ${line}`)
      }
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    }
    return
  }

  // For rotation status, use the opencode CLI to list models
  try {
    const lines = await listModels()
    for (const line of lines) {
      console.log(`  ${line}`)
    }
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
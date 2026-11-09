#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { loadWorkspaceEnv } from './env.mjs'

loadWorkspaceEnv()

const [action = 'status', sessionArgument] = process.argv.slice(2)
const session = sessionArgument || process.env.COLAB_AI_SESSION || 'workspace-qwen'

function usage() {
  console.error('Usage: ./workspace colab [status|stop] [session]')
  process.exit(2)
}

let args
if (action === 'status' || action === 'sessions' || action === 'list') {
  args = ['sessions']
} else if (action === 'stop') {
  args = ['stop', '-s', session]
} else {
  usage()
}

const result = spawnSync('colab', args, { stdio: 'inherit' })
if (result.error) {
  console.error(`Could not run colab: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)

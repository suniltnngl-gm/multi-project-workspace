/**
 * Objective: Support the with-env.mjs workflow.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: scripts/with-env.mjs
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { spawn } from 'node:child_process'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

loadWorkspaceEnv()

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('Usage: node scripts/with-env.mjs <command> [args...]')
  process.exit(2)
}

const child = spawn(args[0], args.slice(1), {
  cwd: ROOT_DIR,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Could not start ${args[0]}: ${error.message}`)
  process.exitCode = 1
})

child.on('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})

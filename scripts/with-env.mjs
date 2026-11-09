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

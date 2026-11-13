#!/usr/bin/env node
// Objective: Run the workspace Python project through uv without POSIX-only shell syntax.
// Requirements: Work from Linux, macOS, and Windows; honor UV/UV_PROJECT_ENVIRONMENT; expose apps/python/src on PYTHONPATH.
// Decisions: npm scripts call this wrapper instead of embedding `${UV:-uv}` or `PYTHONPATH=...` prefixes.
// Relevant Files: scripts/run-python.mjs, package.json, apps/python/pyproject.toml
// Important Context: User file. Arguments are forwarded to `uv run --project apps/python python`.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { ROOT_DIR } from './env.mjs'

function which(command) {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    if (!cleanDirectory) continue
    for (const extension of extensions) {
      const candidate = join(cleanDirectory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const uvBin = process.env.UV || 'uv'
if (!which(uvBin)) {
  console.error('uv is required. Install it from https://docs.astral.sh/uv/getting-started/installation/')
  process.exit(1)
}

if (process.env.VIRTUAL_ENV) {
  process.env.UV_PROJECT_ENVIRONMENT = process.env.VIRTUAL_ENV
} else if (!process.env.UV_PROJECT_ENVIRONMENT) {
  process.env.UV_PROJECT_ENVIRONMENT = join(ROOT_DIR, 'apps', 'python', '.venv')
} else if (!isAbsolute(process.env.UV_PROJECT_ENVIRONMENT)) {
  process.env.UV_PROJECT_ENVIRONMENT = resolve(
    ROOT_DIR,
    'apps',
    'python',
    process.env.UV_PROJECT_ENVIRONMENT
  )
}

process.env.PYTHONPATH = join(ROOT_DIR, 'apps', 'python', 'src')

const child = spawn(
  uvBin,
  ['run', '--project', 'apps/python', 'python', ...process.argv.slice(2)],
  {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
)

child.on('error', (error) => {
  console.error(`Could not start ${uvBin}: ${error.message}`)
  process.exitCode = 1
})

child.on('close', (code) => {
  process.exitCode = code ?? 1
})

// Objective: Locate executables consistently on Linux, macOS, and Windows.
// Requirements: Never shell out to `command -v`; honor PATHEXT on Windows; prefer python3 but fall back to python.
// Decisions: A tiny module so routes and scanners use the same PATH rules.
// Relevant Files: apps/api/src/executables.js, apps/api/src/routes/tools.js
// Important Context: User file. Availability is based on PATH membership, not on a successful --version call.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function findExecutable(
  command,
  { env = process.env, platform = process.platform, fileExists = existsSync } = {}
) {
  if (!command) return null
  if (command.includes('/') || command.includes('\\')) {
    return fileExists(command) ? command : null
  }
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const directory of (env.PATH || '').split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    if (!cleanDirectory) continue
    for (const extension of extensions) {
      const candidate = join(cleanDirectory, `${command}${extension}`)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

export function resolvePythonCommand(options = {}) {
  for (const candidate of ['python3', 'python']) {
    if (findExecutable(candidate, options)) return candidate
  }
  return 'python'
}

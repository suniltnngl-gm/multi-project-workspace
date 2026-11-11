#!/usr/bin/env node
// Objective: Scan and centrally track user files in SQLite, syncing header fields.
// Requirements: Support scan, list, and check commands; share scan rules with the API endpoint.
// Decisions: Import the API database layer instead of duplicating the parser in Python; mirror the ai-doctor import pattern.
// Relevant Files: scripts/scan-user-files.mjs, apps/api/src/userFileScan.js, apps/api/src/database.js
// Important Context: User file. Replaces scripts/scan_user_files.py and works without the API running.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { listWorkspaceUserFiles, scanWorkspaceUserFiles } from '../apps/api/src/workspaceScan.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set(['scan', 'list', 'check'])
const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'scan'
const quiet = arguments_.includes('--quiet')
const databaseFlagIndex = arguments_.indexOf('--database')
const databaseFlag = databaseFlagIndex >= 0 ? arguments_[databaseFlagIndex + 1] : undefined

loadWorkspaceEnv()

const databasePath = resolve(
  databaseFlag || process.env.DATABASE_PATH || `${ROOT_DIR}/apps/api/data/workspace.sqlite`
)

function usage() {
  console.error('Usage: scan-user-files.mjs [scan|list|check] [--database PATH] [--quiet]')
}

function main() {
  if (!COMMANDS.has(command)) {
    usage()
    process.exitCode = 2
    return
  }
  const database = createDatabase(databasePath)
  try {
    if (command === 'scan') {
      const result = scanWorkspaceUserFiles({ rootDir: ROOT_DIR, database })
      if (!quiet) {
        console.log(
          `Scanned ${result.total} user files: ${result.inserted} inserted, ` +
            `${result.synced} synced, ${result.refreshed} refreshed, ${result.skipped} unchanged.`
        )
      }
      return
    }
    const files = database.listUserFiles()
    if (command === 'list') {
      for (const file of files) console.log(file.path)
      if (!quiet) console.error(`Total: ${files.length}`)
      return
    }
    const tracked = new Set(files.map((file) => file.path))
    const missing = listWorkspaceUserFiles(ROOT_DIR).filter((path) => !tracked.has(path))
    if (missing.length > 0) {
      console.log('Missing tracked user files:')
      for (const path of missing) console.log(`  ${path}`)
      process.exitCode = 1
      return
    }
    if (!quiet) console.log(`All ${tracked.size} user files are tracked.`)
  } finally {
    database.close()
  }
}

main()

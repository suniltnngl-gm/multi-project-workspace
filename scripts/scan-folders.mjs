#!/usr/bin/env node
// Objective: Scan and centrally track folders in SQLite.
// Requirements: Exclude vendor and transient paths; support scan, list, and check commands across every registered repository or one named with --repo.
// Decisions: Import the API database layer so the folder walk and repository scoping are shared with the API endpoints; replaces scripts/scan_folders.py.
// Relevant Files: scripts/scan-folders.mjs, apps/api/src/workspaceScan.js, apps/api/src/database.js
// Important Context: User file. Replaces the Python scanner; vendor and transient artifacts are excluded from tracking.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { listWorkspaceFolders, scanWorkspaceFolders } from '../apps/api/src/workspaceScan.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set(['scan', 'list', 'check'])
const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'scan'
const quiet = arguments_.includes('--quiet')
const repoFlagIndex = arguments_.indexOf('--repo')
const repoFlag = repoFlagIndex >= 0 ? arguments_[repoFlagIndex + 1] : undefined
const databaseFlagIndex = arguments_.indexOf('--database')
const databaseFlag = databaseFlagIndex >= 0 ? arguments_[databaseFlagIndex + 1] : undefined

loadWorkspaceEnv()

const databasePath = resolve(
  databaseFlag || process.env.DATABASE_PATH || `${ROOT_DIR}/apps/api/data/workspace.sqlite`
)

function usage() {
  console.error('Usage: scan-folders.mjs [scan|list|check] [--repo NAME] [--database PATH] [--quiet]')
}

function main() {
  if (!COMMANDS.has(command)) {
    usage()
    process.exitCode = 2
    return
  }
  if (repoFlagIndex >= 0 && !repoFlag) {
    console.error('--repo requires a repository name.')
    process.exitCode = 2
    return
  }
  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    // The scan set is the requested repository, every registered
    // repository, or the workspace root itself when nothing is registered
    // yet, so a fresh database still has a first repository to track.
    const targets = (() => {
      if (repoFlag !== undefined) {
        const repository = database.getRepositoryByName(repoFlag)
        if (!repository) {
          console.error(`Unknown repository: ${repoFlag}.`)
          process.exitCode = 2
          return []
        }
        return [repository]
      }
      const registered = database.listRepositories()
      return registered.length > 0 ? registered : [database.ensureRepository(ROOT_DIR).repository]
    })()
    if (process.exitCode === 2) return

    if (command === 'scan') {
      let inserted = 0
      let updated = 0
      let total = 0
      for (const repository of targets) {
        if (!existsSync(repository.rootPath)) {
          // A missing root is drift the check command reports; the scan
          // itself warns and moves on so unrelated roots still sync.
          if (!quiet) {
            console.error(`Skipped ${repository.name}: root missing (${repository.rootPath}).`)
          }
          continue
        }
        const result = scanWorkspaceFolders({
          rootDir: repository.rootPath,
          database,
          repositoryId: repository.id
        })
        if (!quiet) {
          console.log(
            `Scanned ${repository.name}: ${result.total} folders: ${result.inserted} inserted, ${result.updated} already tracked.`
          )
        }
        inserted += result.inserted
        updated += result.updated
        total += result.total
      }
      if (!quiet && targets.length > 1) {
        console.log(
          `Total across ${targets.length} repositories: ${total} folders: ${inserted} inserted, ${updated} already tracked.`
        )
      }
      return
    }

    if (command === 'list') {
      let count = 0
      for (const repository of targets) {
        for (const folder of database.listFolders()) {
          if (folder.repositoryId !== repository.id) continue
          console.log(`${repository.name}/${folder.path}`)
          count += 1
        }
      }
      if (!quiet) console.error(`Total: ${count}`)
      return
    }

    const failures = []
    for (const repository of targets) {
      if (!existsSync(repository.rootPath)) {
        failures.push(`Repository ${repository.name} root is missing: ${repository.rootPath}`)
        continue
      }
      const tracked = new Set(
        database
          .listFolders()
          .filter((folder) => folder.repositoryId === repository.id)
          .map((folder) => folder.path)
      )
      const missing = listWorkspaceFolders(repository.rootPath).filter((path) => !tracked.has(path))
      if (missing.length > 0) {
        failures.push(`Missing tracked folders in ${repository.name}:`)
        for (const path of missing) failures.push(`  ${repository.name}/${path}`)
      } else if (!quiet) {
        console.log(`${repository.name}: all ${tracked.size} folders are tracked.`)
      }
    }
    if (failures.length > 0) {
      for (const line of failures) console.log(line)
      process.exitCode = 1
    }
  } finally {
    database.close()
  }
}

main()

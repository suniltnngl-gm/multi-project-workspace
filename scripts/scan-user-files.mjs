#!/usr/bin/env node
// Objective: Scan and centrally track user files in SQLite, syncing header fields.
// Requirements: Support scan, list, and check commands across every registered repository or one named with --repo; share scan rules with the API endpoint.
// Decisions: Import the API database layer instead of duplicating the parser in Python; mirror the ai-doctor import pattern; roots resolve through the repository registry so a fresh database registers its first root on scan.
// Relevant Files: scripts/scan-user-files.mjs, apps/api/src/workspaceScan.js, apps/api/src/database.js
// Important Context: User file. Replaces scripts/scan_user_files.py and works without the API running.
// Work State: Completed: Implemented; stale-row reporting and missing/restored scans added as task #46; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { listWorkspaceUserFiles, scanWorkspaceUserFiles } from '../apps/api/src/workspaceScan.js'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set(['scan', 'list', 'check'])
const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'scan'
const quiet = arguments_.includes('--quiet')
const repoFlagIndex = arguments_.indexOf('--repo')
const repoFlag = repoFlagIndex >= 0 ? arguments_[repoFlagIndex + 1] : undefined
const databaseFlagIndex = arguments_.indexOf('--database')
const databaseFlag = databaseFlagIndex >= 0 ? arguments_[databaseFlagIndex + 1] : undefined

loadWorkspaceEnv()

const databasePath = databaseFlag
  ? resolve(databaseFlag)
  : resolveDatabasePath({ rootDir: ROOT_DIR })

function usage() {
  console.error('Usage: scan-user-files.mjs [scan|list|check] [--repo NAME] [--database PATH] [--quiet]')
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
      const totals = { inserted: 0, synced: 0, refreshed: 0, skipped: 0, missing: 0, restored: 0, total: 0 }
      for (const repository of targets) {
        if (!existsSync(repository.rootPath)) {
          // A missing root is drift the check command reports; the scan
          // itself warns and moves on so unrelated roots still sync.
          if (!quiet) {
            console.error(`Skipped ${repository.name}: root missing (${repository.rootPath}).`)
          }
          continue
        }
        const result = scanWorkspaceUserFiles({
          rootDir: repository.rootPath,
          database,
          repositoryId: repository.id
        })
        if (!quiet) {
          console.log(
            `Scanned ${repository.name}: ${result.total} user files: ${result.inserted} inserted, ` +
              `${result.synced} synced, ${result.refreshed} refreshed, ${result.skipped} unchanged, ` +
              `${result.missing} missing, ${result.restored} restored.`
          )
        }
        totals.inserted += result.inserted
        totals.synced += result.synced
        totals.refreshed += result.refreshed
        totals.skipped += result.skipped
        totals.missing += result.missing
        totals.restored += result.restored
        totals.total += result.total
      }
      if (!quiet && targets.length > 1) {
        console.log(
          `Total across ${targets.length} repositories: ${totals.total} user files: ` +
            `${totals.inserted} inserted, ${totals.synced} synced, ${totals.refreshed} refreshed, ` +
            `${totals.skipped} unchanged, ${totals.missing} missing, ${totals.restored} restored.`
        )
      }
      return
    }

    if (command === 'list') {
      let count = 0
      for (const repository of targets) {
        for (const file of database.listUserFiles({ repositoryId: repository.id })) {
          console.log(`${repository.name}/${file.path}${file.missingAt ? ' (missing)' : ''}`)
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
      const trackedRows = database.listUserFiles({ repositoryId: repository.id })
      const tracked = new Set(trackedRows.map((file) => file.path))
      const diskFiles = listWorkspaceUserFiles(repository.rootPath)
      const disk = new Set(diskFiles)
      const missing = diskFiles.filter((path) => !tracked.has(path))
      if (missing.length > 0) {
        failures.push(`Missing tracked user files in ${repository.name}:`)
        for (const path of missing) failures.push(`  ${repository.name}/${path}`)
      } else if (!quiet) {
        console.log(`${repository.name}: all ${tracked.size} user files are tracked.`)
      }
      // Stale rows are reported but never fail the check (or the post-commit
      // hook): a deletion can be intentional, and pruning stays an explicit
      // DELETE /api/files/:id decision.
      const stale = trackedRows.filter((file) => !disk.has(file.path))
      if (stale.length > 0) {
        console.log(
          `Stale tracked user files in ${repository.name} (missing on disk, kept for history):`
        )
        for (const file of stale) console.log(`  ${repository.name}/${file.path}`)
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

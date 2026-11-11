#!/usr/bin/env node
// Objective: Scan and centrally track Git worktrees in SQLite.
// Requirements: Capture repository, worktree path, branch, HEAD, and remote URL per registered repository or one named with --repo.
// Decisions: Reuse parseWorktreePorcelain and the database layer so worktree rows associate with their repository; replaces scripts/scan_git_context.py.
// Relevant Files: scripts/scan-git-context.mjs, apps/api/src/taskWorktrees.js, apps/api/src/database.js
// Important Context: User file. Replaces the Python scanner; scans every registered repository root that is a Git repository.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { parseWorktreePorcelain } from '../apps/api/src/taskWorktrees.js'
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
  console.error('Usage: scan-git-context.mjs [scan|list|check] [--repo NAME] [--database PATH] [--quiet]')
}

function collectEntries(root) {
  const remoteUrl = (() => {
    try {
      return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return ''
    }
  })()
  const output = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const entries = parseWorktreePorcelain(output, root)
  for (const entry of entries) entry.remoteUrl = remoteUrl
  return entries
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

    const entriesByRepository = new Map()
    for (const repository of targets) {
      if (!existsSync(repository.rootPath)) {
        if (!quiet) {
          console.error(`Skipped ${repository.name}: root missing (${repository.rootPath}).`)
        }
        continue
      }
      try {
        entriesByRepository.set(repository, collectEntries(repository.rootPath))
      } catch (error) {
        // Roots that are not Git repositories have no worktrees to track.
        if (!quiet) {
          console.error(`Skipped ${repository.name}: not a Git repository (${repository.rootPath}).`)
        }
      }
    }

    if (command === 'scan') {
      let total = 0
      for (const [repository, entries] of entriesByRepository) {
        database.scanGitWorktrees(entries)
        if (!quiet) console.log(`Scanned ${repository.name}: ${entries.length} Git worktrees.`)
        total += entries.length
      }
      if (!quiet && targets.length > 1) {
        console.log(`Total across ${entriesByRepository.size} repositories: ${total} Git worktrees.`)
      }
      return
    }

    if (command === 'list') {
      let count = 0
      for (const worktree of database.listGitWorktrees()) {
        if (targets.length === 1 && worktree.repositoryId !== targets[0].id) continue
        console.log(
          [worktree.repository, worktree.worktreePath, worktree.branch, worktree.headCommit, worktree.remoteUrl].join(' | ')
        )
        count += 1
      }
      if (!quiet) console.error(`Total: ${count}`)
      return
    }

    const failures = []
    for (const [repository, entries] of entriesByRepository) {
      const tracked = new Set(
        database
          .listGitWorktrees()
          .filter((worktree) => worktree.repositoryId === repository.id)
          .map((worktree) => worktree.worktreePath)
      )
      const missing = entries
        .map((entry) => entry.worktreePath)
        .filter((path) => !tracked.has(path))
      if (missing.length > 0) {
        failures.push(`Missing tracked worktrees in ${repository.name}:`)
        for (const path of missing) failures.push(`  ${path}`)
      } else if (!quiet) {
        console.log(`${repository.name}: all ${entries.length} Git worktrees are tracked.`)
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

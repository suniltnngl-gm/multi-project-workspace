#!/usr/bin/env node
// Objective: Manage the registry of tracked repository roots.
// Requirements: Support list and add commands; reject roots that are missing, already registered, or overlapping a registered root.
// Decisions: Import the API database layer so registration rules match the API and the scanners; the workspace root registers itself on first use.
// Relevant Files: scripts/repos.mjs, apps/api/src/database.js
// Important Context: User file. repos add registers a root without scanning it; run files scan and folders scan afterwards.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'list'

loadWorkspaceEnv()

const databasePath = resolve(process.env.DATABASE_PATH || `${ROOT_DIR}/apps/api/data/workspace.sqlite`)

function usage() {
  console.error('Usage: repos.mjs list | repos.mjs add <path> [--name NAME]')
}

// Nested or containing roots would double-track every shared file, so a
// root may only be registered when it is disjoint from all known roots.
function repositoryOverlap(root, repositories) {
  const withSeparator = (path) => (path.endsWith(sep) ? path : path + sep)
  return repositories.some((repository) => {
    const other = repository.rootPath
    return root === other ||
      root.startsWith(withSeparator(other)) ||
      other.startsWith(withSeparator(root))
  })
}

if (command === 'list') {
  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    const repositories = database.listRepositories()
    for (const repository of repositories) {
      console.log(
        `${repository.name}  ${repository.rootPath}  ` +
          `(${repository.fileCount} files, ${repository.folderCount} folders, ${repository.worktreeCount} worktrees)`
      )
    }
    if (repositories.length === 0) console.error('No repositories registered.')
  } finally {
    database.close()
  }
} else if (command === 'add') {
  const path = arguments_[1]
  const nameFlagIndex = arguments_.indexOf('--name')
  const name = nameFlagIndex >= 0 ? arguments_[nameFlagIndex + 1] : undefined
  if (!path || (nameFlagIndex >= 0 && !name)) {
    usage()
    process.exit(2)
  }
  const root = resolve(path.trim())
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Repository root must be an existing directory: ${root}`)
    process.exit(2)
  }
  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    if (database.getRepositoryByRoot(root)) {
      console.error(`This repository root is already registered: ${root}`)
      process.exit(2)
    }
    if (repositoryOverlap(root, database.listRepositories())) {
      console.error(`Repository root overlaps an existing repository: ${root}`)
      process.exit(2)
    }
    if (name !== undefined && database.getRepositoryByName(name)) {
      console.error(`A repository already uses this name: ${name}`)
      process.exit(2)
    }
    const { repository, created } = database.ensureRepository(
      root,
      name !== undefined ? { name } : {}
    )
    console.log(`${created ? 'Registered' : 'Already registered'} ${repository.name} -> ${repository.rootPath}`)
  } finally {
    database.close()
  }
} else {
  usage()
  process.exit(2)
}

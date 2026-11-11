// Objective: Walk the repository for tracked user files and folders, syncing header fields.
// Requirements: Share one scan implementation between the API endpoints and scripts/scan-user-files.mjs.
// Decisions: Prune vendor and transient directories while walking so node_modules is never read; mirror the Python scanner rules the check commands validated; resolve each root through the repository registry so scans are scoped per repository.
// Relevant Files: apps/api/src/workspaceScan.js, apps/api/src/database.js, scripts/scan-user-files.mjs
// Important Context: User file. Used by the API scan endpoints and the CLI scanner so they never drift.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const NOISE_DIRECTORIES = new Set([
  'node_modules', '.venv', 'dist', '.git', '__pycache__', '.pytest_cache', 'data'
])

export function isTrackedUserFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  const normalized = filePath.replace(/\\/g, '/')
  const noisePrefixes = [
    'node_modules/', 'apps/python/.venv/', 'apps/web/dist/', 'apps/api/data/',
    '.git/'
  ]
  if (noisePrefixes.some((prefix) => normalized.startsWith(prefix))) return false
  if (normalized.split('/').includes('__pycache__')) return false
  const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase()
  const allowedExtensions = new Set([
    '.js', '.mjs', '.py', '.css', '.html', '.md', '.yml', '.yaml'
  ])
  if (!allowedExtensions.has(extension)) return false
  return true
}

export function listWorkspaceUserFiles(rootDir) {
  const results = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (NOISE_DIRECTORIES.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.github') continue
        walk(join(directory, entry.name))
      } else if (entry.isFile()) {
        const filePath = relative(rootDir, join(directory, entry.name)).replace(/\\/g, '/')
        if (isTrackedUserFile(filePath)) results.push(filePath)
      }
    }
  }
  walk(rootDir)
  return [...new Set(results)].sort()
}

// Folder paths use the same pruned walk as the user files above, so the API
// endpoint and the CLI scanner track the same set of folders.
export function listWorkspaceFolders(rootDir) {
  const results = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (NOISE_DIRECTORIES.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      results.push(relative(rootDir, join(directory, entry.name)).replace(/\\/g, '/'))
      walk(join(directory, entry.name))
    }
  }
  walk(rootDir)
  return [...new Set(results)].sort()
}

/**
 * Read every tracked file and sync its header fields through the database
 * layer, so the CLI scanner and the API endpoint behave identically. The
 * database scopes writes by content hash; see scanUserFiles there. The root
 * resolves through the repository registry, so rows land in the repository
 * they belong to and unknown roots are registered on first sight.
 */
export function scanWorkspaceUserFiles({ rootDir, database, repositoryId } = {}) {
  const root = resolve(rootDir)
  const repository = repositoryId !== undefined
    ? database.getRepository(repositoryId)
    : database.ensureRepository(root).repository
  if (!repository) {
    throw new Error(`Unknown repository id: ${repositoryId}.`)
  }
  const paths = listWorkspaceUserFiles(root)
  const files = paths.map((path) => ({
    path,
    content: readFileSync(join(root, path), 'utf8')
  }))
  const result = database.scanUserFiles(files, { repositoryId: repository.id })
  return { ...result, paths, repositoryId: repository.id }
}

/**
 * Register the folders of one repository root, mirroring the user-file scan
 * above: the root resolves through the registry and rows are scoped per
 * repository.
 */
export function scanWorkspaceFolders({ rootDir, database, repositoryId } = {}) {
  const root = resolve(rootDir)
  const repository = repositoryId !== undefined
    ? database.getRepository(repositoryId)
    : database.ensureRepository(root).repository
  if (!repository) {
    throw new Error(`Unknown repository id: ${repositoryId}.`)
  }
  const paths = listWorkspaceFolders(root)
  const result = database.scanFolders(paths, { repositoryId: repository.id })
  return { ...result, paths, repositoryId: repository.id }
}

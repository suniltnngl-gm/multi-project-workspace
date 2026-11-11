// Objective: Own the repository registry routes and the scoping helpers shared by the file and folder groups.
// Requirements: Unique names and roots; reject nested or containing roots so walks never double-track a path; register the primary repository lazily when a default-scoped write needs one.
// Decisions: The scope helpers close over the database and are exported as one factory so files and folders consume the identical resolution logic; scannable roots must exist on disk before registration.
// Relevant Files: apps/api/src/routes/repositories.js, apps/api/src/routes/files.js, apps/api/src/routes/folders.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/repositories.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseId } from './util.js'

export function createRepositoryScope(database) {
  // Repository registry: tracked rows are scoped per repository root. The
  // API's own repository is registered lazily as the primary row whenever a
  // default-scoped write needs one.
  function resolveWorkspaceRoot() {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  }

  function resolvePrimaryRepository() {
    // Repository id 1 is the primary — the API's own repository in a normal
    // deployment, since index.js registers it at startup. A fresh database
    // with no registered repository falls back to registering the API's
    // workspace root on demand.
    const primary = database.getRepository(1)
    if (primary) return primary
    try {
      return database.ensureRepository(resolveWorkspaceRoot()).repository
    } catch {
      return null
    }
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

  function registerScannableRoot(candidate) {
    const root = resolve(String(candidate))
    const existing = database.getRepositoryByRoot(root)
    if (existing) return { repository: existing }
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return {
        error: { status: 400, body: { error: 'Repository root must be an existing directory.' } }
      }
    }
    if (repositoryOverlap(root, database.listRepositories())) {
      return {
        error: { status: 409, body: { error: 'Repository root overlaps an existing repository.' } }
      }
    }
    return { repository: database.ensureRepository(root).repository }
  }

  return {
    resolveWorkspaceRoot,
    resolvePrimaryRepository,
    repositoryOverlap,
    registerScannableRoot
  }
}

export function createRepositoriesRouter({ database, repositoryScope }) {
  const { repositoryOverlap } = repositoryScope
  const router = Router()

  router.get('/api/repositories', (_request, response) => {
    response.json(database.listRepositories())
  })

  router.get('/api/repositories/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) {
      return response.status(400).json({ error: 'Repository ID must be a positive integer.' })
    }
    const repository = database.getRepository(id)
    if (!repository) return response.status(404).json({ error: 'Repository not found.' })
    return response.json(repository)
  })

  router.post('/api/repositories', (request, response) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    if (typeof body.root_path !== 'string' || !body.root_path.trim()) {
      return response.status(400).json({ error: 'Repository root must be a non-empty path.' })
    }
    if (body.root_path.trim().length > 500) {
      return response.status(400).json({ error: 'Repository root must be at most 500 characters.' })
    }
    if (
      body.name !== undefined &&
      (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)
    ) {
      return response.status(400).json({ error: 'Repository name must be a non-empty value of at most 100 characters.' })
    }
    const root = resolve(body.root_path.trim())
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return response.status(400).json({ error: 'Repository root must be an existing directory.' })
    }
    if (database.getRepositoryByRoot(root)) {
      return response.status(409).json({ error: 'This repository root is already registered.' })
    }
    if (repositoryOverlap(root, database.listRepositories())) {
      return response.status(409).json({ error: 'Repository root overlaps an existing repository.' })
    }
    const name = body.name !== undefined ? body.name.trim() : undefined
    if (name !== undefined && database.getRepositoryByName(name)) {
      return response.status(409).json({ error: 'A repository already uses this name.' })
    }
    const { repository } = database.ensureRepository(root, name !== undefined ? { name } : {})
    return response.status(201).json(repository)
  })

  return router
}

// Objective: Own the folder routes: repository-scoped listing, detail, create, update, delete, and scan.
// Requirements: The repository scope is chosen at creation and never edited; scans accept an optional root and register it when scannable.
// Decisions: Repository resolution flows through the shared repository scope so files and folders never diverge.
// Relevant Files: apps/api/src/routes/folders.js, apps/api/src/routes/util.js, apps/api/src/routes/repositories.js, apps/api/src/workspaceScan.js
// Important Context: User file. Route group for /api/folders.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { scanWorkspaceFolders } from '../workspaceScan.js'
import { parseId, validateFolderInput } from './util.js'

export function createFoldersRouter({ database, repositoryScope }) {
  const { resolveWorkspaceRoot, resolvePrimaryRepository, registerScannableRoot } = repositoryScope
  const router = Router()

  router.get('/api/folders', (request, response) => {
    let repositoryId
    if (request.query.repository) {
      const repository = database.getRepositoryByName(String(request.query.repository))
      if (!repository) return response.status(404).json({ error: 'Repository not found.' })
      repositoryId = repository.id
    }
    const folders = database.listFolders()
    response.json(repositoryId === undefined ? folders : folders.filter((folder) => folder.repositoryId === repositoryId))
  })

  router.get('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })
    const folder = database.getFolder(id)
    if (!folder) return response.status(404).json({ error: 'Folder not found.' })
    return response.json(folder)
  })

  router.post('/api/folders', (request, response) => {
    const validationError = validateFolderInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    let repository
    if (request.body.repository !== undefined) {
      repository = database.getRepositoryByName(request.body.repository.trim())
      if (!repository) return response.status(404).json({ error: 'Repository not found.' })
    } else {
      repository = resolvePrimaryRepository()
    }
    const repositoryId = repository ? repository.id : 1

    if (database.getFolderByPath(request.body.path.trim(), repositoryId)) {
      return response.status(409).json({ error: 'A tracked folder already uses this path.' })
    }

    const folder = database.createFolder({
      path: request.body.path.trim(),
      objective: (request.body.objective ?? '').trim(),
      repositoryId
    })
    return response.status(201).json(folder)
  })

  router.patch('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })

    const validationError = validateFolderInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'path')) changes.path = changes.path.trim()
    if (Object.hasOwn(changes, 'objective')) changes.objective = changes.objective.trim()

    const folder = database.updateFolder(id, changes)
    if (!folder) return response.status(404).json({ error: 'Folder not found.' })
    return response.json(folder)
  })

  router.delete('/api/folders/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Folder ID must be a positive integer.' })
    if (!database.deleteFolder(id)) return response.status(404).json({ error: 'Folder not found.' })
    return response.status(204).end()
  })

  router.post('/api/folders/scan', (request, response) => {
    const candidate = typeof request.body?.root === 'string' && request.body.root.trim()
      ? request.body.root.trim()
      : resolveWorkspaceRoot()
    const registered = registerScannableRoot(candidate)
    if (registered.error) {
      return response.status(registered.error.status).json(registered.error.body)
    }
    try {
      response.json(scanWorkspaceFolders({
        rootDir: registered.repository.rootPath,
        database,
        repositoryId: registered.repository.id
      }))
    } catch (error) {
      response.status(500).json({ error: 'Could not scan folders.' })
    }
  })

  return router
}

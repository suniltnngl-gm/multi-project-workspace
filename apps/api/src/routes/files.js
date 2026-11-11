// Objective: Own the user-file routes: repository-scoped listing, detail, create, update, delete, and scan.
// Requirements: The repository scope is chosen at creation and never edited; scans accept an optional root and register it when scannable.
// Decisions: Repository resolution flows through the shared repository scope so files and folders never diverge.
// Relevant Files: apps/api/src/routes/files.js, apps/api/src/routes/util.js, apps/api/src/routes/repositories.js, apps/api/src/workspaceScan.js
// Important Context: User file. Route group for /api/files.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { scanWorkspaceUserFiles } from '../workspaceScan.js'
import { parseId, validateUserFileInput, USER_FILE_TEXT_FIELDS } from './util.js'

export function createFilesRouter({ database, repositoryScope }) {
  const { resolveWorkspaceRoot, resolvePrimaryRepository, registerScannableRoot } = repositoryScope
  const router = Router()

  router.get('/api/files', (request, response) => {
    let repositoryId
    if (request.query.repository) {
      const repository = database.getRepositoryByName(String(request.query.repository))
      if (!repository) return response.status(404).json({ error: 'Repository not found.' })
      repositoryId = repository.id
    }
    response.json(database.listUserFiles({ search: request.query.search || '', repositoryId }))
  })

  router.get('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })
    const file = database.getUserFileDetail(id)
    if (!file) return response.status(404).json({ error: 'User file not found.' })
    return response.json(file)
  })

  router.post('/api/files', (request, response) => {
    const validationError = validateUserFileInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    let repository
    if (request.body.repository !== undefined) {
      repository = database.getRepositoryByName(request.body.repository.trim())
      if (!repository) return response.status(404).json({ error: 'Repository not found.' })
    } else {
      repository = resolvePrimaryRepository()
    }
    const repositoryId = repository ? repository.id : 1

    if (database.getUserFileByPath(request.body.path.trim(), repositoryId)) {
      return response.status(409).json({ error: 'A tracked user file already uses this path.' })
    }

    const file = database.createUserFile({
      path: request.body.path.trim(),
      repositoryId,
      ...Object.fromEntries(
        USER_FILE_TEXT_FIELDS.map((field) => [
          field,
          (request.body[field] ?? '').trim()
        ])
      )
    })
    return response.status(201).json(file)
  })

  router.patch('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })

    const validationError = validateUserFileInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'path')) changes.path = changes.path.trim()
    for (const field of USER_FILE_TEXT_FIELDS) {
      if (Object.hasOwn(changes, field)) changes[field] = changes[field].trim()
    }

    const file = database.updateUserFile(id, changes)
    if (!file) return response.status(404).json({ error: 'User file not found.' })
    return response.json(file)
  })

  router.delete('/api/files/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'File ID must be a positive integer.' })
    if (!database.deleteUserFile(id)) return response.status(404).json({ error: 'User file not found.' })
    return response.status(204).end()
  })

  router.post('/api/files/scan', (request, response) => {
    const candidate = typeof request.body?.root === 'string' && request.body.root.trim()
      ? request.body.root.trim()
      : resolveWorkspaceRoot()
    const registered = registerScannableRoot(candidate)
    if (registered.error) {
      return response.status(registered.error.status).json(registered.error.body)
    }
    try {
      response.json(scanWorkspaceUserFiles({
        rootDir: registered.repository.rootPath,
        database,
        repositoryId: registered.repository.id
      }))
    } catch (error) {
      response.status(500).json({ error: 'Could not scan user files.' })
    }
  })

  return router
}

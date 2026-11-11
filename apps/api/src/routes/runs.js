// Objective: Own the tool-run routes listing the provenance runs behind tracked changes.
// Requirements: Runs list newest first with a kind filter and a bounded limit; detail includes the same fields the activity events embed.
// Decisions: A read-only group because runs start and finish through the request middleware and the scan methods, never by direct POST.
// Relevant Files: apps/api/src/routes/runs.js, apps/api/src/db/toolRuns.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/runs.
// Work State: Completed: Added as task #33; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { parseId } from './util.js'

export function createRunsRouter({ database }) {
  const router = Router()

  router.get('/api/runs', (request, response) => {
    const kind = typeof request.query.kind === 'string' && request.query.kind ? request.query.kind : undefined
    const limit = typeof request.query.limit === 'string' ? request.query.limit : undefined
    response.json(database.listToolRuns({ ...(kind ? { kind } : {}), ...(limit ? { limit } : {}) }))
  })

  router.get('/api/runs/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Run ID must be a positive integer.' })
    const run = database.getToolRun(id)
    if (!run) return response.status(404).json({ error: 'Tool run not found.' })
    return response.json(run)
  })

  return router
}

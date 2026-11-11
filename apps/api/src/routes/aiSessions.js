// Objective: Own the AI session routes: listing, detail, create, messages, compaction, and deletion.
// Requirements: Sessions link to existing tasks; message roles and lengths are validated; deletion cascades messages.
// Decisions: Bounded history and compaction rules are enforced by the sessions store, not the route.
// Relevant Files: apps/api/src/routes/aiSessions.js, apps/api/src/db/aiSessions.js, apps/api/src/routes/util.js
// Important Context: User file. Route group for /api/ai/sessions.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { parseId } from './util.js'

export function createAiSessionsRouter({ database }) {
  const router = Router()

  router.get('/api/ai/sessions', (_request, response) => {
    response.json(database.listAiSessions())
  })

  router.get('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    const session = database.getAiSession(id)
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  router.post('/api/ai/sessions', (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const title = typeof request.body.title === 'string' ? request.body.title.trim().slice(0, 200) : ''
    let taskId
    if (request.body.task_id !== undefined) {
      if (!Number.isSafeInteger(request.body.task_id) || request.body.task_id < 1) {
        return response.status(400).json({ error: 'Task ID must be a positive integer.' })
      }
      if (!database.getTask(request.body.task_id)) {
        return response.status(404).json({ error: 'Task not found.' })
      }
      taskId = request.body.task_id
    }
    const session = database.createAiSession({ title, taskId })
    return response.status(201).json(session)
  })

  router.post('/api/ai/sessions/:id/messages', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const role = request.body.role
    const content = request.body.content
    if (typeof role !== 'string' || !['system', 'user', 'assistant'].includes(role)) {
      return response.status(400).json({ error: 'Role must be system, user, or assistant.' })
    }
    if (typeof content !== 'string' || content.length === 0 || content.length > 20000) {
      return response.status(400).json({ error: 'Content must be between 1 and 20000 characters.' })
    }
    const session = database.addAiMessage(id, { role, content })
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  router.post('/api/ai/sessions/:id/compact', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const summary = request.body.summary
    if (typeof summary !== 'string' || summary.length === 0 || summary.length > 20000) {
      return response.status(400).json({ error: 'Summary must be between 1 and 20000 characters.' })
    }
    const session = database.compactAiSession(id, summary)
    if (!session) return response.status(404).json({ error: 'AI session not found.' })
    return response.json(session)
  })

  router.delete('/api/ai/sessions/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Session ID must be a positive integer.' })
    if (!database.deleteAiSession(id)) return response.status(404).json({ error: 'AI session not found.' })
    return response.status(204).end()
  })

  return router
}

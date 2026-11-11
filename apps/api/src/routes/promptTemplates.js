// Objective: Own the prompt template routes: listing, detail, create, update, and deletion.
// Requirements: Unique names; accept both camelCase and snake_case input keys; validate lengths.
// Decisions: Persistence rules stay in the prompt templates store.
// Relevant Files: apps/api/src/routes/promptTemplates.js, apps/api/src/db/promptTemplates.js, apps/api/src/routes/util.js
// Important Context: User file. Route group for /api/prompt-templates.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { parseId } from './util.js'

export function createPromptTemplatesRouter({ database }) {
  const router = Router()

  router.get('/api/prompt-templates', (_request, response) => {
    response.json(database.listPromptTemplates())
  })

  router.get('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    const template = database.getPromptTemplate(id)
    if (!template) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.json(template)
  })

  router.post('/api/prompt-templates', (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''
    if (!name) return response.status(400).json({ error: 'Name is required.' })
    const template = database.createPromptTemplate({
      name: name.slice(0, 120),
      description: typeof request.body.description === 'string' ? request.body.description.slice(0, 500) : '',
      systemPrompt: typeof request.body.system_prompt === 'string' ? request.body.system_prompt : (typeof request.body.systemPrompt === 'string' ? request.body.systemPrompt : ''),
      userTemplate: typeof request.body.user_template === 'string' ? request.body.user_template : (typeof request.body.userTemplate === 'string' ? request.body.userTemplate : '')
    })
    return response.status(201).json(template)
  })

  router.patch('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Request body must be a JSON object.' })
    }
    const changes = {}
    if (typeof request.body.name === 'string') changes.name = request.body.name.trim().slice(0, 120)
    if (typeof request.body.description === 'string') changes.description = request.body.description.slice(0, 500)
    if (typeof request.body.system_prompt === 'string') changes.systemPrompt = request.body.system_prompt
    if (typeof request.body.systemPrompt === 'string') changes.systemPrompt = request.body.systemPrompt
    if (typeof request.body.user_template === 'string') changes.userTemplate = request.body.user_template
    if (typeof request.body.userTemplate === 'string') changes.userTemplate = request.body.userTemplate
    const template = database.updatePromptTemplate(id, changes)
    if (!template) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.json(template)
  })

  router.delete('/api/prompt-templates/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Template ID must be a positive integer.' })
    if (!database.deletePromptTemplate(id)) return response.status(404).json({ error: 'Prompt template not found.' })
    return response.status(204).end()
  })

  return router
}

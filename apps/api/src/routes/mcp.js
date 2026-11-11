// Objective: Own the MCP server and resource routes and the scan that refreshes them.
// Requirements: Scans upsert without erasing rows the snapshot no longer reports; every route fails soft when the CLI or its background service is unavailable.
// Decisions: Discovery is injected through the shared context so tests never run the real CLI; the resource list filters by server name because names are the catalog's natural key; the scan route reports the discovery failure behind 502 while upsert errors stay 500.
// Relevant Files: apps/api/src/routes/mcp.js, apps/api/src/mcpDiscovery.js, apps/api/src/db/mcpCatalog.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/mcp.
// Work State: Completed: Added as task #37; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { parseId } from './util.js'

export function createMcpRouter({ database, discoverMcp }) {
  const router = Router()

  router.get('/api/mcp/servers', (_request, response) => {
    response.json(database.listMcpServers())
  })

  router.get('/api/mcp/servers/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Server ID must be a positive integer.' })
    const server = database.getMcpServerDetail(id)
    if (!server) return response.status(404).json({ error: 'MCP server not found.' })
    return response.json(server)
  })

  router.get('/api/mcp/resources', (request, response) => {
    const serverName = typeof request.query.server === 'string' && request.query.server.trim()
      ? request.query.server.trim()
      : undefined
    if (serverName === undefined) return response.json(database.listMcpResources())
    const server = database.listMcpServers().find((entry) => entry.name === serverName)
    if (!server) return response.status(404).json({ error: 'MCP server not found.' })
    return response.json(database.listMcpResources({ serverId: server.id }))
  })

  router.post('/api/mcp/scan', async (_request, response) => {
    let discovered
    try {
      discovered = await discoverMcp()
    } catch (error) {
      return response.status(502).json({ error: 'Could not scan MCP servers.' })
    }
    if (!discovered || discovered.ok !== true) {
      return response.status(502).json({
        error: 'Could not scan MCP servers.',
        ...(discovered?.error ? { detail: discovered.error } : {})
      })
    }
    try {
      response.json(database.scanMcpCatalog({
        servers: discovered.servers,
        resources: discovered.resources
      }))
    } catch (error) {
      response.status(500).json({ error: 'Could not scan MCP servers.' })
    }
  })

  return router
}

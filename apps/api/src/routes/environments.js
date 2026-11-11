// Objective: Own the environments routes: listing tracked facts and scanning them from the running process.
// Requirements: Facts record their source; scans never modify anything outside the environments domain.
// Decisions: Entries are observed in-process, so no subprocess probing is needed.
// Relevant Files: apps/api/src/routes/environments.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/environments.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'

export function createEnvironmentsRouter({ database }) {
  const router = Router()

  router.get('/api/environments', (_request, response) => {
    response.json(database.listEnvironments())
  })

  router.post('/api/environments/scan', async (_request, response) => {
    try {
      const { execFileSync } = await import('node:child_process')
      const entries = [
        { name: 'os', value: process.platform, source: 'process.platform' },
        { name: 'architecture', value: process.arch, source: 'process.arch' },
        { name: 'node', value: process.version, source: 'process.version' },
        { name: 'cwd', value: process.cwd(), source: 'process.cwd' }
      ]
      const result = database.scanEnvironments(entries)
      response.json({ ...result, entries })
    } catch (error) {
      response.status(500).json({ error: 'Could not scan environments.' })
    }
  })

  return router
}

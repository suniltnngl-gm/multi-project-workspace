// Objective: Own the tools routes: listing tracked tools and scanning their availability and versions.
// Requirements: Probes run in bounded subprocesses; outcome counters accumulate in the tools domain.
// Decisions: The probe list lives with the route because it is the API's view of core workflow tools.
// Relevant Files: apps/api/src/routes/tools.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/tools.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { execFileSync } from 'node:child_process'

export function createToolsRouter({ database }) {
  const router = Router()

  router.get('/api/tools', (_request, response) => {
    response.json(database.listTools())
  })

  router.post('/api/tools/scan', async (_request, response) => {
    const commands = [
      { name: 'node', command: 'node' },
      { name: 'npm', command: 'npm' },
      { name: 'uv', command: 'uv' },
      { name: 'python', command: 'python3' },
      { name: 'git', command: 'git' },
      { name: 'colab', command: 'colab' },
      { name: 'kaggle', command: 'kaggle' }
    ]
    const entries = commands.map((item) => {
      let available = false
      let version = ''
      try {
        execFileSync('sh', ['-c', `command -v ${item.command}`], { stdio: 'ignore' })
        available = true
      } catch {
        available = false
      }
      if (available) {
        try {
          version = execFileSync(item.command, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          }).trim().split(/\r?\n/)[0]
        } catch {
          version = ''
        }
      }
      return {
        name: item.name,
        command: item.command,
        version,
        available
      }
    })
    const result = database.scanTools(entries)
    response.json({ ...result, entries })
  })

  return router
}

/**
 * Objective: Implement and maintain apps/api/src/index.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/api/src/index.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { createApp } from './app.js'
import { createDatabase } from './database.js'

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const database = createDatabase()
const app = createApp(database)

const server = app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`)
})

function shutdown() {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

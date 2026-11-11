import { createApp } from './app.js'
import { createDatabase } from './database.js'
import { createOpenCodeRosterCacheFromEnv } from './opencodeDiscovery.js'

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const database = createDatabase()
const opencodeRosterCache = createOpenCodeRosterCacheFromEnv()
const app = createApp(database, { opencodeRosterCache })

const server = app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`)
  // Best-effort warm-up so the first roster request sees a fresh result; a
  // missing or failing CLI only marks the roster unavailable.
  opencodeRosterCache.get()
})

function shutdown() {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

import { createApp } from './app.js'
import { createDatabase } from './database.js'

const port = Number(process.env.PORT || 3001)
const database = createDatabase()
const app = createApp(database)

const server = app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
})

function shutdown() {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

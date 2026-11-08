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

#!/usr/bin/env node
// Objective: Scan and centrally track MCP servers and their resource catalogs in SQLite.
// Requirements: Discover through the opencode CLI from the repository root, upsert without erasing unreported rows, and fail honestly when the CLI or its background service is unavailable.
// Decisions: Reuse discoverMcpCatalog and the database layer so scans and the API share one catalog shape; check re-runs discovery and reports every discovered server or resource the database does not track.
// Relevant Files: scripts/scan-mcp.mjs, apps/api/src/mcpDiscovery.js, apps/api/src/db/mcpCatalog.js, apps/api/src/database.js
// Important Context: User file. MCP is not repository-scoped, so there is no --repo flag; the catalog is discovered from the workspace root.
// Work State: Completed: Added as task #37; Active: None; Blocked: None; Next Move: Maintain as needed.
import { resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import { discoverMcpCatalog } from '../apps/api/src/mcpDiscovery.js'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'

const COMMANDS = new Set(['scan', 'list', 'check'])
const arguments_ = process.argv.slice(2)
const command = arguments_[0] ?? 'scan'
const quiet = arguments_.includes('--quiet')
const databaseFlagIndex = arguments_.indexOf('--database')
const databaseFlag = databaseFlagIndex >= 0 ? arguments_[databaseFlagIndex + 1] : undefined

loadWorkspaceEnv()

const databasePath = databaseFlag
  ? resolve(databaseFlag)
  : resolveDatabasePath({ rootDir: ROOT_DIR })

function usage() {
  console.error('Usage: scan-mcp.mjs [scan|list|check] [--database PATH] [--quiet]')
}

async function discover() {
  const discovered = await discoverMcpCatalog({ cwd: ROOT_DIR })
  if (!discovered.ok) {
    if (!quiet) console.error(`MCP discovery failed: ${discovered.error}`)
    process.exitCode = 1
    return null
  }
  return discovered
}

async function main() {
  if (!COMMANDS.has(command)) {
    usage()
    process.exitCode = 2
    return
  }
  if (databaseFlagIndex >= 0 && !databaseFlag) {
    console.error('--database requires a path.')
    process.exitCode = 2
    return
  }
  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })
  try {
    if (command === 'scan') {
      const discovered = await discover()
      if (!discovered) return
      const result = database.scanMcpCatalog({
        servers: discovered.servers,
        resources: discovered.resources
      })
      if (!quiet) {
        console.log(
          `Scanned MCP: ${result.servers} servers, ${result.resources} resources ` +
          `(${result.serversUpserted} servers upserted, ${result.resourcesUpserted} resources upserted).`
        )
      }
      return
    }

    if (command === 'list') {
      const servers = database.listMcpServers()
      const resources = database.listMcpResources()
      for (const server of servers) {
        console.log(
          [server.name, server.status, server.title, server.integrationId, server.lastSeenAt].join(' | ')
        )
      }
      for (const resource of resources) {
        console.log(
          [
            resource.server,
            resource.isTemplate ? 'template' : 'resource',
            resource.uri,
            resource.name,
            resource.mimeType,
            resource.lastSeenAt
          ].join(' | ')
        )
      }
      if (!quiet) {
        console.error(`Total: ${servers.length} MCP servers, ${resources.length} MCP resources.`)
      }
      return
    }

    const discovered = await discover()
    if (!discovered) return
    const trackedServers = new Set(database.listMcpServers().map((server) => server.name))
    const trackedResources = new Set(
      database.listMcpResources().map((resource) => `${resource.server}\u0000${resource.uri}`)
    )
    const failures = []
    for (const server of discovered.servers) {
      if (!trackedServers.has(server.name)) failures.push(`  server ${server.name}`)
    }
    for (const resource of discovered.resources) {
      if (!trackedResources.has(`${resource.server}\u0000${resource.uri}`)) {
        failures.push(`  resource ${resource.server} ${resource.uri}`)
      }
    }
    if (failures.length > 0) {
      console.log('Missing tracked MCP entries:')
      for (const line of failures) console.log(line)
      process.exitCode = 1
    } else if (!quiet) {
      console.log(
        `MCP: all ${discovered.servers.length} servers and ${discovered.resources.length} resources are tracked.`
      )
    }
  } finally {
    database.close()
  }
}

main()

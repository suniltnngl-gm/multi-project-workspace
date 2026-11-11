// Objective: Own the MCP server and resource tracking domain.
// Requirements: Upsert by unique server name and (server, uri) resource key; stamp last_seen on every scan; never erase rows for servers or resources that a scan no longer reports.
// Decisions: Vanished entries keep their rows and history because row lifecycle for deleted tracked things stays with task #46; resources cascade on server delete so a removed server never dangles; no events table, so no tool-run stamping.
// Relevant Files: apps/api/src/db/mcpCatalog.js, apps/api/src/mcpDiscovery.js, apps/api/src/routes/mcp.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Added as task #37; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createMcpCatalogStore(connection) {
  const listServersStatement = connection.prepare(`
    SELECT * FROM mcp_servers
    ORDER BY mcp_servers.name COLLATE NOCASE
  `)
  const getServerStatement = connection.prepare('SELECT * FROM mcp_servers WHERE id = ?')
  const getServerByNameStatement = connection.prepare('SELECT * FROM mcp_servers WHERE name = ?')
  const insertServerStatement = connection.prepare(`
    INSERT INTO mcp_servers (name, title, integration_id, status, status_error, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateServerStatement = connection.prepare(`
    UPDATE mcp_servers
    SET title = ?, integration_id = ?, status = ?, status_error = ?, updated_at = ?, last_seen_at = ?
    WHERE id = ?
  `)
  const touchServerStatement = connection.prepare(
    'UPDATE mcp_servers SET last_seen_at = ? WHERE id = ?'
  )
  const listResourcesStatement = connection.prepare(`
    SELECT mcp_resources.*, mcp_servers.name AS server_name
    FROM mcp_resources
    LEFT JOIN mcp_servers ON mcp_servers.id = mcp_resources.server_id
    ORDER BY mcp_servers.name COLLATE NOCASE, mcp_resources.uri COLLATE NOCASE
  `)
  const listResourcesForServerStatement = connection.prepare(`
    SELECT mcp_resources.*, mcp_servers.name AS server_name
    FROM mcp_resources
    LEFT JOIN mcp_servers ON mcp_servers.id = mcp_resources.server_id
    WHERE mcp_resources.server_id = ?
    ORDER BY mcp_resources.uri COLLATE NOCASE
  `)
  const getResourceStatement = connection.prepare(`
    SELECT mcp_resources.*, mcp_servers.name AS server_name
    FROM mcp_resources
    LEFT JOIN mcp_servers ON mcp_servers.id = mcp_resources.server_id
    WHERE mcp_resources.id = ?
  `)
  const getResourceByKeyStatement = connection.prepare(
    'SELECT * FROM mcp_resources WHERE server_id = ? AND uri = ?'
  )
  const insertResourceStatement = connection.prepare(`
    INSERT INTO mcp_resources (server_id, uri, name, description, mime_type, is_template, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateResourceStatement = connection.prepare(`
    UPDATE mcp_resources
    SET name = ?, description = ?, mime_type = ?, is_template = ?, last_seen_at = ?
    WHERE id = ?
  `)
  const touchResourceStatement = connection.prepare(
    'UPDATE mcp_resources SET last_seen_at = ? WHERE id = ?'
  )

  function toServer(row) {
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      integrationId: row.integration_id,
      status: row.status,
      ...(row.status_error !== '' ? { statusError: row.status_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at
    }
  }

  function toResource(row) {
    if (!row) return null
    return {
      id: row.id,
      serverId: row.server_id,
      ...(row.server_name !== null ? { server: row.server_name } : {}),
      uri: row.uri,
      name: row.name,
      description: row.description,
      mimeType: row.mime_type,
      isTemplate: row.is_template === 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }
  }

  return {
    listMcpServers() {
      return listServersStatement.all().map(toServer)
    },
    getMcpServer(id) {
      return toServer(getServerStatement.get(id))
    },
    getMcpServerDetail(id) {
      const server = toServer(getServerStatement.get(id))
      if (!server) return null
      return { ...server, resources: listResourcesForServerStatement.all(id).map(toResource) }
    },
    listMcpResources({ serverId } = {}) {
      if (serverId === undefined) return listResourcesStatement.all().map(toResource)
      return listResourcesForServerStatement.all(serverId).map(toResource)
    },
    getMcpResource(id) {
      return toResource(getResourceStatement.get(id))
    },
    /**
     * Upsert one discovery snapshot. Present servers and resources update
     * their fields and last_seen; entries the snapshot no longer reports
     * keep their rows untouched, so history survives a flaky server.
     */
    scanMcpCatalog({ servers = [], resources = [] } = {}) {
      const now = new Date().toISOString()
      const serverIds = new Map()
      let serversUpserted = 0
      for (const server of servers) {
        const name = String(server.name ?? '').trim()
        if (!name) continue
        const title = String(server.title ?? '')
        const integrationId = String(server.integrationId ?? '')
        const status = String(server.status ?? '')
        const statusError = String(server.statusError ?? '')
        const existing = getServerByNameStatement.get(name)
        if (!existing) {
          const result = insertServerStatement.run(
            name, title, integrationId, status, statusError, now, now, now
          )
          serverIds.set(name, Number(result.lastInsertRowid))
          serversUpserted += 1
          continue
        }
        const id = Number(existing.id)
        serverIds.set(name, id)
        const changed = existing.title !== title ||
          existing.integration_id !== integrationId ||
          existing.status !== status ||
          existing.status_error !== statusError
        if (changed) {
          updateServerStatement.run(title, integrationId, status, statusError, now, now, id)
          serversUpserted += 1
        } else {
          touchServerStatement.run(now, id)
        }
      }

      let resourcesUpserted = 0
      for (const resource of resources) {
        const serverName = String(resource.server ?? '').trim()
        const serverId = serverIds.get(serverName)
        if (serverId === undefined) continue
        const uri = String(resource.uri ?? '').trim()
        if (!uri) continue
        const name = String(resource.name ?? '')
        const description = String(resource.description ?? '')
        const mimeType = String(resource.mimeType ?? '')
        const isTemplate = resource.isTemplate ? 1 : 0
        const existing = getResourceByKeyStatement.get(serverId, uri)
        if (!existing) {
          insertResourceStatement.run(
            serverId, uri, name, description, mimeType, isTemplate, now, now
          )
          resourcesUpserted += 1
          continue
        }
        const changed = existing.name !== name ||
          existing.description !== description ||
          existing.mime_type !== mimeType ||
          existing.is_template !== isTemplate
        if (changed) {
          updateResourceStatement.run(name, description, mimeType, isTemplate, now, existing.id)
          resourcesUpserted += 1
        } else {
          touchResourceStatement.run(now, existing.id)
        }
      }

      return {
        servers: servers.length,
        resources: resources.length,
        serversUpserted,
        resourcesUpserted
      }
    }
  }
}

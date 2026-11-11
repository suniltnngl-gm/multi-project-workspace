import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { discoverMcpCatalog } from '../src/mcpDiscovery.js'

let directory
let database
let server
let baseUrl

const discoveredCatalog = {
  ok: true,
  servers: [
    { name: 'console', title: 'Console', integrationId: 'mcp_1', status: 'connected' },
    { name: 'search', title: '', integrationId: '', status: 'failed', statusError: 'connection refused' }
  ],
  resources: [
    {
      server: 'console',
      uri: 'workspace://board',
      name: 'Board',
      description: 'The task board',
      mimeType: 'application/json',
      isTemplate: false
    },
    {
      server: 'console',
      uri: 'workspace://tasks/{id}',
      name: 'Task',
      description: '',
      mimeType: 'application/json',
      isTemplate: true
    }
  ],
  error: null
}

function createFakeExecFile(responses) {
  const calls = []
  const impl = (command, args, options, callback) => {
    calls.push({ command, args, options })
    const path = args[2]
    const entry = responses[path]
    if (!entry) {
      setImmediate(() => callback(new Error(`unexpected path ${path}`), ''))
      return
    }
    setImmediate(() => callback(entry.error ?? null, entry.stdout ?? ''))
  }
  return { impl, calls }
}

const serversPayload = {
  location: { directory: '/repo' },
  data: [
    { name: 'console', status: { status: 'connected' }, title: 'Console', integrationID: 'mcp_1' },
    { name: 'search', status: { status: 'failed', error: 'connection refused' } }
  ]
}
const catalogPayload = {
  location: { directory: '/repo' },
  data: {
    resources: [
      {
        server: 'console',
        name: 'Board',
        uri: 'workspace://board',
        description: 'The task board',
        mimeType: 'application/json'
      }
    ],
    templates: [
      { server: 'console', name: 'Task', uriTemplate: 'workspace://tasks/{id}', mimeType: 'application/json' }
    ]
  }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-mcp-'))
  database = createDatabase(join(directory, 'mcp.sqlite'), { rootDir: directory })
  server = createApp(database, {
    mcpDiscovery: () => Promise.resolve(discoveredCatalog)
  }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('scans upsert servers and resources by key', () => {
  const result = database.scanMcpCatalog({
    servers: discoveredCatalog.servers,
    resources: discoveredCatalog.resources
  })
  assert.equal(result.servers, 2)
  assert.equal(result.resources, 2)
  assert.equal(result.serversUpserted, 2)
  assert.equal(result.resourcesUpserted, 2)

  const servers = database.listMcpServers()
  assert.equal(servers.length, 2)
  assert.deepEqual(servers.map((server) => server.name), ['console', 'search'])
  assert.equal(servers[0].title, 'Console')
  assert.equal(servers[0].integrationId, 'mcp_1')
  assert.equal(servers[0].status, 'connected')
  assert.equal(servers[0].statusError, undefined)
  assert.equal(servers[1].status, 'failed')
  assert.equal(servers[1].statusError, 'connection refused')

  const resources = database.listMcpResources()
  assert.equal(resources.length, 2)
  assert.equal(resources[0].server, 'console')
  assert.equal(resources[0].uri, 'workspace://board')
  assert.equal(resources[0].isTemplate, false)
  assert.equal(resources[1].uri, 'workspace://tasks/{id}')
  assert.equal(resources[1].isTemplate, true)
  assert.ok(resources[0].firstSeenAt)
  assert.ok(resources[0].lastSeenAt)

  const detail = database.getMcpServerDetail(servers[0].id)
  assert.equal(detail.name, 'console')
  assert.equal(detail.resources.length, 2)
})

test('a second scan with identical data touches rows without duplicating them', () => {
  const result = database.scanMcpCatalog({
    servers: discoveredCatalog.servers,
    resources: discoveredCatalog.resources
  })
  assert.equal(result.serversUpserted, 0)
  assert.equal(result.resourcesUpserted, 0)
  assert.equal(database.listMcpServers().length, 2)
  assert.equal(database.listMcpResources().length, 2)
})

test('a second scan updates changed fields without duplicating rows', () => {
  const result = database.scanMcpCatalog({
    servers: [
      { name: 'console', title: 'Console 2', integrationId: 'mcp_2', status: 'pending' },
      { name: 'search', title: '', integrationId: '', status: 'failed', statusError: 'connection refused' }
    ],
    resources: [
      {
        server: 'console',
        uri: 'workspace://board',
        name: 'Board renamed',
        description: 'The task board',
        mimeType: 'text/plain',
        isTemplate: false
      }
    ]
  })
  assert.equal(result.serversUpserted, 1)
  assert.equal(result.resourcesUpserted, 1)
  assert.equal(database.listMcpServers().length, 2)
  assert.equal(database.listMcpResources().length, 2)

  const consoleServer = database.listMcpServers().find((server) => server.name === 'console')
  assert.equal(consoleServer.title, 'Console 2')
  assert.equal(consoleServer.integrationId, 'mcp_2')
  assert.equal(consoleServer.status, 'pending')
  const board = database.listMcpResources({ serverId: consoleServer.id })[0]
  assert.equal(board.name, 'Board renamed')
  assert.equal(board.mimeType, 'text/plain')
})

test('entries the snapshot no longer reports keep their rows', () => {
  database.scanMcpCatalog({
    servers: [{ name: 'console', title: 'Console 2', integrationId: 'mcp_2', status: 'pending' }],
    resources: []
  })

  const servers = database.listMcpServers()
  assert.equal(servers.length, 2)
  const search = servers.find((server) => server.name === 'search')
  assert.equal(search.status, 'failed')
  assert.equal(search.statusError, 'connection refused')

  const consoleServer = servers.find((server) => server.name === 'console')
  const resources = database.listMcpResources({ serverId: consoleServer.id })
  assert.equal(resources.length, 2, 'vanished resources keep their rows')
})

test('resources for unknown servers are skipped instead of dangling', () => {
  const result = database.scanMcpCatalog({
    servers: [],
    resources: [{ server: 'ghost', uri: 'workspace://ghost', name: 'Ghost', isTemplate: false }]
  })
  assert.equal(result.resourcesUpserted, 0)
  assert.equal(database.listMcpResources().length, 2)
})

test('discovery parses servers and maps templates onto the resource shape', async () => {
  const { impl, calls } = createFakeExecFile({
    '/api/mcp': { stdout: JSON.stringify(serversPayload) },
    '/api/mcp/resource': { stdout: JSON.stringify(catalogPayload) }
  })
  const discovered = await discoverMcpCatalog({ execFileImpl: impl, cwd: directory })
  assert.equal(discovered.ok, true)
  assert.equal(discovered.error, null)
  assert.equal(discovered.servers.length, 2)
  assert.equal(discovered.servers[0].name, 'console')
  assert.equal(discovered.servers[0].title, 'Console')
  assert.equal(discovered.servers[0].integrationId, 'mcp_1')
  assert.equal(discovered.servers[0].status, 'connected')
  assert.equal(discovered.servers[1].statusError, 'connection refused')

  assert.equal(discovered.resources.length, 2)
  assert.equal(discovered.resources[0].uri, 'workspace://board')
  assert.equal(discovered.resources[0].isTemplate, false)
  assert.equal(discovered.resources[1].uri, 'workspace://tasks/{id}')
  assert.equal(discovered.resources[1].isTemplate, true)
  assert.equal(discovered.resources[1].name, 'Task')

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.command, 'opencode')
    assert.deepEqual(call.args.slice(0, 2), ['api', 'get'])
    assert.equal(call.options.cwd, directory, 'discovery runs from the requested cwd')
  }
})

test('discovery fails soft when the CLI errors', async () => {
  const { impl } = createFakeExecFile({
    '/api/mcp': { error: new Error('spawn opencode ENOENT') },
    '/api/mcp/resource': { stdout: JSON.stringify(catalogPayload) }
  })
  const discovered = await discoverMcpCatalog({ execFileImpl: impl, cwd: directory })
  assert.equal(discovered.ok, false)
  assert.equal(discovered.servers.length, 0)
  assert.equal(discovered.resources.length, 0)
  assert.match(discovered.error, /ENOENT/)
})

test('discovery fails soft when the catalog call errors or is not JSON', async () => {
  const partial = createFakeExecFile({
    '/api/mcp': { stdout: JSON.stringify(serversPayload) },
    '/api/mcp/resource': { error: new Error('timed out') }
  })
  const discovered = await discoverMcpCatalog({ execFileImpl: partial.impl, cwd: directory })
  assert.equal(discovered.ok, false)
  assert.match(discovered.error, /timed out/)

  const malformed = createFakeExecFile({
    '/api/mcp': { stdout: JSON.stringify(serversPayload) },
    '/api/mcp/resource': { stdout: 'not json at all' }
  })
  const unparsed = await discoverMcpCatalog({ execFileImpl: malformed.impl, cwd: directory })
  assert.equal(unparsed.ok, false)
  assert.match(unparsed.error, /Could not parse/)
})

test('the scan route upserts the discovered catalog', async () => {
  const scanned = await fetch(`${baseUrl}/api/mcp/scan`, { method: 'POST' })
  assert.equal(scanned.status, 200)
  const result = await scanned.json()
  assert.equal(result.servers, 2)
  assert.equal(result.resources, 2)

  const servers = await (await fetch(`${baseUrl}/api/mcp/servers`)).json()
  assert.equal(servers.length, 2)
  assert.equal(servers[0].name, 'console')

  const detail = await (await fetch(`${baseUrl}/api/mcp/servers/${servers[0].id}`)).json()
  assert.equal(detail.name, 'console')
  assert.equal(detail.resources.length, 2)

  const resources = await (await fetch(`${baseUrl}/api/mcp/resources`)).json()
  assert.equal(resources.length, 2)

  const filtered = await (await fetch(`${baseUrl}/api/mcp/resources?server=console`)).json()
  assert.equal(filtered.length, 2)
  assert.ok(filtered.every((resource) => resource.server === 'console'))

  const unknownServer = await fetch(`${baseUrl}/api/mcp/resources?server=missing`)
  assert.equal(unknownServer.status, 404)

  const missing = await fetch(`${baseUrl}/api/mcp/servers/999999`)
  assert.equal(missing.status, 404)

  const invalid = await fetch(`${baseUrl}/api/mcp/servers/not-a-number`)
  assert.equal(invalid.status, 400)

  // The scan request itself is recorded as a tool run, like every mutation.
  const apiRuns = database.listToolRuns({ kind: 'api', limit: 200 })
  assert.ok(apiRuns.some((run) => run.label === 'POST /api/mcp/scan'))
})

test('the scan route fails soft when discovery fails or throws', async () => {
  const failing = createApp(database, {
    mcpDiscovery: () => Promise.resolve({ ok: false, servers: [], resources: [], error: 'service down' })
  }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    failing.once('listening', resolve)
    failing.once('error', reject)
  })
  try {
    const response = await fetch(`http://127.0.0.1:${failing.address().port}/api/mcp/scan`, { method: 'POST' })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, 'Could not scan MCP servers.')
    assert.equal(body.detail, 'service down')
  } finally {
    await new Promise((resolve) => failing.close(resolve))
  }

  const throwing = createApp(database, {
    mcpDiscovery: () => Promise.reject(new Error('CLI missing'))
  }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    throwing.once('listening', resolve)
    throwing.once('error', reject)
  })
  try {
    const response = await fetch(`http://127.0.0.1:${throwing.address().port}/api/mcp/scan`, { method: 'POST' })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, 'Could not scan MCP servers.')
  } finally {
    await new Promise((resolve) => throwing.close(resolve))
  }
})

test('the migration creates the mcp tables', () => {
  const connection = new Database(join(directory, 'mcp.sqlite'), { readonly: true })
  try {
    const serverColumns = connection.prepare('PRAGMA table_info(mcp_servers)').all().map((c) => c.name)
    const resourceColumns = connection.prepare('PRAGMA table_info(mcp_resources)').all().map((c) => c.name)
    assert.ok(serverColumns.includes('integration_id'))
    assert.ok(serverColumns.includes('status_error'))
    assert.ok(serverColumns.includes('last_seen_at'))
    assert.ok(resourceColumns.includes('server_id'))
    assert.ok(resourceColumns.includes('is_template'))
    assert.ok(resourceColumns.includes('first_seen_at'))
  } finally {
    connection.close()
  }
})

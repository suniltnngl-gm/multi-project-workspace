// Objective: Discover configured MCP servers and their resource catalogs through the opencode CLI.
// Requirements: Run bounded read-only subprocesses, never infer, and fail soft so the API stays up when the CLI or its background service is unavailable; run from the repository root so project-configured servers are visible.
// Decisions: GET /api/mcp and GET /api/mcp/resource are independent reads, so both run concurrently; JSON parsing is fail-soft and the result is ok only when both calls succeed, because a half-scanned catalog would misreport servers as vanished; templates map onto the resource shape with uri from uriTemplate and isTemplate set, so the store upserts one catalog.
// Relevant Files: apps/api/src/mcpDiscovery.js, apps/api/src/routes/mcp.js, scripts/scan-mcp.mjs, apps/api/test/mcpCatalog.test.js
// Important Context: User file. Discovery lists servers and resources only; it never invokes MCP tools.
// Work State: Completed: Added as task #37; Active: None; Blocked: None; Next Move: Maintain as needed.
import { execFile } from 'node:child_process'

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15000
const MAX_CATALOG_BUFFER_BYTES = 4 * 1024 * 1024

function runApiGet({ execFileImpl, command, path, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    execFileImpl(
      command,
      ['api', 'get', path],
      { timeout: timeoutMs, maxBuffer: MAX_CATALOG_BUFFER_BYTES, encoding: 'utf8', cwd },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message })
          return
        }
        try {
          resolve({ ok: true, body: JSON.parse(String(stdout ?? '')) })
        } catch (parseError) {
          resolve({ ok: false, error: `Could not parse ${path} output: ${parseError.message}` })
        }
      }
    )
  })
}

function normalizeServer(entry) {
  if (!entry || typeof entry !== 'object') return null
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (!name) return null
  const status = entry.status ?? {}
  return {
    name,
    title: typeof entry.title === 'string' ? entry.title : '',
    integrationId: typeof entry.integrationID === 'string' ? entry.integrationID : '',
    status: typeof status.status === 'string' ? status.status : '',
    ...(typeof status.error === 'string' && status.error ? { statusError: status.error } : {})
  }
}

function normalizeResource(entry, { isTemplate }) {
  if (!entry || typeof entry !== 'object') return null
  const server = typeof entry.server === 'string' ? entry.server.trim() : ''
  const rawUri = isTemplate ? entry.uriTemplate : entry.uri
  const uri = typeof rawUri === 'string' ? rawUri.trim() : ''
  if (!server || !uri) return null
  return {
    server,
    uri,
    name: typeof entry.name === 'string' ? entry.name : '',
    description: typeof entry.description === 'string' ? entry.description : '',
    mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : '',
    isTemplate
  }
}

/**
 * List the MCP servers and resources the local opencode CLI can see. Both
 * API reads run concurrently in bounded subprocesses and the result always
 * resolves: a missing or failing CLI reports ok:false instead of taking the
 * API down with it. cwd matters - the CLI scopes its answer to that
 * directory, so callers pass the repository root to see project-configured
 * servers.
 */
export function discoverMcpCatalog({
  execFileImpl = execFile,
  command = 'opencode',
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  cwd
} = {}) {
  return Promise.all([
    runApiGet({ execFileImpl, command, path: '/api/mcp', timeoutMs, cwd }),
    runApiGet({ execFileImpl, command, path: '/api/mcp/resource', timeoutMs, cwd })
  ]).then(([serversResult, catalogResult]) => {
    if (!serversResult.ok) {
      return { ok: false, servers: [], resources: [], error: serversResult.error }
    }
    if (!catalogResult.ok) {
      return { ok: false, servers: [], resources: [], error: catalogResult.error }
    }
    const rawServers = Array.isArray(serversResult.body?.data) ? serversResult.body.data : []
    const catalog = catalogResult.body?.data ?? {}
    const rawResources = Array.isArray(catalog.resources) ? catalog.resources : []
    const rawTemplates = Array.isArray(catalog.templates) ? catalog.templates : []
    const servers = rawServers.map(normalizeServer).filter(Boolean)
    const resources = [
      ...rawResources.map((entry) => normalizeResource(entry, { isTemplate: false })),
      ...rawTemplates.map((entry) => normalizeResource(entry, { isTemplate: true }))
    ].filter(Boolean)
    return { ok: true, servers, resources, error: null }
  })
}

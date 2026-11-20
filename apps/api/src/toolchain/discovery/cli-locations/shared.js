import { accessSync, constants, existsSync, lstatSync } from 'node:fs'

export const CLI_LOCATION_SCHEMA_VERSION = 'cli-location-manifest/v1.0'

function defaultAccessCheck(targetPath, mode) {
  try {
    accessSync(targetPath, mode)
    return true
  } catch {
    return false
  }
}

export function inspectLocation({
  path: targetPath,
  kind,
  source = 'environment_and_convention',
  scope = 'user',
  fileExists,
  lstat = lstatSync,
  canRead = (p) => defaultAccessCheck(p, constants.R_OK),
  canWrite = (p) => defaultAccessCheck(p, constants.W_OK)
}) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return {
      path: '',
      kind,
      exists: false,
      readable: false,
      writable: false,
      source,
      confidence: 'unknown',
      scope,
      status: 'unknown'
    }
  }

  let exists = false
  let status = 'not_found'
  let confidence = 'inferred'

  try {
    if (typeof fileExists === 'function') {
      exists = Boolean(fileExists(targetPath))
      status = exists ? 'verified' : 'not_found'
      confidence = exists ? 'verified' : 'inferred'
    } else {
      const stat = lstat(targetPath)
      if (stat.isSymbolicLink()) {
        if (!existsSync(targetPath)) {
          return {
            path: targetPath,
            kind,
            exists: false,
            readable: false,
            writable: false,
            source,
            confidence: 'verified',
            scope,
            status: 'inaccessible'
          }
        }
      }
      exists = true
      status = 'verified'
      confidence = 'verified'
    }
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      exists = false
      status = 'not_found'
      confidence = 'inferred'
    } else if (code === 'EACCES' || code === 'EPERM') {
      exists = false
      status = 'inaccessible'
      confidence = 'verified'
    } else {
      exists = false
      status = 'unknown'
      confidence = 'unknown'
    }
  }

  let readable = false
  let writable = false
  if (exists) {
    try {
      readable = Boolean(canRead(targetPath))
      writable = Boolean(canWrite(targetPath))
      status = readable ? 'verified' : 'inaccessible'
      confidence = 'verified'
    } catch {
      readable = false
      writable = false
      status = 'unknown'
      confidence = 'unknown'
    }
  }

  return {
    path: targetPath,
    kind,
    exists,
    readable,
    writable,
    source,
    confidence,
    scope,
    status
  }
}

export function createEmptyLocations() {
  return {
    config: [],
    skills: [],
    agents: [],
    plugins: [],
    mcp: [],
    sessions: [],
    artifacts: [],
    temp: [],
    cache: [],
    sandbox: []
  }
}

export function createCliManifest({
  cli,
  version = null,
  platform = process.platform,
  locations = createEmptyLocations(),
  method = 'environment_and_cli_metadata',
  observedAt
}) {
  const anyVerified = Object.values(locations).some((entries) =>
    entries.some((entry) => entry.status === 'verified')
  )
  return {
    cli,
    version,
    platform,
    locations,
    discovery: {
      method,
      verified: anyVerified,
      observedAt
    }
  }
}

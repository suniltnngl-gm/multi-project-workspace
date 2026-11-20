export const SESSION_CORRELATION_SCHEMA_VERSION = 'session-correlation/v1.0'

const VALID_CACHE_STATES = new Set(['warm_observed', 'cold_observed', 'unknown', 'invalidated_suspected'])

function pathsByStatus(entries = [], targetStatus) {
  return entries.filter((e) => e && e.status === targetStatus).map((e) => e.path)
}

export function correlateSessions({
  sessions = [],
  cliLocationManifest = null,
  now = () => Date.now()
} = {}) {
  const correlatedAt = typeof now === 'function' ? new Date(now()).toISOString() : new Date().toISOString()
  const cliMap = new Map((cliLocationManifest?.clis || []).map((entry) => [entry.cli, entry]))

  const correlations = sessions.map((session) => {
    const cli = String(session.cli || 'unknown')
    const sessionId = String(session.sessionId || '')
    const compositeKey = `${cli}:${sessionId}`
    const matched = cliMap.get(cli) || null
    const locs = matched?.locations || {}

    const verifiedArtifactDirs = pathsByStatus(locs.artifacts, 'verified')
    const verifiedSessionDirs = pathsByStatus(locs.sessions, 'verified')
    const verifiedTempDirs = pathsByStatus(locs.temp, 'verified')
    const verifiedSandboxDirs = pathsByStatus(locs.sandbox, 'verified')

    const candidateArtifactDirs = pathsByStatus(locs.artifacts, 'not_found')
    const candidateSessionDirs = pathsByStatus(locs.sessions, 'not_found')
    const inaccessiblePaths = [
      ...pathsByStatus(locs.artifacts, 'inaccessible'),
      ...pathsByStatus(locs.sessions, 'inaccessible'),
      ...pathsByStatus(locs.temp, 'inaccessible'),
      ...pathsByStatus(locs.sandbox, 'inaccessible')
    ]

    const cacheState = VALID_CACHE_STATES.has(session.cacheState) ? session.cacheState : 'unknown'
    const warnings = []
    if (!matched) warnings.push(`cli_not_in_manifest:${cli}`)
    if (matched && verifiedArtifactDirs.length === 0 && verifiedSessionDirs.length === 0) {
      warnings.push('no_verified_runtime_location')
    }
    if (inaccessiblePaths.length > 0) warnings.push('inaccessible_runtime_locations_present')
    if (cacheState === 'unknown') warnings.push('cache_state_unverified')

    return {
      compositeKey,
      name: String(session.name || compositeKey),
      cli,
      sessionId,
      role: String(session.role || 'unknown'),
      repository: session.repository ?? null,
      workItem: session.workItem ?? null,
      gateway: session.gateway ?? null,
      provider: session.provider ?? null,
      model: session.model ?? null,
      status: String(session.status || 'unknown'),
      cliMatched: Boolean(matched),
      observed: {
        cacheState,
        verifiedArtifactDirs,
        verifiedSessionDirs,
        verifiedTempDirs,
        verifiedSandboxDirs
      },
      inferred: {
        candidateArtifactDirs,
        candidateSessionDirs,
        inaccessiblePaths
      },
      warnings
    }
  })

  return {
    schemaVersion: SESSION_CORRELATION_SCHEMA_VERSION,
    mode: 'scan',
    readOnly: true,
    correlatedAt,
    correlations
  }
}

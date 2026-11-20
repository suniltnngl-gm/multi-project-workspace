export function checkCliEnvironment(cliEnvironmentInventory) {
  const checks = []
  if (!cliEnvironmentInventory) return checks
  const rec = 'Review permissions on the listed path; this doctor never modifies anything.'

  for (const entry of cliEnvironmentInventory.cliLocations?.clis || []) {
    for (const [kind, list] of Object.entries(entry.locations || {})) {
      for (const loc of Array.isArray(list) ? list : []) {
        if (loc?.status === 'inaccessible') {
          checks.push({
            level: 'warn',
            area: 'cli-location',
            message: `${entry.cli} ${kind} location is inaccessible: ${loc.path}`,
            recommendation: rec
          })
        }
      }
    }
  }

  for (const c of cliEnvironmentInventory.sessionCorrelations?.correlations || []) {
    if (c.cliMatched === false) {
      checks.push({
        level: 'warn',
        area: 'cli-session',
        message: `Session ${c.compositeKey} does not match any discovered CLI (${c.cli}).`,
        recommendation: 'Verify the CLI name or install/discover the CLI.'
      })
    }
    if ((c.warnings || []).includes('cache_state_unverified')) {
      checks.push({
        level: 'warn',
        area: 'cli-cache',
        message: `Cache state for session ${c.compositeKey} is unverified.`,
        recommendation: null
      })
    }
  }
  return checks
}

export function runToolchainDoctor(inventory, { cliEnvironmentInventory = null } = {}) {
  const checks = []

  const add = (level, area, message, recommendation = null) => {
    checks.push({ level, area, message, recommendation })
  }

  // 1. Broken symlinks across all discovered records
  const allRecords = [
    ...(inventory.shells?.detected || []),
    inventory.node?.active,
    inventory.node?.npm,
    ...(inventory.node?.companions || []),
    inventory.python?.active,
    inventory.python?.uv,
    inventory.python?.windowsPyLauncher,
    inventory.python?.pip,
    inventory.python?.pipx,
    ...Object.values(inventory.packageManagers || {}),
    ...(inventory.utilities || []),
    ...(inventory.aiClis || [])
  ].filter(Boolean)

  for (const rec of allRecords) {
    if (rec.brokenSymlink) {
      add(
        'error',
        'symlink',
        `${rec.name} points to a broken symlink: ${rec.brokenSymlinkPath}`,
        `Remove or repair the broken symlink at ${rec.brokenSymlinkPath}.`
      )
    }
  }

  // 2. Node.js & npm
  if (!inventory.node?.active?.available) {
    add('error', 'node', 'Node.js is not available on PATH.', 'Install Node.js via fnm, nvm, or winget and ensure it is on PATH.')
  } else {
    add('ok', 'node', `Node.js ${inventory.node.active.version || 'unknown'} active via ${inventory.node.active.installMethod} (${inventory.node.active.path}).`)
  }

  if (inventory.node?.npm?.globalBin && !inventory.node?.npm?.availableInCurrentShell) {
    add('warn', 'npm', `npm global bin (${inventory.node.npm.globalBin}) detected but npm is not active on PATH.`, `Add ${inventory.node.npm.globalBin} to PATH.`)
  }

  // 3. Python, uv, and .venv
  if (!inventory.python?.uv?.available) {
    add('warn', 'python', 'uv is not installed or not discovered.', 'Install uv to manage reproducible Python environments and uv.lock syncs.')
  } else if (!inventory.python.uv.availableInCurrentShell) {
    add('warn', 'python', `uv found at ${inventory.python.uv.path} but is not on PATH.`, 'Add the uv bin directory to PATH.')
  } else {
    add('ok', 'python', `uv ${inventory.python.uv.version || 'unknown'} available on PATH.`)
  }

  if (!inventory.python?.active?.available) {
    add('warn', 'python', 'No active Python interpreter found on PATH.', 'Install Python via uv (`uv python install`) or activate the project .venv.')
  } else {
    add('ok', 'python', `Python ${inventory.python.active.version || 'unknown'} (${inventory.python.active.pythonKind}) at ${inventory.python.active.path}.`)
  }

  if (inventory.python?.projectVenv?.detected && !inventory.python.activeVirtualEnv) {
    add(
      'warn',
      'venv',
      `Project .venv detected at ${inventory.python.projectVenv.root} but is not currently activated.`,
      'Activate .venv using the shell-specific activation command from `toolchain-plan.mjs`.'
    )
  }

  // 4. Core utilities
  const git = (inventory.utilities || []).find((u) => u.name === 'git')
  if (!git?.available) {
    add('error', 'utilities', 'git is not available on PATH.', 'Install Git (via apt on Ubuntu or winget on Windows 11).')
  }

  checks.push(...checkCliEnvironment(cliEnvironmentInventory))

  const summary = {
    ok: checks.filter((c) => c.level === 'ok').length,
    warn: checks.filter((c) => c.level === 'warn').length,
    error: checks.filter((c) => c.level === 'error').length
  }

  return {
    schemaVersion: 'toolchain-doctor/v1.0',
    mode: 'doctor',
    readOnly: true,
    healthy: summary.error === 0,
    summary,
    checks
  }
}

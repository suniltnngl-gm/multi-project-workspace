function isSafeSingleLine(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value)
}

function uniqueSafePaths(items) {
  return [...new Set(items.filter(isSafeSingleLine))]
}

export function quotePosixSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

export function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function isSafeCmdPath(value) {
  return isSafeSingleLine(value) && !/[%!^&|<>"]/.test(value)
}

export function formatDotEnvEntry(key, value) {
  if (!/^[A-Z0-9_]+$/.test(key) || !isSafeSingleLine(value)) return null
  if (/[\s#"'\\]/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `${key}="${escaped}"`
  }
  return `${key}=${value}`
}

export function generateToolchainPlan(inventory, envConfig = null) {
  const isWindows = Boolean(inventory.os?.isWindows)
  const pathAdditions = uniqueSafePaths([
    inventory.node?.npm?.globalBin,
    inventory.python?.uv?.installRoot ? (isWindows ? inventory.python.uv.installRoot : `${inventory.python.uv.installRoot}/bin`) : null
  ])

  const venvBash = isSafeSingleLine(inventory.python?.projectVenv?.activationScripts?.bash)
    ? inventory.python.projectVenv.activationScripts.bash
    : null
  const venvPs = isSafeSingleLine(inventory.python?.projectVenv?.activationScripts?.powershell)
    ? inventory.python.projectVenv.activationScripts.powershell
    : null
  const venvCmd = isSafeCmdPath(inventory.python?.projectVenv?.activationScripts?.cmd)
    ? inventory.python.projectVenv.activationScripts.cmd
    : null

  const bashLines = [
    '# MPW Toolchain Environment Plan (bash / git-bash — read-only proposal)',
    ...pathAdditions.map((dir) => {
      const q = quotePosixSingle(dir)
      return `case ":$PATH:" in *:${q}:*) ;; *) export PATH=${q}:"$PATH" ;; esac`
    }),
    ...(venvBash ? [`# Activate project .venv:\n# source ${quotePosixSingle(venvBash)}`] : [])
  ]

  const psLines = [
    '# MPW Toolchain Environment Plan (PowerShell 5.1 / PowerShell 7 — read-only proposal)',
    ...pathAdditions.map((dir) => {
      const q = quotePowerShellSingle(dir)
      return `if (($env:Path -split ';') -notcontains ${q}) { $env:Path = ${q} + ';' + $env:Path }`
    }),
    ...(venvPs ? [`# Activate project .venv:\n# & ${quotePowerShellSingle(venvPs)}`] : [])
  ]

  const safeCmdPaths = pathAdditions.filter(isSafeCmdPath)
  const cmdLines = [
    'REM MPW Toolchain Environment Plan (Windows CMD — read-only proposal)',
    ...safeCmdPaths.map((dir) => `set "PATH=${dir};%PATH%"`),
    ...(venvCmd ? [`REM Activate project .venv:\nREM call "${venvCmd}"`] : [])
  ]

  const dotenvEntries = Object.entries(envConfig?.values || {})
    .map(([key, value]) => formatDotEnvEntry(key, value))
    .filter(Boolean)

  const dotenvLines = [
    '# MPW Portable Toolchain .env Proposal (non-secret tool paths only)',
    ...dotenvEntries
  ]

  return {
    schemaVersion: 'toolchain-plan/v1.0',
    mode: 'plan',
    readOnly: true,
    applied: false,
    osFamily: inventory.os?.family || 'other',
    pathAdditions,
    snippets: {
      bash: bashLines.join('\n'),
      powershell5: psLines.join('\n'),
      pwsh7: psLines.join('\n'),
      cmd: cmdLines.join('\n'),
      dotenv: dotenvLines.join('\n')
    },
    reversibility: {
      mutatesProfile: false,
      note: 'Plan mode is strictly read-only. Review snippets before applying to any shell profile or .env.local.'
    }
  }
}

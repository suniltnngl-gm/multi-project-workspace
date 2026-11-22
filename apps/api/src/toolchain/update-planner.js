import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isWindowsPlatform } from './discovery/shared.js'

export const TOOLCHAIN_UPDATE_PLAN_SCHEMA_VERSION = 'toolchain-update-plan/v1.0'

export const TOOLCHAIN_UPDATE_CLI_PATH = fileURLToPath(
  new URL('../../../../scripts/toolchain-update.mjs', import.meta.url)
)

const AI_CLI_SPECS = [
  { name: 'agy', stepId: 'agy-update', bin: 'agy', args: ['update'] },
  { name: 'copilot', stepId: 'copilot-update', bin: 'copilot', args: ['update'] },
  { name: 'opencode', stepId: 'opencode-upgrade', bin: 'opencode', args: ['upgrade'] },
  { name: 'kilo', stepId: 'kilo-upgrade', bin: 'kilo', args: ['upgrade'] }
]

function findInventoryAiCli(inventory, name) {
  return Array.isArray(inventory?.aiClis)
    ? inventory.aiClis.find((record) => record?.name === name)
    : undefined
}

function managerBin(inventory, name) {
  const manager = inventory?.packageManagers?.[name]
  return manager && manager.available ? (manager.path || name) : null
}

function systemdSchedulerSnippet(cliScriptPath) {
  return [
    '# systemd --user weekly toolchain update planner',
    '# Install: copy both units into ~/.config/systemd/user/, then run:',
    '#   systemctl --user daemon-reload',
    '#   systemctl --user enable --now toolchain-update.timer',
    '',
    '# File: ~/.config/systemd/user/toolchain-update.service',
    '[Unit]',
    'Description=Weekly cross-platform toolchain update planner',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${process.execPath} ${cliScriptPath} --apply`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
    '# File: ~/.config/systemd/user/toolchain-update.timer',
    '[Unit]',
    'Description=Run the toolchain update planner weekly',
    '',
    '[Timer]',
    'OnCalendar=Sun *-*-* 04:00:00',
    'RandomizedDelaySec=15m',
    'Persistent=true',
    'Unit=toolchain-update.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    ''
  ].join('\n')
}

function schtasksSchedulerSnippet(cliScriptPath) {
  return [
    ':: Windows 11 weekly toolchain update planner (schtasks)',
    `schtasks /Create /TN "ToolchainWeeklyUpdate" /TR "\\"${process.execPath}\\" \\"${cliScriptPath}\\" --apply" /SC WEEKLY /D SUN /ST 04:00 /F`,
    ''
  ].join('\n')
}

export function buildToolchainUpdatePlan(inventory, options = {}) {
  const platform = inventory?.os?.platform ?? process.platform
  const win = isWindowsPlatform(platform)
  const steps = []

  const addStep = (id, tool, bin, args, reason) => {
    steps.push({ id, tool, bin, args, reason })
  }

  const uvBin = managerBin(inventory, 'uv')
  if (uvBin) {
    addStep('uv-self-update', 'uv', uvBin, ['self', 'update'], 'Update the uv runtime itself')
    addStep('uv-tool-upgrade-all', 'uv', uvBin, ['tool', 'upgrade', '--all'], 'Upgrade all uv-managed user tools')
  }

  const npmBin = managerBin(inventory, 'npm')
  if (npmBin) {
    addStep('npm-global-update', 'npm', npmBin, ['update', '-g'], 'Update globally installed npm packages')
  }

  if (win) {
    const wingetBin = managerBin(inventory, 'winget')
    if (wingetBin) {
      addStep(
        'winget-upgrade-all',
        'winget',
        wingetBin,
        ['upgrade', '--all', '--accept-source-agreements', '--accept-package-agreements'],
        'Upgrade all winget-installed applications'
      )
    }
  }

  for (const spec of AI_CLI_SPECS) {
    const record = findInventoryAiCli(inventory, spec.name)
    if (record?.available) {
      addStep(
        spec.stepId,
        spec.name,
        record.path || spec.bin,
        spec.args,
        `Self-update the ${spec.name} AI CLI`
      )
    }
  }

  const scheduler = win
    ? { kind: 'schtasks', snippet: schtasksSchedulerSnippet(TOOLCHAIN_UPDATE_CLI_PATH) }
    : platform === 'linux'
      ? { kind: 'systemd-user', snippet: systemdSchedulerSnippet(TOOLCHAIN_UPDATE_CLI_PATH) }
      : { kind: 'none', snippet: '' }

  void options

  return {
    schemaVersion: TOOLCHAIN_UPDATE_PLAN_SCHEMA_VERSION,
    platform,
    dryRun: true,
    steps,
    scheduler,
    cliArtifactBoundary: { mergeNativeArtifacts: false }
  }
}

async function defaultSpawn(bin, args) {
  return new Promise((resolve) => {
    let settled = false
    const resolveOutcome = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const child = spawn(bin, args, { shell: false })
    child.on('error', (error) =>
      resolveOutcome({ ok: false, exitCode: null, error: error.message })
    )
    child.on('close', (exitCode) =>
      resolveOutcome({ ok: exitCode === 0, exitCode })
    )
  })
}

export async function executeToolchainUpdatePlan(plan, { apply = false, spawnFn } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : []

  if (apply !== true) {
    return { executed: false, dryRun: Boolean(plan?.dryRun ?? true), results: [] }
  }

  const run = typeof spawnFn === 'function' ? spawnFn : defaultSpawn
  const results = []

  for (const step of steps) {
    let outcome
    try {
      outcome = await run(step.bin, step.args, { shell: false })
    } catch (error) {
      outcome = { ok: false, exitCode: null, error: String(error?.message || error) }
    }
    results.push({
      id: step.id,
      tool: step.tool,
      ok: Boolean(outcome?.ok),
      exitCode: outcome?.exitCode ?? null,
      error: outcome?.error ?? null
    })
  }

  return { executed: true, dryRun: false, results }
}

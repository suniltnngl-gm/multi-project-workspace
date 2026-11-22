import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildToolchainUpdatePlan,
  executeToolchainUpdatePlan,
  TOOLCHAIN_UPDATE_PLAN_SCHEMA_VERSION
} from '../../src/toolchain/update-planner.js'

const CLI_PATH = fileURLToPath(new URL('../../../../scripts/toolchain-update.mjs', import.meta.url))

test('Ubuntu fixture builds uv, npm, AI CLI update steps and systemd-user scheduler', () => {
  const plan = buildToolchainUpdatePlan({
    os: { platform: 'linux' },
    packageManagers: {
      uv: { available: true, path: '/home/user/.local/bin/uv' },
      npm: { available: true, path: '/home/user/.nvm/versions/node/v22/bin/npm' },
      winget: { available: false, path: null }
    },
    aiClis: [
      { name: 'agy', available: true, path: '/home/user/.local/bin/agy' },
      { name: 'copilot', available: true, path: '/home/user/.local/bin/copilot' },
      { name: 'opencode', available: true, path: '/home/user/.opencode/bin/opencode' }
    ]
  })

  assert.strictEqual(plan.schemaVersion, TOOLCHAIN_UPDATE_PLAN_SCHEMA_VERSION)
  assert.strictEqual(plan.platform, 'linux')
  assert.strictEqual(plan.dryRun, true)
  assert.strictEqual(plan.cliArtifactBoundary.mergeNativeArtifacts, false)
  assert.deepStrictEqual(
    plan.steps.map((s) => s.id),
    ['uv-self-update', 'uv-tool-upgrade-all', 'npm-global-update', 'agy-update', 'copilot-update', 'opencode-upgrade']
  )
  assert.strictEqual(plan.scheduler.kind, 'systemd-user')
  assert.match(plan.scheduler.snippet, /OnCalendar=Sun/)
})

test('Windows 11 fixture builds winget, uv, npm steps and schtasks scheduler', () => {
  const plan = buildToolchainUpdatePlan({
    os: { platform: 'win32' },
    packageManagers: {
      uv: { available: true, path: 'C:\\Users\\dev\\.local\\bin\\uv.exe' },
      npm: { available: true, path: 'C:\\Program Files\\nodejs\\npm.cmd' },
      winget: { available: true, path: 'C:\\Windows\\System32\\winget.exe' }
    },
    aiClis: []
  })

  assert.strictEqual(plan.platform, 'win32')
  assert.deepStrictEqual(
    plan.steps.map((s) => s.id),
    ['uv-self-update', 'uv-tool-upgrade-all', 'npm-global-update', 'winget-upgrade-all']
  )
  assert.strictEqual(plan.scheduler.kind, 'schtasks')
  assert.match(plan.scheduler.snippet, /schtasks \/Create/)
})

test('executeToolchainUpdatePlan fails closed when apply=false and runs sequentially when apply=true', async () => {
  const plan = buildToolchainUpdatePlan({
    os: { platform: 'linux' },
    packageManagers: {
      uv: { available: true, path: 'uv' },
      npm: { available: true, path: 'npm' }
    },
    aiClis: []
  })

  const calls = []
  const fakeSpawn = async (bin, args) => {
    calls.push([bin, ...args])
    return { ok: true, exitCode: 0 }
  }

  const dryRes = await executeToolchainUpdatePlan(plan, { apply: false, spawnFn: fakeSpawn })
  assert.strictEqual(dryRes.executed, false)
  assert.strictEqual(calls.length, 0)

  const applyRes = await executeToolchainUpdatePlan(plan, { apply: true, spawnFn: fakeSpawn })
  assert.strictEqual(applyRes.executed, true)
  assert.strictEqual(applyRes.results.length, 3)
  assert.ok(applyRes.results.every((r) => r.ok && r.exitCode === 0))
  assert.deepStrictEqual(calls, [
    ['uv', 'self', 'update'],
    ['uv', 'tool', 'upgrade', '--all'],
    ['npm', 'update', '-g']
  ])
})

test('scripts/toolchain-update.mjs --dry-run --json exits 0 with valid dry-run plan', () => {
  const out = execFileSync(process.execPath, [CLI_PATH, '--dry-run', '--json'], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  assert.strictEqual(parsed.schemaVersion, TOOLCHAIN_UPDATE_PLAN_SCHEMA_VERSION)
  assert.strictEqual(parsed.dryRun, true)
  assert.strictEqual(parsed.cliArtifactBoundary.mergeNativeArtifacts, false)
  assert.ok(Array.isArray(parsed.steps))
  assert.ok(parsed.scheduler && typeof parsed.scheduler.kind === 'string')
})

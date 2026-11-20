import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import { TOOLCHAIN_SCHEMA_VERSION, scanToolchain } from '../../src/toolchain/index.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schemaPath = resolve(repoRoot, 'apps/api/src/toolchain/schemas/toolchain-inventory.schema.json')
const inventorySchema = JSON.parse(readFileSync(schemaPath, 'utf8'))

test('toolchain inventory schema validator resolves $ref and schema-valued additionalProperties and rejects malformed nested records', () => {
  assert.equal(inventorySchema.properties.schemaVersion.const, TOOLCHAIN_SCHEMA_VERSION)
  assert.equal(inventorySchema.properties.mode.const, 'scan')
  assert.equal(inventorySchema.properties.readOnly.const, true)

  const malformedTop = { schemaVersion: TOOLCHAIN_SCHEMA_VERSION, mode: 'scan', readOnly: true }
  assert.ok(validateInventorySchema(malformedTop, inventorySchema).length > 0, 'malformed inventory must fail schema validation')

  const validBase = scanToolchain({
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/home/dev', PATH: '' },
    fileExists: () => false,
    isBrokenSymlink: () => false,
    readText: () => null,
    runCommand: () => ({ ok: false, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-11-20T00:00:00Z')
  })
  assertInventorySchema(validBase, inventorySchema, 'base inventory')

  const badNestedRef = structuredClone(validBase)
  badNestedRef.node.active = { name: 123, available: 'yes', unexpectedField: true }
  const refErrors = validateInventorySchema(badNestedRef, inventorySchema)
  assert.ok(refErrors.some((e) => e.includes('$.node.active')), 'malformed $ref toolRecord must be rejected')

  const badPkgMgr = structuredClone(validBase)
  badPkgMgr.packageManagers.apt = { name: 42 }
  const pkgErrors = validateInventorySchema(badPkgMgr, inventorySchema)
  assert.ok(pkgErrors.some((e) => e.includes('$.packageManagers.apt')), 'malformed schema-valued additionalProperties entry must be rejected')
})

test('Ubuntu fixture discovers fnm multishell, nvm, npm global prefix, uv-managed python, project .venv, utilities, and AI CLIs', () => {
  const existing = new Set([
    '/home/dev/.local/state/fnm_multishells/12345/bin/node',
    '/home/dev/.local/state/fnm_multishells/12345/bin/npm',
    '/home/dev/.local/bin/fnm',
    '/home/dev/.nvm/nvm.sh',
    '/home/dev/.npm-global',
    '/home/dev/.local/bin/uv',
    '/home/dev/.local/share/uv/python/cpython-3.12.8/bin/python3',
    '/workspace/proj/.venv/bin/python',
    '/workspace/proj/.venv/bin/activate',
    '/usr/bin/bash',
    '/usr/bin/apt-get',
    '/usr/bin/git',
    '/usr/bin/jq',
    '/home/dev/.local/bin/agy'
  ])

  const env = {
    HOME: '/home/dev',
    SHELL: '/usr/bin/bash',
    FNM_MULTISHELL_PATH: '/home/dev/.local/state/fnm_multishells/12345',
    FNM_DIR: '/home/dev/.local/share/fnm',
    NPM_CONFIG_PREFIX: '/home/dev/.npm-global',
    PATH: [
      '/home/dev/.local/state/fnm_multishells/12345/bin',
      '/home/dev/.local/share/uv/python/cpython-3.12.8/bin',
      '/home/dev/.local/bin',
      '/usr/bin'
    ].join(':')
  }

  const runCommand = (cmd, args) => {
    if (cmd.endsWith('/uv') && args[0] === 'python' && args[1] === 'find') {
      return { ok: true, stdout: '/home/dev/.local/share/uv/python/cpython-3.12.8/bin/python3', stderr: '' }
    }
    return { ok: true, stdout: `${cmd} 1.0.0`, stderr: '' }
  }

  const inv = scanToolchain({
    platform: 'linux',
    arch: 'x64',
    release: '6.8.0-generic',
    cwd: '/workspace/proj',
    env,
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: () => false,
    readText: () => 'PRETTY_NAME="Ubuntu 24.04 LTS"\n',
    runCommand,
    now: () => Date.parse('2026-11-20T00:00:00Z')
  })

  assertInventorySchema(inv, inventorySchema, 'Ubuntu toolchain inventory')
  assert.equal(inv.os.family, 'linux')
  assert.equal(inv.os.distro, 'Ubuntu 24.04 LTS')
  assert.equal(inv.os.isWsl, false)
  assert.equal(inv.node.active.installMethod, 'fnm')
  assert.equal(inv.node.active.managedBy, 'fnm')
  assert.equal(inv.node.managers.fnm.multishellActive, true)
  assert.equal(inv.node.managers.nvm.detected, true)
  assert.equal(inv.node.npm.globalBin, '/home/dev/.npm-global/bin')
  assert.equal(inv.python.active.pythonKind, 'uv-managed')
  assert.equal(inv.python.uvManagedPython.available, true)
  assert.equal(inv.python.uvManagedPython.installMethod, 'uv')
  assert.equal(inv.python.uvManagedPython.managedBy, 'uv')
  assert.equal(inv.python.projectVenv.detected, true)
  assert.equal(inv.python.projectVenv.activationScripts.bash, '/workspace/proj/.venv/bin/activate')
  assert.equal(inv.packageManagers.apt.available, true)
  assert.equal(inv.utilities.find((u) => u.name === 'git').available, true)
  assert.equal(inv.aiClis.find((c) => c.name === 'agy').available, true)
})

test('Windows 11 fixture discovers PS 5.1, pwsh 7, Git Bash, winget, py launcher, fnm, .venv Activate.ps1, and honest currentShell', () => {
  const existing = new Set([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\winget.exe',
    'C:\\Users\\dev\\AppData\\Local\\fnm_multishells\\999\\node.exe',
    'C:\\Users\\dev\\AppData\\Local\\fnm_multishells\\999\\npm.cmd',
    'C:\\Windows\\py.exe',
    'C:\\Proj\\.venv\\Scripts\\python.exe',
    'C:\\Proj\\.venv\\Scripts\\Activate.ps1',
    'C:\\Proj\\.venv\\Scripts\\activate.bat',
    'C:\\Users\\dev\\.local\\bin\\uv.exe'
  ])

  const env = {
    USERPROFILE: 'C:\\Users\\dev',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    PATHEXT: '.EXE;.CMD;.BAT',
    PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
    FNM_MULTISHELL_PATH: 'C:\\Users\\dev\\AppData\\Local\\fnm_multishells\\999',
    VIRTUAL_ENV: 'C:\\Proj\\.venv',
    PATH: [
      'C:\\Proj\\.venv\\Scripts',
      'C:\\Users\\dev\\AppData\\Local\\fnm_multishells\\999',
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links',
      'C:\\Program Files\\PowerShell\\7',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows'
    ].join(';')
  }

  const inv = scanToolchain({
    platform: 'win32',
    arch: 'x64',
    release: '10.0.22631',
    cwd: 'C:\\Proj',
    env,
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: () => false,
    runCommand: (cmd) => ({ ok: true, stdout: `${cmd} 2.0.0`, stderr: '' }),
    now: () => Date.parse('2026-11-20T00:00:00Z')
  })

  assertInventorySchema(inv, inventorySchema, 'Windows 11 toolchain inventory')
  assert.equal(inv.os.family, 'windows')
  assert.equal(inv.shells.currentShell, 'pwsh7')
  assert.equal(inv.shells.detected.find((s) => s.name === 'powershell5').available, true)
  assert.equal(inv.shells.detected.find((s) => s.name === 'pwsh7').available, true)
  assert.equal(inv.shells.detected.find((s) => s.name === 'git-bash').available, true)
  assert.equal(inv.node.active.installMethod, 'fnm')
  assert.equal(inv.python.active.pythonKind, 'active-venv')
  assert.equal(inv.python.windowsPyLauncher.available, true)
  assert.equal(inv.python.projectVenv.activationScripts.powershell, 'C:\\Proj\\.venv\\Scripts\\Activate.ps1')
  assert.equal(inv.packageManagers.winget.installMethod, 'winget')

  // Verify Windows currentShell returns powershell5, git-bash, and unknown honestly without artificial env vars
  const ps5Inv = scanToolchain({
    platform: 'win32',
    env: { PSModulePath: 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules', PATH: '' },
    fileExists: () => false,
    isBrokenSymlink: () => false,
    runCommand: () => ({ ok: false, stdout: '', stderr: '' })
  })
  assert.equal(ps5Inv.shells.currentShell, 'powershell5')

  const unknownInv = scanToolchain({
    platform: 'win32',
    env: { PATH: '' },
    fileExists: () => false,
    isBrokenSymlink: () => false,
    runCommand: () => ({ ok: false, stdout: '', stderr: '' })
  })
  assert.equal(unknownInv.shells.currentShell, 'unknown')
})

test('broken symlinks on PATH and uv python find system-interpreter fallback are classified accurately', () => {
  const existing = new Set(['/home/dev/.local/bin/uv', '/usr/bin/python3'])
  const broken = new Set(['/home/dev/.local/bin/jq', '/home/dev/.local/bin/node', '/home/dev/.local/bin/agy'])

  const inv = scanToolchain({
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/home/dev', PATH: '/home/dev/.local/bin:/usr/bin' },
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: (p) => broken.has(p),
    readText: () => null,
    runCommand: (cmd, args) => {
      if (cmd.endsWith('/uv') && args[0] === 'python' && args[1] === 'find') {
        return { ok: true, stdout: '/usr/bin/python3', stderr: '' }
      }
      return { ok: true, stdout: '1.0.0', stderr: '' }
    },
    now: () => Date.parse('2026-11-20T00:00:00Z')
  })

  assertInventorySchema(inv, inventorySchema, 'Broken-symlink & uv fallback inventory')
  const jq = inv.utilities.find((u) => u.name === 'jq')
  assert.equal(jq.available, false)
  assert.equal(jq.brokenSymlink, true)
  assert.equal(jq.brokenSymlinkPath, '/home/dev/.local/bin/jq')
  assert.equal(jq.installMethod, 'broken-symlink')
  assert.equal(inv.node.active.brokenSymlink, true)
  assert.equal(inv.node.active.brokenSymlinkPath, '/home/dev/.local/bin/node')
  assert.equal(inv.aiClis.find((c) => c.name === 'agy').brokenSymlink, true)

  // System Python returned by `uv python find` must NOT be attributed to uv management
  assert.equal(inv.python.uvManagedPython.path, '/usr/bin/python3')
  assert.equal(inv.python.uvManagedPython.installMethod, 'system-package')
  assert.equal(inv.python.uvManagedPython.managedBy, null)
  assert.equal(inv.python.uvManagedPython.pythonKind, 'system')
})

test('scripts/toolchain-scan.mjs --json emits valid read-only inventory JSON matching schema', () => {
  const stdout = execFileSync(process.execPath, [resolve(repoRoot, 'scripts/toolchain-scan.mjs'), '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const parsed = JSON.parse(stdout)
  assertInventorySchema(parsed, inventorySchema, 'Live CLI toolchain inventory')
})

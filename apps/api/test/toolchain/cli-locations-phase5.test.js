import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertInventorySchema, validateInventorySchema } from '../../src/toolchain/schemas/validator.js'
import { CLI_LOCATION_SCHEMA_VERSION, discoverCliLocations } from '../../src/toolchain/discovery/cli-locations/index.js'
import { inspectLocation } from '../../src/toolchain/discovery/cli-locations/shared.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const schemaPath = resolve(repoRoot, 'apps/api/src/toolchain/schemas/cli-location-manifest.schema.json')
const manifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'))

test('Ubuntu fixture discovers AGY, Claude, and Codex locations with verified/not_found/inaccessible statuses and passes schema', () => {
  const existing = new Set([
    '/home/dev/.gemini/config',
    '/home/dev/.gemini/config/skills',
    '/home/dev/.gemini/antigravity-cli/brain',
    '/home/dev/.claude',
    '/home/dev/.codex/sessions'
  ])
  const readable = new Set([
    '/home/dev/.gemini/config',
    '/home/dev/.gemini/config/skills',
    '/home/dev/.gemini/antigravity-cli/brain',
    '/home/dev/.codex/sessions'
  ])

  const manifest = discoverCliLocations({
    platform: 'linux',
    cwd: '/workspace/proj',
    env: { HOME: '/home/dev' },
    fileExists: (p) => existing.has(p),
    canRead: (p) => readable.has(p),
    canWrite: () => false,
    now: () => Date.parse('2026-11-20T13:50:00Z')
  })

  assert.equal(manifest.schemaVersion, CLI_LOCATION_SCHEMA_VERSION)
  assert.equal(manifest.readOnly, true)
  assertInventorySchema(manifest, manifestSchema, 'Ubuntu CLI location manifest')

  const agy = manifest.clis.find((c) => c.cli === 'agy')
  assert.equal(agy.discovery.verified, true)
  assert.equal(agy.locations.skills[0].status, 'verified')
  assert.equal(agy.locations.artifacts[0].status, 'verified')

  const claude = manifest.clis.find((c) => c.cli === 'claude')
  assert.equal(claude.locations.config[0].exists, true)
  assert.equal(claude.locations.config[0].status, 'inaccessible')

  const codex = manifest.clis.find((c) => c.cli === 'codex')
  assert.equal(codex.locations.sessions[0].status, 'verified')
  assert.equal(codex.locations.skills[0].status, 'not_found')
})

test('Windows 11 fixture resolves USERPROFILE and custom CODEX_HOME/CLAUDE_CONFIG_DIR cleanly', () => {
  const existing = new Set([
    'C:\\Users\\dev\\.gemini\\config\\skills',
    'C:\\CustomClaude\\commands',
    'C:\\CustomCodex\\skills'
  ])

  const manifest = discoverCliLocations({
    platform: 'win32',
    cwd: 'C:\\Proj',
    env: {
      USERPROFILE: 'C:\\Users\\dev',
      CLAUDE_CONFIG_DIR: 'C:\\CustomClaude',
      CODEX_HOME: 'C:\\CustomCodex'
    },
    fileExists: (p) => existing.has(p),
    canRead: (p) => existing.has(p),
    canWrite: () => true,
    now: () => Date.parse('2026-11-20T13:50:00Z')
  })

  assertInventorySchema(manifest, manifestSchema, 'Windows 11 CLI location manifest')
  assert.equal(manifest.clis.find((c) => c.cli === 'agy').locations.skills[0].path, 'C:\\Users\\dev\\.gemini\\config\\skills')
  assert.equal(manifest.clis.find((c) => c.cli === 'claude').locations.skills[0].path, 'C:\\CustomClaude\\commands')
  assert.equal(manifest.clis.find((c) => c.cli === 'codex').locations.skills[0].path, 'C:\\CustomCodex\\skills')

  // Negative schema test
  const bad = { ...manifest, clis: [{ cli: 123 }] }
  assert.ok(validateInventorySchema(bad, manifestSchema).length > 0)
})

test('inspectLocation handles unknown, EACCES, ELOOP, and real temp-dir verified/not_found/broken-symlink cases', () => {
  // Empty path -> unknown
  const empty = inspectLocation({ path: '', kind: 'config' })
  assert.equal(empty.status, 'unknown')
  assert.equal(empty.confidence, 'unknown')

  // EACCES -> inaccessible
  const eacces = inspectLocation({
    path: '/restricted/path',
    kind: 'config',
    lstat: () => {
      const err = new Error('permission denied')
      err.code = 'EACCES'
      throw err
    }
  })
  assert.equal(eacces.status, 'inaccessible')

  // ELOOP / unexpected error -> unknown
  const eloop = inspectLocation({
    path: '/loop/path',
    kind: 'skills',
    lstat: () => {
      const err = new Error('symlink loop')
      err.code = 'ELOOP'
      throw err
    }
  })
  assert.equal(eloop.status, 'unknown')

  // Real temporary directory: verified dir, missing path, and broken symlink
  const dir = mkdtempSync(join(tmpdir(), 'cli-loc-p5-'))
  try {
    const realSkills = join(dir, 'skills')
    mkdirSync(realSkills)
    const brokenLink = join(dir, 'broken-skills')
    symlinkSync(join(dir, 'does-not-exist'), brokenLink)

    const okLoc = inspectLocation({ path: realSkills, kind: 'skills' })
    assert.equal(okLoc.status, 'verified')
    assert.equal(okLoc.exists, true)
    assert.equal(okLoc.readable, true)

    const missingLoc = inspectLocation({ path: join(dir, 'missing'), kind: 'skills' })
    assert.equal(missingLoc.status, 'not_found')
    assert.equal(missingLoc.exists, false)

    const brokenLoc = inspectLocation({ path: brokenLink, kind: 'skills' })
    assert.equal(brokenLoc.status, 'inaccessible')
    assert.equal(brokenLoc.exists, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P5.3 OpenCode, Hermes, and Copilot adapters resolve Linux and Windows paths and pass schema', () => {
  const linuxExisting = new Set([
    '/home/dev/.config/opencode',
    '/home/dev/.config/opencode/opencode.json',
    '/home/dev/.hermes/config.yaml',
    '/home/dev/.hermes/hermes-agent',
    '/home/dev/.copilot',
    '/workspace/proj/.github/copilot-instructions.md'
  ])
  const linuxManifest = discoverCliLocations({
    platform: 'linux',
    cwd: '/workspace/proj',
    env: { HOME: '/home/dev' },
    fileExists: (p) => linuxExisting.has(p),
    canRead: (p) => linuxExisting.has(p),
    canWrite: () => false,
    now: () => Date.parse('2026-11-20T14:10:00Z')
  })
  assertInventorySchema(linuxManifest, manifestSchema, 'Linux P5.3 manifest')
  assert.equal(linuxManifest.clis.find((c) => c.cli === 'opencode').locations.mcp[0].status, 'verified')
  assert.equal(linuxManifest.clis.find((c) => c.cli === 'hermes').locations.config[0].status, 'verified')
  assert.equal(linuxManifest.clis.find((c) => c.cli === 'copilot').locations.skills[1].status, 'verified')

  const winExisting = new Set([
    'C:\\Users\\dev\\AppData\\Roaming\\opencode',
    'C:\\Users\\dev\\.hermes\\config.yaml',
    'C:\\Users\\dev\\AppData\\Roaming\\GitHub CLI'
  ])
  const winManifest = discoverCliLocations({
    platform: 'win32',
    cwd: 'C:\\Proj',
    env: {
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'
    },
    fileExists: (p) => winExisting.has(p),
    canRead: (p) => winExisting.has(p),
    canWrite: () => true,
    now: () => Date.parse('2026-11-20T14:10:00Z')
  })
  assertInventorySchema(winManifest, manifestSchema, 'Windows P5.3 manifest')
  assert.equal(winManifest.clis.find((c) => c.cli === 'opencode').locations.config[0].status, 'verified')
  assert.equal(winManifest.clis.find((c) => c.cli === 'hermes').locations.config[0].status, 'verified')
  assert.equal(winManifest.clis.find((c) => c.cli === 'copilot').locations.config[1].status, 'verified')
})

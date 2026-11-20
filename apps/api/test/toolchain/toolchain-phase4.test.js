import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { findExecutable, resolvePythonCommand, resolveToolchainExecutable } from '../../src/executables.js'
import { createToolsRouter } from '../../src/routes/tools.js'
import { checkToolchainHealth } from '../../../../scripts/ai-doctor-checks.mjs'

test('findExecutable and resolvePythonCommand remain 100% backward-compatible', () => {
  const files = new Set(['/usr/bin/python3', '/usr/bin/git'])
  const opts = { env: { PATH: '/usr/bin' }, platform: 'linux', fileExists: (p) => files.has(p) }
  assert.equal(findExecutable('git', opts), '/usr/bin/git')
  assert.equal(findExecutable('missing-bin', opts), null)
  assert.equal(resolvePythonCommand(opts), 'python3')
})

test('resolveToolchainExecutable honors .env/process.env overrides and detects broken symlinks', () => {
  const existing = new Set(['/custom/uv', '/usr/bin/git'])
  const broken = new Set(['/usr/bin/jq'])

  const fromEnv = resolveToolchainExecutable('uv', {
    cwd: '/proj',
    env: { UV_BIN: '/custom/uv', PATH: '/usr/bin' },
    platform: 'linux',
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: (p) => broken.has(p),
    readText: () => null
  })
  assert.equal(fromEnv.path, '/custom/uv')
  assert.equal(fromEnv.source, 'process.env')
  assert.equal(fromEnv.brokenSymlink, false)

  const brokenRes = resolveToolchainExecutable('jq', {
    cwd: '/proj',
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: (p) => broken.has(p),
    readText: () => null
  })
  assert.equal(brokenRes.path, null)
  assert.equal(brokenRes.brokenSymlink, true)
  assert.equal(brokenRes.brokenSymlinkPath, '/usr/bin/jq')
  assert.equal(brokenRes.source, 'broken-symlink')
})

test('checkToolchainHealth returns doctor checks compatible with AI Doctor', () => {
  const checks = checkToolchainHealth({
    platform: 'linux',
    env: { HOME: '/home/empty', PATH: '' },
    fileExists: () => false,
    isBrokenSymlink: () => false,
    readText: () => null,
    runCommand: () => ({ ok: false, stdout: '', stderr: '' })
  })
  assert.ok(Array.isArray(checks) && checks.length > 0)
  assert.ok(checks.some((c) => c.area === 'node' && c.level === 'error'))
  assert.ok(checks.every((c) => typeof c.level === 'string' && typeof c.area === 'string' && typeof c.message === 'string'))
})

test('GET /api/tools/toolchain returns read-only inventory and doctor report without breaking /api/tools', async () => {
  const app = express()
  const fakeDb = { listTools: () => [{ name: 'git', available: true }] }
  app.use(createToolsRouter({ database: fakeDb }))

  const server = app.listen(0)
  try {
    const { port } = server.address()
    const listRes = await fetch(`http://127.0.0.1:${port}/api/tools`)
    assert.equal(listRes.status, 200)
    const listJson = await listRes.json()
    assert.deepEqual(listJson, [{ name: 'git', available: true }])

    const tcRes = await fetch(`http://127.0.0.1:${port}/api/tools/toolchain`)
    assert.equal(tcRes.status, 200)
    const tcJson = await tcRes.json()
    assert.equal(tcJson.inventory.mode, 'scan')
    assert.equal(tcJson.inventory.readOnly, true)
    assert.equal(tcJson.doctor.mode, 'doctor')
    assert.equal(tcJson.doctor.readOnly, true)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})

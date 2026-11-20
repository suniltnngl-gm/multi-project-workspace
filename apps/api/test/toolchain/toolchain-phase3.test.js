import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  applyToolchainConfig,
  managedMarkersFor,
  restoreToolchainConfig
} from '../../src/toolchain/configuration/configure-apply.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

test('applyToolchainConfig fails closed by default (dryRun/unauthorized) and never mutates target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cfg-'))
  try {
    const target = join(dir, '.bashrc')
    writeFileSync(target, 'export USER_LINE=1\n', 'utf8')

    const res1 = applyToolchainConfig({ targetPath: target, content: 'export PATH="/bin:$PATH"' })
    assert.equal(res1.applied, false)
    assert.equal(res1.dryRun, true)
    assert.equal(readFileSync(target, 'utf8'), 'export USER_LINE=1\n')

    const res2 = applyToolchainConfig({ targetPath: target, content: 'export PATH="/bin:$PATH"', dryRun: false, authorize: false })
    assert.equal(res2.applied, false)
    assert.equal(res2.reason, 'authorization_required')
    assert.equal(readFileSync(target, 'utf8'), 'export USER_LINE=1\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyToolchainConfig is idempotent, preserves user lines, creates backup, and restoreToolchainConfig restores exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cfg-'))
  try {
    const target = join(dir, '.bashrc')
    const original = '# user profile\nexport FOO=bar\n'
    writeFileSync(target, original, 'utf8')

    const first = applyToolchainConfig({
      targetPath: target,
      content: 'export PATH="/opt/bin:$PATH"',
      dryRun: false,
      authorize: true,
      timestamp: () => '2026-11-20T00-00-00Z'
    })
    assert.equal(first.applied, true)
    assert.equal(first.changed, true)
    assert.ok(first.backupPath && existsSync(first.backupPath))
    const afterFirst = readFileSync(target, 'utf8')
    assert.ok(afterFirst.includes('export FOO=bar'))
    assert.ok(afterFirst.includes(MANAGED_BLOCK_START))
    assert.ok(afterFirst.includes(MANAGED_BLOCK_END))

    // Second identical apply must be a no-op (idempotent)
    const second = applyToolchainConfig({
      targetPath: target,
      content: 'export PATH="/opt/bin:$PATH"',
      dryRun: false,
      authorize: true
    })
    assert.equal(second.applied, false)
    assert.equal(second.changed, false)
    assert.equal(readFileSync(target, 'utf8'), afterFirst)

    // Restore from backup must recover original bytes identically
    const restored = restoreToolchainConfig({
      targetPath: target,
      backupPath: first.backupPath,
      authorize: true
    })
    assert.equal(restored.restored, true)
    assert.equal(restored.sha256Restored, first.sha256Before)
    assert.equal(readFileSync(target, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyToolchainConfig rejects leaf and ancestor symlinks and uses collision-safe backups + CMD REM markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cfg-sym-'))
  try {
    const realFile = join(dir, 'real.env')
    const linkFile = join(dir, 'link.env')
    writeFileSync(realFile, 'A=1\n', 'utf8')
    symlinkSync(realFile, linkFile)

    assert.throws(
      () => applyToolchainConfig({ targetPath: linkFile, content: 'UV_BIN=/bin/uv', dryRun: false, authorize: true }),
      /TOOLCHAIN_CONFIGURE_SYMLINK_REJECTED/
    )

    // Ancestor symlink rejection (symlinked parent directory)
    const realParent = join(dir, 'real-parent')
    const linkParent = join(dir, 'link-parent')
    mkdirSync(realParent)
    symlinkSync(realParent, linkParent)
    assert.throws(
      () => applyToolchainConfig({ targetPath: join(linkParent, '.bashrc'), content: 'export A=1', dryRun: false, authorize: true }),
      /TOOLCHAIN_CONFIGURE_SYMLINK_REJECTED/
    )

    // CMD shell uses REM markers (never # markers) and collision-safe backups even with identical timestamps
    const batFile = join(dir, 'env.bat')
    writeFileSync(batFile, '@echo off\r\n', 'utf8')
    const first = applyToolchainConfig({
      targetPath: batFile,
      content: 'set "PATH=C:\\safe\\uv;%PATH%"',
      shell: 'cmd',
      dryRun: false,
      authorize: true,
      timestamp: () => 'fixed-ts'
    })
    const batText = readFileSync(batFile, 'utf8')
    const cmdMarkers = managedMarkersFor('cmd')
    assert.ok(batText.includes(cmdMarkers.start))
    assert.ok(batText.includes(cmdMarkers.end))
    assert.equal(batText.includes('# >>>'), false)
    assert.equal(/[<>]/.test(cmdMarkers.start), false, 'CMD start marker must not contain < or >')
    assert.equal(/[<>]/.test(cmdMarkers.end), false, 'CMD end marker must not contain < or >')

    // Symlinked backupDir must be rejected
    assert.throws(
      () => applyToolchainConfig({
        targetPath: batFile,
        content: 'set "PATH=C:\\safe\\uv3;%PATH%"',
        shell: 'cmd',
        dryRun: false,
        authorize: true,
        backupDir: linkParent
      }),
      /TOOLCHAIN_CONFIGURE_SYMLINK_REJECTED/
    )

    // Dangling symlink backupPath in restoreToolchainConfig must be rejected as symlink (not BACKUP_NOT_FOUND)
    const danglingBackup = join(dir, 'dangling.bak')
    symlinkSync(join(dir, 'does-not-exist.bak'), danglingBackup)
    assert.throws(
      () => restoreToolchainConfig({ targetPath: batFile, backupPath: danglingBackup, authorize: true }),
      /TOOLCHAIN_CONFIGURE_SYMLINK_REJECTED/
    )

    const second = applyToolchainConfig({
      targetPath: batFile,
      content: 'set "PATH=C:\\safe\\uv2;%PATH%"',
      shell: 'cmd',
      dryRun: false,
      authorize: true,
      timestamp: () => 'fixed-ts'
    })
    assert.notEqual(second.backupPath, first.backupPath)
    assert.equal(existsSync(first.backupPath), true)
    assert.equal(existsSync(second.backupPath), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scripts/toolchain-configure.mjs defaults to dry-run and applies only with --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cli-'))
  try {
    const target = join(dir, '.env.toolchain')
    const dryOut = execFileSync(process.execPath, [
      resolve(repoRoot, 'scripts/toolchain-configure.mjs'),
      '--target', target,
      '--shell', 'dotenv',
      '--json'
    ], { cwd: repoRoot, encoding: 'utf8' })
    const dryRes = JSON.parse(dryOut)
    assert.equal(dryRes.dryRun, true)
    assert.equal(dryRes.applied, false)
    assert.equal(existsSync(target), false)

    const applyOut = execFileSync(process.execPath, [
      resolve(repoRoot, 'scripts/toolchain-configure.mjs'),
      '--target', target,
      '--shell', 'dotenv',
      '--apply',
      '--json'
    ], { cwd: repoRoot, encoding: 'utf8' })
    const applyRes = JSON.parse(applyOut)
    assert.equal(applyRes.dryRun, false)
    assert.equal(applyRes.applied, true)
    assert.equal(existsSync(target), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

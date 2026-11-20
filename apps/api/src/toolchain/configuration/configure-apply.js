import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MANAGED_BLOCK_START = '# >>> mpw-toolchain-managed >>>'
export const MANAGED_BLOCK_END = '# <<< mpw-toolchain-managed <<<'

export function managedMarkersFor(shell = 'bash') {
  if (String(shell || 'bash').toLowerCase() === 'cmd') {
    return {
      start: 'REM --- mpw-toolchain-managed START ---',
      end: 'REM --- mpw-toolchain-managed END ---'
    }
  }
  return {
    start: MANAGED_BLOCK_START,
    end: MANAGED_BLOCK_END
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function assertNoSymlinkInPath(targetPath) {
  const resolved = path.resolve(targetPath)
  const parsed = path.parse(resolved)
  const relative = resolved.slice(parsed.root.length)
  const parts = relative.split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        break
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`TOOLCHAIN_CONFIGURE_SYMLINK_REJECTED:${current}`)
    }
  }
}

function writeExclusiveAtomic(targetPath, content, prefix = 'mpw-tmp') {
  const parentDir = path.dirname(targetPath)
  assertNoSymlinkInPath(parentDir)
  mkdirSync(parentDir, { recursive: true })
  assertNoSymlinkInPath(targetPath)
  const nonce = randomBytes(8).toString('hex')
  const tempPath = path.join(parentDir, `.${path.basename(targetPath)}.${prefix}-${process.pid}-${nonce}`)
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(tempPath, targetPath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore cleanup error if temp file was never created or already renamed
    }
    throw error
  }
}

function writeExclusiveBackup(backupDir, baseName, stamp, content) {
  assertNoSymlinkInPath(backupDir)
  mkdirSync(backupDir, { recursive: true })
  const nonce = randomBytes(8).toString('hex')
  const backupPath = path.join(backupDir, `${baseName}.mpw-backup-${stamp}-${nonce}`)
  assertNoSymlinkInPath(backupPath)
  writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' })
  return backupPath
}

export function upsertManagedBlock(existingContent, blockBody, { shell = 'bash' } = {}) {
  const { start, end } = managedMarkersFor(shell)
  const normalizedBody = String(blockBody || '').replace(/\r\n/g, '\n').trimEnd()
  const managed = `${start}\n${normalizedBody}\n${end}`
  const existing = String(existingContent || '').replace(/\r\n/g, '\n')

  const startIdx = existing.indexOf(start)
  const endIdx = existing.indexOf(end)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + end.length)
    return `${before}${managed}${after}`
  }

  if (existing.length === 0) {
    return `${managed}\n`
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${managed}\n`
}

export function applyToolchainConfig({
  targetPath,
  content,
  shell = 'bash',
  dryRun = true,
  authorize = false,
  backupDir = null,
  timestamp = () => new Date().toISOString().replace(/[:.]/g, '-')
} = {}) {
  if (!targetPath || typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    throw new Error('TOOLCHAIN_CONFIGURE_ABSOLUTE_TARGET_REQUIRED')
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('TOOLCHAIN_CONFIGURE_EMPTY_CONTENT')
  }

  const resolvedTarget = path.resolve(targetPath)
  assertNoSymlinkInPath(resolvedTarget)
  if (backupDir) {
    assertNoSymlinkInPath(path.resolve(backupDir))
  }

  const existed = existsSync(resolvedTarget)
  const beforeContent = existed ? readFileSync(resolvedTarget, 'utf8') : ''
  const afterContent = upsertManagedBlock(beforeContent, content, { shell })
  const changed = beforeContent !== afterContent
  const sha256Before = existed ? sha256(beforeContent) : null
  const sha256After = sha256(afterContent)

  if (dryRun || !authorize) {
    return {
      schemaVersion: 'toolchain-configure/v1.0',
      mode: 'configure',
      shell,
      dryRun: true,
      applied: false,
      changed,
      targetPath: resolvedTarget,
      backupPath: null,
      sha256Before,
      sha256After,
      reason: !authorize ? 'authorization_required' : 'dry_run'
    }
  }

  let backupPath = null
  if (existed && changed) {
    const stamp = timestamp()
    const baseName = path.basename(resolvedTarget)
    const targetBackupDir = backupDir ? path.resolve(backupDir) : path.dirname(resolvedTarget)
    backupPath = writeExclusiveBackup(targetBackupDir, baseName, stamp, beforeContent)
  }

  if (changed) {
    writeExclusiveAtomic(resolvedTarget, afterContent, 'mpw-tmp')
  }

  return {
    schemaVersion: 'toolchain-configure/v1.0',
    mode: 'configure',
    shell,
    dryRun: false,
    applied: changed,
    changed,
    targetPath: resolvedTarget,
    backupPath,
    sha256Before,
    sha256After
  }
}

export function restoreToolchainConfig({
  targetPath,
  backupPath,
  authorize = false
} = {}) {
  if (!authorize) {
    throw new Error('TOOLCHAIN_RESTORE_AUTHORIZATION_REQUIRED')
  }
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error('TOOLCHAIN_RESTORE_ABSOLUTE_TARGET_REQUIRED')
  }
  if (!backupPath || !path.isAbsolute(backupPath)) {
    throw new Error(`TOOLCHAIN_RESTORE_BACKUP_NOT_FOUND:${backupPath || ''}`)
  }

  const resolvedTarget = path.resolve(targetPath)
  const resolvedBackup = path.resolve(backupPath)
  assertNoSymlinkInPath(resolvedTarget)
  assertNoSymlinkInPath(resolvedBackup)

  if (!existsSync(resolvedBackup)) {
    throw new Error(`TOOLCHAIN_RESTORE_BACKUP_NOT_FOUND:${resolvedBackup}`)
  }

  const backupContent = readFileSync(resolvedBackup, 'utf8')
  writeExclusiveAtomic(resolvedTarget, backupContent, 'mpw-restore')

  return {
    schemaVersion: 'toolchain-configure/v1.0',
    mode: 'restore',
    restored: true,
    targetPath: resolvedTarget,
    backupPath: resolvedBackup,
    sha256Restored: sha256(backupContent)
  }
}

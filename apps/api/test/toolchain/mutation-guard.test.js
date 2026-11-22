import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyMutationRisk,
  createRecoveryBackup,
  restoreRecoveryBackup,
  protectedWriteFile,
  undoLastEdit
} from '../../src/toolchain/dispatch/mutation-guard.js'

test('classifyMutationRisk blocks unrecoverable mutations and allows recoverable commands', () => {
  for (const bad of [
    'git push --force origin master',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'rm -rf /home/sunilkr/Code',
    'DROP TABLE sessions;',
    'gcloud projects delete my-prod-proj'
  ]) {
    const res = classifyMutationRisk(bad)
    assert.strictEqual(res.allowed, false, `Expected blocked: ${bad}`)
    assert.strictEqual(res.risk, 'unrecoverable')
  }

  for (const ok of [
    'git status --short',
    'git push origin master',
    'node scripts/swarm-discover.mjs --dry-run'
  ]) {
    const res = classifyMutationRisk(ok)
    assert.strictEqual(res.allowed, true, `Expected allowed: ${ok}`)
    assert.strictEqual(res.risk, 'recoverable')
  }
})

test('createRecoveryBackup & restoreRecoveryBackup recover exact state and fail closed on checksum mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-guard-'))
  try {
    const target = join(dir, 'swarm-sessions.json')
    const original = JSON.stringify({ version: '1.9', sessions: ['s1'] })
    writeFileSync(target, original, 'utf8')

    const bak = createRecoveryBackup(target, { backupDir: join(dir, 'backups') })
    assert.strictEqual(bak.ok, true)

    // Simulate bad mutation
    writeFileSync(target, '{"corrupted":true}', 'utf8')
    const restored = restoreRecoveryBackup(bak.backupPath, target)
    assert.strictEqual(restored.ok, true)
    assert.strictEqual(readFileSync(target, 'utf8'), original)

    // Regression: corrupted backup must fail closed without touching target
    writeFileSync(bak.backupPath, 'TAMPERED', 'utf8')
    assert.throws(() => restoreRecoveryBackup(bak.backupPath, target), /backup_checksum_mismatch/)
    assert.strictEqual(readFileSync(target, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protectedWriteFile & undoLastEdit roll back ONLY the last edit on one file without touching other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-file-undo-'))
  try {
    const fileA = join(dir, 'a.txt')
    const fileB = join(dir, 'b.txt')
    const bdir = join(dir, '.backups')
    writeFileSync(fileA, 'v1', 'utf8')
    writeFileSync(fileB, 'b1', 'utf8')

    protectedWriteFile(fileA, 'v2-passing', { backupDir: bdir })
    protectedWriteFile(fileB, 'b2-passing', { backupDir: bdir })
    protectedWriteFile(fileA, 'v3-regression', { backupDir: bdir })

    // Undo only the last edit on fileA -> must return to v2-passing, leaving fileB at b2-passing
    undoLastEdit(fileA, { backupDir: bdir })
    assert.strictEqual(readFileSync(fileA, 'utf8'), 'v2-passing')
    assert.strictEqual(readFileSync(fileB, 'utf8'), 'b2-passing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

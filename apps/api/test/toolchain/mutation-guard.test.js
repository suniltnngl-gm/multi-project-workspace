import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyMutationRisk,
  createRecoveryBackup,
  restoreRecoveryBackup
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

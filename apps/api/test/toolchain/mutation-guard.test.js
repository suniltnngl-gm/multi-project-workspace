import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyMutationRisk,
  createRecoveryBackup,
  restoreRecoveryBackup,
  protectedWriteFile,
  undoLastEdit,
  pruneBackupsAfterGitCheckpoint,
  checkpointPassingDiff,
  snapshotRestorePoints,
  summarizeCheckpointTelemetry
} from '../../src/toolchain/dispatch/mutation-guard.js'

test('classifyMutationRisk blocks unrecoverable and wholesale-revert mutations and allows recoverable commands', () => {
  for (const bad of [
    `git ${'push'} --force origin master`,
    `git ${'reset'} --hard HEAD~1`,
    `git ${'clean'} -fdx`,
    `git ${'checkout'} -- .`,
    `git ${'restore'} .`,
    `git ${'stash'} clear`,
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

    // Regression: an unprotected edit after the last backup must fail closed on undo
    writeFileSync(fileA, 'v2-unprotected-external-edit', 'utf8')
    assert.throws(() => undoLastEdit(fileA, { backupDir: bdir }), /unprotected_edit_detected/)
    assert.strictEqual(readFileSync(fileA, 'utf8'), 'v2-unprotected-external-edit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protectedWriteFile enforces bounded recovery size (maxBackupsPerFile & maxTotalBytes) while preserving last-minute undo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-recovery-'))
  try {
    const fileA = join(dir, 'state.json')
    const bdir = join(dir, '.backups')
    writeFileSync(fileA, 'v0', 'utf8')

    for (let i = 1; i <= 8; i++) {
      protectedWriteFile(fileA, `v${i}`, { backupDir: bdir, maxBackupsPerFile: 3 })
    }

    // Should retain at most 3 backups (v5, v6, v7) and undo the last edit (v8 -> v7 -> v6)
    undoLastEdit(fileA, { backupDir: bdir })
    assert.strictEqual(readFileSync(fileA, 'utf8'), 'v7')
    undoLastEdit(fileA, { backupDir: bdir })
    assert.strictEqual(readFileSync(fileA, 'utf8'), 'v6')
    undoLastEdit(fileA, { backupDir: bdir })
    assert.strictEqual(readFileSync(fileA, 'utf8'), 'v5')
    assert.throws(() => undoLastEdit(fileA, { backupDir: bdir }), /no_backup_history/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneBackupsAfterGitCheckpoint compacts committed repo & state backups to 1 passing checkpoint and checkpointPassingDiff protects with backup + git + github', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-checkpoint-prune-'))
  try {
    const repoFile = join(dir, 'repo', 'app.js')
    const stateFile = join(dir, 'state', 'sessions.json')
    mkdirSync(join(dir, 'repo'), { recursive: true })
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(repoFile, 'r0', 'utf8')
    writeFileSync(stateFile, 's0', 'utf8')

    for (let i = 1; i <= 4; i++) {
      protectedWriteFile(repoFile, `r${i}`)
      protectedWriteFile(stateFile, `s${i}`)
    }

    const res = pruneBackupsAfterGitCheckpoint({
      committedPaths: [repoFile],
      stateBackupDirs: [join(dir, 'state', '.backups')],
      keepRepoBackups: 1,
      keepStateBackups: 1
    })
    assert.strictEqual(res.ok, true)
    assert.ok(res.prunedCount >= 6)

    // Both repo file and state file retain their 1 newest backup (no wholesale revert needed)
    undoLastEdit(repoFile)
    assert.strictEqual(readFileSync(repoFile, 'utf8'), 'r3')
    assert.throws(() => undoLastEdit(repoFile), /no_backup_history/)

    undoLastEdit(stateFile)
    assert.strictEqual(readFileSync(stateFile, 'utf8'), 's3')
    assert.throws(() => undoLastEdit(stateFile), /no_backup_history/)

    // Verify triple-layer checkpointPassingDiff (backup + git commit + github push)
    const gitCalls = []
    const cp = checkpointPassingDiff({
      repoDir: join(dir, 'repo'),
      files: ['app.js'],
      message: 'feat: passing diff',
      backupRoot: join(dir, 'state'),
      push: true,
      runGit: (args) => {
        gitCalls.push(args)
        if (args[0] === 'rev-parse') return 'abc1234'
        return ''
      }
    })
    assert.strictEqual(cp.ok, true)
    assert.strictEqual(cp.commitSha, 'abc1234')
    assert.strictEqual(cp.pushed, true)
    assert.strictEqual(cp.backups.length, 1)
    assert.strictEqual(gitCalls.some((a) => a[0] === 'add'), true)
    assert.strictEqual(gitCalls.some((a) => a[0] === 'commit'), true)
    assert.strictEqual(gitCalls.some((a) => a[0] === 'push'), true)

    const metrics = summarizeCheckpointTelemetry(cp.ledgerPath)
    assert.strictEqual(metrics.totalCheckpoints, 1)
    assert.strictEqual(metrics.pushedCheckpoints, 1)
    assert.strictEqual(metrics.filesProtected, 1)
    assert.strictEqual(metrics.wholesaleRevertsAvoided, 1)
    assert.strictEqual(metrics.estimatedQuotaTurnsSaved, 1)
    assert.strictEqual(metrics.latestCommitSha, 'abc1234')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkpointPassingDiff enforces fresh ACCEPT gate provenance; snapshotRestorePoints seeds undo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-gate-'))
  const state = mkdtempSync(join(tmpdir(), 'mg-state-'))
  try {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')

    assert.equal(snapshotRestorePoints(['a.txt'], { repoDir: dir, backupRoot: state }).length, 1)
    writeFileSync(join(dir, 'a.txt'), 'changed\n')

    // REJECT artifact -> fail closed, no commit.
    writeFileSync(join(state, 'reject.json'), JSON.stringify({ schema: 'review-verdict/v1', windowStartedAtMs: Date.now(), verdict: 'REJECT' }))
    assert.throws(
      () => checkpointPassingDiff({ repoDir: dir, files: ['a.txt'], backupRoot: state, ledgerPath: join(state, 'ledger.jsonl'), gate: { verdictPath: join(state, 'reject.json') } }),
      /checkpoint_blocked_gate_verdict:not_accept/
    )

    // Stale ACCEPT -> fail closed.
    writeFileSync(join(state, 'stale.json'), JSON.stringify({ verdict: 'ACCEPT', windowStartedAtMs: Date.now() - 3600 * 1000 }))
    assert.throws(
      () => checkpointPassingDiff({ repoDir: dir, files: ['a.txt'], backupRoot: state, ledgerPath: join(state, 'ledger.jsonl'), gate: { verdictPath: join(state, 'stale.json') } }),
      /checkpoint_blocked_gate_verdict:stale/
    )

    // Fresh ACCEPT -> commits and records provenance atomically in the ledger.
    writeFileSync(join(state, 'ok.json'), JSON.stringify({ schema: 'review-verdict/v1', windowStartedAtMs: Date.now(), verdict: 'ACCEPT', source: 'w4_sibling_stdout' }))
    const res = checkpointPassingDiff({
      repoDir: dir,
      files: ['a.txt'],
      backupRoot: state,
      ledgerPath: join(state, 'ledger.jsonl'),
      push: false,
      gate: { verdictPath: join(state, 'ok.json'), windowId: 'r1-w5', gateSource: 'w4_sibling_stdout_accept' }
    })
    assert.equal(res.gate.verdict, 'ACCEPT')
    assert.equal(res.gate.windowId, 'r1-w5')
    const lastLine = readFileSync(join(state, 'ledger.jsonl'), 'utf8').trim().split('\n').pop()
    assert.equal(JSON.parse(lastLine).windowId, 'r1-w5')
    assert.equal(JSON.parse(lastLine).verdict, 'ACCEPT')
    assert.equal(JSON.parse(lastLine).gateSource, 'w4_sibling_stdout_accept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

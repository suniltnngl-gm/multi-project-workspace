import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPublishGate, modifiedFilesSince, readReviewVerdict, rejectRoundCleanup } from '../../../scripts/swarm-publish-gate.mjs'
import { protectedWriteFile, snapshotRestorePoints } from '../src/toolchain/dispatch/mutation-guard.js'

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'pubgate-'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 't')
  protectedWriteFile(join(repo, 'a.txt'), 'v1\n')
  git(repo, 'add', '--', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'init', '--', 'a.txt')
  return repo
}

test('readReviewVerdict fails closed on missing/malformed and accepts ACCEPT/REJECT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'))
  try {
    assert.equal(readReviewVerdict(join(dir, 'missing.json')).verdict, 'REJECT')
    assert.equal(readReviewVerdict(join(dir, 'missing.json')).reason, 'missing_verdict_artifact')

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{oops')
    assert.equal(readReviewVerdict(bad).reason, 'malformed_verdict_artifact')

    const ok = join(dir, 'ok.json')
    writeFileSync(ok, JSON.stringify({ verdict: 'accept' }))
    assert.equal(readReviewVerdict(ok).verdict, 'ACCEPT')

    const nested = join(dir, 'nested.json')
    writeFileSync(nested, JSON.stringify({ review: { verdict: 'REJECT', reason: 'w4_reject' } }))
    assert.equal(readReviewVerdict(nested).verdict, 'REJECT')

    // A prior round's artifact (mtime older than this window's start) must fail closed.
    assert.equal(readReviewVerdict(ok, { windowStartedAtMs: Date.now() + 60_000 }).reason, 'stale_verdict_artifact')
    assert.equal(readReviewVerdict(ok, { windowStartedAtMs: Date.now() }).verdict, 'ACCEPT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyPublishGate ACCEPT checkpoints exactly the round files (push disabled)', () => {
  const repo = initRepo()
  const reports = mkdtempSync(join(tmpdir(), 'reports-'))
  const backups = mkdtempSync(join(tmpdir(), 'backups-'))
  try {
    const base = git(repo, 'rev-parse', 'HEAD')
    protectedWriteFile(join(repo, 'a.txt'), 'v2\n')
    protectedWriteFile(join(repo, 'b.txt'), 'new\n')

    assert.deepEqual(modifiedFilesSince({ repoDir: repo, baseSha: base }).sort(), ['a.txt', 'b.txt'])

    const res = applyPublishGate({
      verdict: { verdict: 'ACCEPT', reason: 'ok' }, repoDir: repo, baseSha: base,
      reportDir: reports, sibling: 'hermes', quotaPool: 'nous-hermes-free',
      taskId: '#t', push: false, backupRoot: backups
    })
    assert.equal(res.action, 'checkpoint_pushed')
    assert.ok(res.commitSha)
    assert.doesNotMatch(git(repo, 'status', '--porcelain'), /a\.txt|b\.txt/)
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v2\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
    rmSync(backups, { recursive: true, force: true })
  }
})

test('applyPublishGate ACCEPT is idempotent when the build window already committed', () => {
  const repo = initRepo()
  const reports = mkdtempSync(join(tmpdir(), 'reports-'))
  const backups = mkdtempSync(join(tmpdir(), 'backups-'))
  try {
    const base = git(repo, 'rev-parse', 'HEAD')
    protectedWriteFile(join(repo, 'a.txt'), 'v2\n')
    const first = applyPublishGate({
      verdict: { verdict: 'ACCEPT', reason: 'ok' }, repoDir: repo, baseSha: base,
      reportDir: reports, sibling: 'hermes', quotaPool: 'nous-hermes-free',
      taskId: '#t', push: false, backupRoot: backups
    })
    assert.equal(first.action, 'checkpoint_pushed')

    const second = applyPublishGate({
      verdict: { verdict: 'ACCEPT', reason: 'ok' }, repoDir: repo, baseSha: base,
      reportDir: reports, sibling: 'hermes', quotaPool: 'nous-hermes-free',
      taskId: '#t', push: false, backupRoot: backups
    })
    assert.equal(second.action, 'already_committed')
    assert.doesNotThrow(() => git(repo, 'status', '--porcelain'))
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
    rmSync(backups, { recursive: true, force: true })
  }
})

test('applyPublishGate REJECT undoes only the last edit per file and writes replan guidance', () => {
  const repo = initRepo()
  const reports = mkdtempSync(join(tmpdir(), 'reports-'))
  try {
    const base = git(repo, 'rev-parse', 'HEAD')
    protectedWriteFile(join(repo, 'a.txt'), 'bad\n')

    const res = applyPublishGate({
      verdict: { verdict: 'REJECT', reason: 'unit_tests_failed' }, repoDir: repo, baseSha: base,
      reportDir: reports, sibling: 'hermes', quotaPool: 'nous-hermes-free', push: false
    })
    assert.equal(res.action, 'undone_single_file')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v1\n')
    assert.match(res.replanPath, /replan-\d+\.json$/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
  }
})

test('rejectRoundCleanup restores pre-round edits and removes round-created untracked files', () => {
  const repo = initRepo()
  const state = mkdtempSync(join(tmpdir(), 'pubgate-state-'))
  try {
    writeFileSync(join(repo, 'existing.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    // Pre-round baseline: snapshot the file that already existed.
    assert.equal(snapshotRestorePoints(['existing.txt'], { repoDir: repo, backupRoot: state }).length, 1)

    // Build window dirties the existing file and creates a brand-new untracked one.
    writeFileSync(join(repo, 'existing.txt'), 'dirty\n')
    writeFileSync(join(repo, 'new-file.mjs'), 'x\n')

    const res = rejectRoundCleanup({ repoDir: repo, baseSha: 'HEAD', preExisting: ['existing.txt'], backupRoot: state })
    assert.equal(res.ok, true)
    assert.deepEqual(res.undone, ['existing.txt'])
    assert.deepEqual(res.removed, ['new-file.mjs'])
    assert.deepEqual(res.failed, [])
    assert.deepEqual(res.remaining, [])
    assert.equal(readFileSync(join(repo, 'existing.txt'), 'utf8'), 'base\n')
    assert.equal(existsSync(join(repo, 'new-file.mjs')), false)

    // Unprotected new file with no snapshot still fails closed (never silently continues).
    writeFileSync(join(repo, 'orphan.txt'), 'y\n')
    const blocked = rejectRoundCleanup({ repoDir: repo, baseSha: 'HEAD', preExisting: [] })
    assert.equal(blocked.removed.includes('orphan.txt'), true)
    assert.equal(blocked.ok, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('#221: no_backup_history on a tracked sibling edit falls back to a scoped git checkout', () => {
  const repo = initRepo()
  const state = mkdtempSync(join(tmpdir(), 'pubgate-nobak-'))
  try {
    // Written directly and committed without protectedWriteFile: there is no backup snapshot.
    writeFileSync(join(repo, 'unsnapshotted.txt'), 'base\n')
    git(repo, 'add', '--', 'unsnapshotted.txt')
    git(repo, 'commit', '-qm', 'unsnapshotted base', '--', 'unsnapshotted.txt')
    writeFileSync(join(repo, 'unsnapshotted.txt'), 'cline edit\n')

    const res = rejectRoundCleanup({ repoDir: repo, baseSha: 'HEAD', preExisting: [], backupRoot: state })
    assert.equal(res.ok, true)
    assert.deepEqual(res.undone, ['unsnapshotted.txt'])
    assert.deepEqual(res.failed, [])
    assert.deepEqual(res.remaining, [])
    assert.equal(readFileSync(join(repo, 'unsnapshotted.txt'), 'utf8'), 'base\n')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v1\n', 'unrelated files must not be touched')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('applyPublishGate REJECT reports ok:false when the scoped HEAD fallback cannot restore state', () => {
  const repo = initRepo()
  const reportDir = mkdtempSync(join(tmpdir(), 'pubgate-report-'))
  try {
    // late.txt is added after baseSha, so checkout <baseSha> -- late.txt fails.
    writeFileSync(join(repo, 'bootstrap.txt'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'bootstrap base')
    const baseSha = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'late.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'add late')
    writeFileSync(join(repo, 'late.txt'), 'dirty\n')
    const gate = applyPublishGate({
      verdict: { verdict: 'REJECT', reason: 'w4_verdict_reject' },
      repoDir: repo,
      baseSha,
      reportDir,
      push: false
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.action, 'reject_cleanup_incomplete')
    assert.ok(Array.isArray(gate.remaining) && gate.remaining.includes('late.txt'))
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(reportDir, { recursive: true, force: true })
  }
})

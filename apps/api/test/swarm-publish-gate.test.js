import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPublishGate, modifiedFilesSince, readReviewVerdict } from '../../../scripts/swarm-publish-gate.mjs'
import { protectedWriteFile } from '../src/toolchain/dispatch/mutation-guard.js'

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

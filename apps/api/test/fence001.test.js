import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { createProjectWriterLeasesStore } from '../src/db/projectWriterLeases.js'
import { createProjectWriterLeaseGuard } from '../src/projectWriterLease.js'

function gitRepo(dir, name) {
  const repo = join(dir, name)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'lease-test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Lease Test'])
  writeFileSync(join(repo, 'f.txt'), 'canonical')
  execFileSync('git', ['-C', repo, 'add', 'f.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'fixture'])
  return repo
}
function headOf(repo) { return { branch: execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } }
function fixture(dir, repo, wt, wtBranch, wtHead) {
  const db = new Database(join(dir, 'db.sqlite'))
  db.exec("CREATE TABLE repositories(id INTEGER PRIMARY KEY,name TEXT UNIQUE,root_path TEXT UNIQUE,created_at TEXT,updated_at TEXT); CREATE TABLE project_writer_lease_state(project_id TEXT PRIMARY KEY,fencing_generation INTEGER,current_lease_id TEXT,updated_at TEXT); CREATE TABLE project_writer_leases(lease_id TEXT PRIMARY KEY,project_id TEXT,task_id INTEGER,run_id TEXT,worker_id TEXT,owner_id TEXT,repositories_json TEXT,allowlist_json TEXT,allowlist_sha256 TEXT,binding_sha256 TEXT,authorization_ref TEXT,fencing_generation INTEGER,acquired_at TEXT,heartbeat_at TEXT,expires_at TEXT,status TEXT,idempotency_key TEXT UNIQUE); CREATE TABLE project_writer_lease_events(event_id TEXT PRIMARY KEY,project_id TEXT,lease_id TEXT,fencing_generation INTEGER,event_type TEXT,idempotency_key TEXT UNIQUE,occurred_at TEXT,details_json TEXT); CREATE TABLE git_worktrees(id INTEGER PRIMARY KEY,repository_id INTEGER,repository_root TEXT,worktree_path TEXT UNIQUE,branch TEXT,head_commit TEXT,remote_url TEXT,created_at TEXT,updated_at TEXT)")
  db.prepare('INSERT INTO repositories(id,name,root_path,created_at,updated_at) VALUES(1,?,?,?,?)').run('multi-project-workspace', repo, 'x', 'x')
  db.prepare('INSERT INTO repositories(id,name,root_path,created_at,updated_at) VALUES(4,?,?,?,?)').run('curl-ai-bridge', join(dir, 'repo4'), 'x', 'x')
  db.prepare('INSERT INTO git_worktrees(repository_id,repository_root,worktree_path,branch,head_commit,remote_url,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)').run(repo, wt, wtBranch, wtHead, '', 'x', 'x')
  return db
}
function acquire(store, repo, repo4, wt, wtBranch, wtHead, branch, head, branch4, head4, key) {
  return store.acquire({ projectId: 'curl-ai-bridge', taskId: 152, runId: 'fence001-' + key, workerId: 'fence001-worker', ownerId: 'sunilkr@sunilkr-H81', authorizationRef: 'test:' + key, repositories: [
    { repositoryId: 1, name: 'multi-project-workspace', rootPath: repo, branch, headCommit: head, worktreePath: wt, worktreeBranch: wtBranch, worktreeHead: wtHead },
    { repositoryId: 4, name: 'curl-ai-bridge', rootPath: repo4, branch: branch4, headCommit: head4 }
  ], allowlist: { files: [{ repositoryId: 1, path: 'f.txt', operations: ['MODIFY'] }], mutations: ['tasks', 'task_events'] }, idempotencyKey: key })
}

test('worktree-bound lease acquires, fences mutation, and rejects after commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence001-')), repo = gitRepo(dir, 'repo'), repo4 = gitRepo(dir, 'repo4'), wt = join(dir, 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt])
  const a = headOf(repo), b = headOf(repo4), w = headOf(wt)
  const db = fixture(dir, repo, wt, w.branch, w.head), store = createProjectWriterLeasesStore(db)
  const lease = acquire(store, repo, repo4, wt, w.branch, w.head, a.branch, a.head, b.branch, b.head, 'fence001-it')
  assert.equal(lease.fencingGeneration, 1)
  const worktrees = [{ repositoryId: 1, repositoryRoot: repo, worktreePath: wt, branch: w.branch, headCommit: w.head }]
  const guard = createProjectWriterLeaseGuard({ connection: db, leaseStore: store, repositories: [{ repositoryId: 1, name: 'multi-project-workspace', rootPath: repo }, { repositoryId: 4, name: 'curl-ai-bridge', rootPath: repo4 }], worktrees })
  assert.equal(guard.withFencedMutation(lease.leaseId, 1, { repositoryId: 1, path: 'f.txt', operation: 'MODIFY' }, 'worktree').path, 'f.txt')
  assert.equal(readFileSync(join(wt, 'f.txt'), 'utf8'), 'worktree')
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'canonical')
  execFileSync('git', ['-C', wt, 'add', 'f.txt']); execFileSync('git', ['-C', wt, 'commit', '-qm', 'wt commit'])
  assert.throws(() => guard.assertCurrentWriterLease(lease.leaseId, 1, [{ repositoryId: 1, path: 'f.txt', operation: 'MODIFY' }]), /writer_worktree_head_changed/)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('repository 4 remains an identity anchor without mutation authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence001b-')), repo = gitRepo(dir, 'repo'), repo4 = gitRepo(dir, 'repo4'), wt = join(dir, 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt])
  const a = headOf(repo), b = headOf(repo4), w = headOf(wt)
  const db = fixture(dir, repo, wt, w.branch, w.head), store = createProjectWriterLeasesStore(db)
  const lease = acquire(store, repo, repo4, wt, w.branch, w.head, a.branch, a.head, b.branch, b.head, 'fence001b-it')
  const guard = createProjectWriterLeaseGuard({ connection: db, leaseStore: store, repositories: [{ repositoryId: 1, name: 'multi-project-workspace', rootPath: repo }, { repositoryId: 4, name: 'curl-ai-bridge', rootPath: repo4 }], worktrees: [{ repositoryId: 1, repositoryRoot: repo, worktreePath: wt, branch: w.branch, headCommit: w.head }] })
  assert.throws(() => guard.assertCurrentWriterLease(lease.leaseId, 1, [{ repositoryId: 4, path: 'f.txt', operation: 'MODIFY' }]), /writer_path_not_allowlisted/)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('registration replacement after acquisition is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence001c-')), repo = gitRepo(dir, 'repo'), repo4 = gitRepo(dir, 'repo4'), wt = join(dir, 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt])
  const a = headOf(repo), b = headOf(repo4), w = headOf(wt)
  const db = fixture(dir, repo, wt, w.branch, w.head), store = createProjectWriterLeasesStore(db)
  const lease = acquire(store, repo, repo4, wt, w.branch, w.head, a.branch, a.head, b.branch, b.head, 'fence001c-it')
  const repos = [{ repositoryId: 1, name: 'multi-project-workspace', rootPath: repo }, { repositoryId: 4, name: 'curl-ai-bridge', rootPath: repo4 }]
  const good = createProjectWriterLeaseGuard({ connection: db, leaseStore: store, repositories: repos, worktrees: [{ repositoryId: 1, repositoryRoot: repo, worktreePath: wt, branch: w.branch, headCommit: w.head }] })
  assert.doesNotThrow(() => good.assertCurrentWriterLease(lease.leaseId, 1, []))
  const replaced = createProjectWriterLeaseGuard({ connection: db, leaseStore: store, repositories: repos, worktrees: [{ repositoryId: 1, repositoryRoot: repo, worktreePath: join(dir, 'moved'), branch: w.branch, headCommit: w.head }] })
  assert.throws(() => replaced.assertCurrentWriterLease(lease.leaseId, 1, []), /writer_worktree_not_registered/)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

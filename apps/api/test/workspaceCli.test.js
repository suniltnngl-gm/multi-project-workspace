// Objective: Cover portable path helpers, the Node launcher contract, and database relocation adoption.
// Requirements: Use temporary directories only; never touch the real workspace database.
// Decisions: Exercise runMigrations directly so the workspace-local database marker can be supplied explicitly.
// Relevant Files: scripts/env.mjs, scripts/workspace-cli.mjs, apps/api/src/db/migrations.js
// Important Context: User file. Relocation adoption is limited to workspace-local databases whose old root disappeared.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { runMigrations } from '../src/db/migrations.js'
import { resolveDatabasePath, workspaceTmpDir } from '../../../scripts/env.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('resolveDatabasePath anchors relative values to the workspace root', () => {
  assert.equal(
    resolveDatabasePath({ env: { DATABASE_PATH: 'apps/api/data/workspace.sqlite' }, rootDir: '/workspace' }),
    resolve('/workspace/apps/api/data/workspace.sqlite')
  )
  assert.equal(
    resolveDatabasePath({ env: { DATABASE_PATH: '/var/lib/workspace.sqlite' }, rootDir: '/workspace' }),
    resolve('/var/lib/workspace.sqlite')
  )
  assert.equal(
    resolveDatabasePath({ env: {}, rootDir: '/workspace', fallback: '/fallback.sqlite' }),
    '/fallback.sqlite'
  )
})

test('workspaceTmpDir honors WORKSPACE_TMP_DIR and falls back to the OS temp directory', () => {
  assert.equal(
    workspaceTmpDir({ env: { WORKSPACE_TMP_DIR: '/custom/tmp' } }),
    resolve('/custom/tmp')
  )
  assert.equal(workspaceTmpDir({ env: {} }), join(tmpdir(), 'opencode'))
})

test('the Node launcher prints help and rejects unknown commands', () => {
  const help = spawnSync(process.execPath, [join(ROOT, 'scripts', 'workspace-cli.mjs'), 'help'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Workspace commands/)

  const unknown = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'workspace-cli.mjs'), 'definitely-not-a-command'],
    { cwd: ROOT, encoding: 'utf8' }
  )
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown command/)
})

test('a workspace-local database adopts the primary repository after the checkout moves', () => {
  const base = temporaryDirectory('workspace-relocate-')
  try {
    const oldRoot = join(base, 'old-checkout')
    const newRoot = join(base, 'new-checkout')
    const databasePath = join(base, 'workspace.sqlite')
    const now = new Date().toISOString()

    const original = new Database(databasePath)
    runMigrations(original, { rootDir: oldRoot })
    original.prepare(
      'INSERT INTO user_files (repository_id, path, created_at, updated_at) VALUES (1, ?, ?, ?)'
    ).run('README.md', now, now)
    original.prepare(
      `INSERT INTO git_worktrees
       (repository_id, repository_root, worktree_path, branch, head_commit, created_at, updated_at)
       VALUES (1, ?, ?, 'master', 'abc', ?, ?)`
    ).run(oldRoot, oldRoot, now, now)
    original.prepare(
      'INSERT INTO environments (name, value, source, checked_at) VALUES (?, ?, ?, ?)'
    ).run('cwd', oldRoot, 'os.getcwd', now)
    original.close()

    const moved = new Database(databasePath)
    runMigrations(moved, {
      rootDir: newRoot,
      databasePath,
      defaultDatabasePath: databasePath
    })
    const repositories = moved.prepare('SELECT id, name, root_path FROM repositories').all()
    assert.equal(repositories.length, 1)
    assert.equal(repositories[0].id, 1)
    assert.equal(repositories[0].root_path, newRoot)
    assert.equal(moved.prepare('SELECT repository_id FROM user_files').get().repository_id, 1)
    assert.deepEqual(
      moved.prepare('SELECT repository_root, worktree_path FROM git_worktrees').get(),
      { repository_root: newRoot, worktree_path: newRoot }
    )
    assert.equal(
      moved.prepare("SELECT value FROM environments WHERE name = 'cwd'").get().value,
      newRoot
    )
    moved.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a checkout whose old root still exists registers a second repository', () => {
  const base = temporaryDirectory('workspace-no-relocate-')
  try {
    const oldRoot = join(base, 'old-checkout')
    const newRoot = join(base, 'new-checkout')
    const databasePath = join(base, 'workspace.sqlite')
    mkdirSync(oldRoot, { recursive: true })
    mkdirSync(newRoot, { recursive: true })

    const original = new Database(databasePath)
    runMigrations(original, { rootDir: oldRoot })
    original.close()

    const reopened = new Database(databasePath)
    runMigrations(reopened, {
      rootDir: newRoot,
      databasePath,
      defaultDatabasePath: databasePath
    })
    const roots = reopened.prepare('SELECT root_path FROM repositories ORDER BY id').all()
    assert.deepEqual(roots.map((row) => row.root_path), [oldRoot, newRoot])
    reopened.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

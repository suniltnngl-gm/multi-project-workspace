// Objective: Cover portable path helpers, the Node launcher contract, and database relocation adoption.
// Requirements: Use temporary directories only; never touch the real workspace database.
// Decisions: Exercise runMigrations directly so the workspace-local database marker can be supplied explicitly.
// Relevant Files: scripts/env.mjs, scripts/workspace-cli.mjs, apps/api/src/db/migrations.js
// Important Context: User file. Relocation adoption is limited to workspace-local databases whose old root disappeared.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
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
    original.prepare(
      `INSERT INTO tasks (title, worktree_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run('Relocatable task', oldRoot, now, now)
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
    assert.equal(
      moved.prepare("SELECT worktree_path FROM tasks WHERE title = 'Relocatable task'").get().worktree_path,
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


test('ai swarm dispatch requires Bash and routes through mandatory entrypoint',()=>{
 const base=temporaryDirectory('workspace-swarm-dispatch-')
 try {
  const bin=join(base,'bin'),capture=join(base,'args')
  mkdirSync(bin,{recursive:true})
  writeFileSync(join(bin,'bash'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$SWARM_DISPATCH_CAPTURE"\n',{mode:0o755})
  const env={...process.env,PATH:bin+delimiter+process.env.PATH,SWARM_DISPATCH_CAPTURE:capture}
  const result=spawnSync(process.execPath,[join(ROOT,'scripts','workspace-cli.mjs'),'ai','swarm','status'],{cwd:ROOT,encoding:'utf8',env})
  assert.equal(result.status,0,result.stderr)
  const args=readFileSync(capture,'utf8').trim().split(String.fromCharCode(10))
  assert.equal(args[0],join(ROOT,'scripts','swarm-entry.sh'))
  assert.equal(args[1],'status')
 } finally {rmSync(base,{recursive:true,force:true})}
})

function taskCliDatabase() {
  const base = temporaryDirectory('workspace-task-cli-')
  const databasePath = join(base, 'workspace.sqlite')
  const original = new Database(databasePath)
  runMigrations(original, { rootDir: base })
  original.close()
  return { env: { ...process.env, DATABASE_PATH: databasePath }, base, databasePath }
}

test('task create --help prints usage and creates no task', () => {
  const { env, base } = taskCliDatabase()
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'workspace-cli.mjs'), 'task', 'create', '--help'], { cwd: ROOT, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /task create <title>/)
    const isolated = new Database(env.DATABASE_PATH, { readonly: true })
    try {
      assert.equal(isolated.prepare("SELECT id FROM tasks WHERE title = '--help'").get(), undefined)
    } finally { isolated.close() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('task create rejects unknown flags instead of swallowing them into the title', () => {
  const { env, base } = taskCliDatabase()
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'workspace-cli.mjs'), 'task', 'create', 'Real title', '--unknown-flag'], { cwd: ROOT, encoding: 'utf8', env })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Unknown task create option: --unknown-flag/)
    const isolated = new Database(env.DATABASE_PATH, { readonly: true })
    try {
      assert.equal(isolated.prepare("SELECT id FROM tasks WHERE title = 'Real title'").get(), undefined)
    } finally { isolated.close() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('task --help prints usage at the subcommand level', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'workspace-cli.mjs'), 'task', '--help'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /task create <title>/)
})

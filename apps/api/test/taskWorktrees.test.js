// Objective: Test task-scoped Git worktrees: module conventions, API lifecycle, and AI execution isolation.
// Requirements: Cover creation, linking, self-heal of stale links, forced removal, tracking rows, events, and the OpenCode cwd wiring.
// Decisions: Inject a task worktree manager bound to a temporary Git repository so tests never touch the workspace checkout.
// Relevant Files: apps/api/test/taskWorktrees.test.js, apps/api/src/taskWorktrees.js, apps/api/src/app.js, apps/api/src/modelClient.js
// Important Context: User file. Real git runs against the temp repository; the model client test injects a fake runner.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'
import { createModelClient } from '../src/modelClient.js'
import {
  createTaskWorktrees,
  parseWorktreePorcelain,
  slugifyTaskTitle
} from '../src/taskWorktrees.js'

let repository
let worktreeRoot
let database
let server
let baseUrl

function gitIn(repo, args) {
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

before(async () => {
  repository = await mkdtemp(join(tmpdir(), 'workspace-task-repo-'))
  gitIn(repository, ['init', '--initial-branch=main'])
  gitIn(repository, ['config', 'user.email', 'tests@example.invalid'])
  gitIn(repository, ['config', 'user.name', 'Workspace Tests'])
  writeFileSync(join(repository, 'README.md'), '# fixture\n')
  gitIn(repository, ['add', '.'])
  gitIn(repository, ['commit', '-m', 'fixture'])

  database = createDatabase(join(repository, 'worktrees.sqlite'))
  const worktrees = createTaskWorktrees({ repoRoot: repository })
  worktreeRoot = worktrees.worktreeRoot
  server = createApp(database, { taskWorktrees: worktrees }).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
  for (const directory of [repository, worktreeRoot]) {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

test('task titles slug into stable worktree locations', () => {
  assert.equal(slugifyTaskTitle('Integrate OpenCode worktrees with tasks!'), 'integrate-opencode-worktrees-with-tasks')
  assert.equal(slugifyTaskTitle('This title is deliberately much longer than the forty character slug limit allows'), 'this-title-is-deliberately-much-longer-t')
  assert.equal(slugifyTaskTitle(''), 'task')
  const worktrees = createTaskWorktrees({ repoRoot: repository })
  const location = worktrees.resolveWorktree({ taskId: 7, title: 'A Task: Title!' })
  assert.equal(location.branch, 'task/7-a-task-title')
  assert.equal(location.path, join(worktrees.worktreeRoot, 'task-7-a-task-title'))
})

test('porcelain output parses into tracking entries', () => {
  const output = [
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt',
    'HEAD def456',
    '',
    ''
  ].join('\n')
  const entries = parseWorktreePorcelain(output, '/repo/main')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].worktreePath, '/repo/main')
  assert.equal(entries[0].branch, 'main')
  assert.equal(entries[0].headCommit, 'abc123')
  assert.equal(entries[1].branch, '')
})

test('a worktree is created, linked, tracked, and cleaned up through the API', async () => {
  const task = await (await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Isolate fixture work', project: 'worktree-tests' })
  })).json()

  const created = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'POST' })
  assert.equal(created.status, 201)
  const link = await created.json()
  assert.equal(link.branch, `task/${task.id}-isolate-fixture-work`)
  assert.ok(existsSync(link.worktreePath))
  assert.ok(existsSync(join(link.worktreePath, 'README.md')))

  const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json()
  assert.equal(detail.worktree_path, link.worktreePath)
  assert.ok(detail.activity.some(
    (event) => event.action === 'worktree_linked' && event.field === 'worktree_path' &&
      event.newValue === link.worktreePath
  ))

  const rows = await (await fetch(`${baseUrl}/api/git-worktrees`)).json()
  const row = rows.find((entry) => entry.worktreePath === link.worktreePath)
  assert.ok(row, 'the worktree is registered in the git worktrees domain')
  assert.equal(row.branch, link.branch)

  const again = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'POST' })
  assert.equal(again.status, 409)
  assert.equal((await again.json()).worktreePath, link.worktreePath)

  const removed = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.ok(!existsSync(link.worktreePath))
  const afterRemoval = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json()
  assert.equal(afterRemoval.worktree_path, '')
  assert.ok(afterRemoval.activity.some((event) => event.action === 'worktree_unlinked'))
  const rowsAfter = await (await fetch(`${baseUrl}/api/git-worktrees`)).json()
  assert.ok(!rowsAfter.some((entry) => entry.worktreePath === link.worktreePath))

  const removeAgain = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'DELETE' })
  assert.equal(removeAgain.status, 404)
})

test('a dirty worktree requires force to remove', async () => {
  const task = await (await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Dirty worktree', project: 'worktree-tests' })
  })).json()
  const created = await (await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'POST' })).json()

  writeFileSync(join(created.worktreePath, 'draft.txt'), 'uncommitted')
  const refused = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'DELETE' })
  assert.equal(refused.status, 409)
  assert.match((await refused.json()).error, /uncommitted changes/)

  const forced = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree?force=1`, { method: 'DELETE' })
  assert.equal(forced.status, 200)
  assert.ok(!existsSync(created.worktreePath))
})

test('a stale link self-heals on the next create', async () => {
  const task = await (await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stale link', project: 'worktree-tests' })
  })).json()
  const created = await (await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'POST' })).json()

  // Simulate the worktree being removed by hand.
  rmSync(created.worktreePath, { recursive: true, force: true })
  gitIn(repository, ['worktree', 'prune'])

  const recreated = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'POST' })
  assert.equal(recreated.status, 201)
  const link = await recreated.json()
  assert.equal(link.worktreePath, created.worktreePath)
  assert.ok(existsSync(link.worktreePath))

  const cleanup = await fetch(`${baseUrl}/api/tasks/${task.id}/worktree`, { method: 'DELETE' })
  assert.equal(cleanup.status, 200)
})

test('a task-linked OpenCode run executes inside the task worktree', async () => {
  const runs = []
  const client = createModelClient({
    runCommand: async (command, args, options) => {
      runs.push({ command, args, options })
      return { stdout: '{"type":"text","part":{"text":"done"}}\n', stderr: '' }
    }
  })
  const model = {
    id: 'opencode',
    backend: 'opencode-cli',
    timeoutMs: 5000,
    cli: { command: 'opencode', model: 'console-x/model-y' }
  }
  await client.complete(model, {
    messages: [{ role: 'user', content: 'hello' }],
    worktreePath: '/tmp/example-worktree'
  })
  await client.complete(model, {
    messages: [{ role: 'user', content: 'hello' }]
  })
  assert.equal(runs.length, 2)
  assert.equal(runs[0].options.cwd, '/tmp/example-worktree')
  assert.equal(runs[1].options.cwd, undefined)
  assert.equal(runs[0].command, 'opencode')
})

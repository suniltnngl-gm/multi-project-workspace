import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/database.js'
import { parseTaskAllowlistLines } from '../../../scripts/project-writer-lease.mjs'

const cliPath = resolve(fileURLToPath(new URL('../../../scripts/project-writer-lease.mjs', import.meta.url)))

const sampleRepos = [
  { repositoryId: 1, name: 'multi-project-workspace', rootPath: '/tmp/repos/multi-project-workspace' },
  { repositoryId: 4, name: 'curl-ai-bridge', rootPath: '/tmp/repos/curl-ai-bridge' }
]

test('projectWriterLeaseCli: maps repo ID 4 and repo ID 1 paths accurately', () => {
  const text = [
    'CREATE curl-ai-bridge:server/cases/case-register.mjs — new CAB module',
    'MODIFY curl-ai-bridge/scripts/test-all.mjs — CAB script',
    'CREATE /tmp/repos/curl-ai-bridge/tests/cases/case-register.mjs',
    'CREATE multi-project-workspace:apps/api/src/db/taskReadiness.js',
    'MODIFY scripts/project-writer-lease.mjs — legacy unqualified MPW path'
  ].join('\n')

  const parsed = parseTaskAllowlistLines(text, sampleRepos, { taskId: 160 })
  assert.deepEqual(parsed, [
    { repositoryId: 4, path: 'server/cases/case-register.mjs', operations: ['CREATE'] },
    { repositoryId: 4, path: 'scripts/test-all.mjs', operations: ['MODIFY'] },
    { repositoryId: 4, path: 'tests/cases/case-register.mjs', operations: ['CREATE'] },
    { repositoryId: 1, path: 'apps/api/src/db/taskReadiness.js', operations: ['CREATE'] },
    { repositoryId: 1, path: 'scripts/project-writer-lease.mjs', operations: ['MODIFY'] }
  ])
})

test('projectWriterLeaseCli: fails closed on malformed lines, traversal, unknown/ambiguous repos, and protected paths', () => {
  assert.throws(
    () => parseTaskAllowlistLines('INVALID apps/api/src/x.js', sampleRepos),
    /task_allowlist_line_invalid/
  )
  assert.throws(
    () => parseTaskAllowlistLines('CREATE curl-ai-bridge:../escape.js', sampleRepos),
    /task_allowlist_path_invalid/
  )
  assert.throws(
    () => parseTaskAllowlistLines('CREATE unknown-repo:server/foo.mjs', sampleRepos),
    /task_allowlist_repository_unknown/
  )
  assert.throws(
    () => parseTaskAllowlistLines('CREATE server/foo.mjs', sampleRepos),
    /task_allowlist_repository_ambiguous/
  )
  assert.throws(
    () => parseTaskAllowlistLines('MODIFY multi-project-workspace:.github/workflows/ci.yml', sampleRepos, { taskId: 160 }),
    /task_allowlist_protected_path_rejected/
  )
  assert.throws(
    () => parseTaskAllowlistLines('MODIFY scripts/swarm-entry.sh', sampleRepos, { taskId: 160 }),
    /task_allowlist_protected_path_rejected/
  )
})

test('projectWriterLeaseCli: honors Task 142 and Task 146 PET protected-path exceptions while keeping STATIC_PROTECTED_PATHS blocked', () => {
  const t142 = parseTaskAllowlistLines('MODIFY scripts/swarm-entry.sh\nMODIFY scripts/workspace-cli.mjs', sampleRepos, { taskId: 142 })
  assert.equal(t142.length, 2)
  assert.equal(t142[0].repositoryId, 1)

  const t146Pet = parseTaskAllowlistLines('MODIFY scripts/swarm-entry.sh\nMODIFY scripts/swarm-session.mjs', sampleRepos, { taskId: 146 })
  assert.equal(t146Pet.length, 2)

  assert.throws(
    () => parseTaskAllowlistLines('MODIFY scripts/workspace-cli.mjs', sampleRepos, { taskId: 146 }),
    /task_allowlist_protected_path_rejected/
  )
  assert.throws(
    () => parseTaskAllowlistLines('MODIFY multi-project-workspace:.github/workflows/ci.yml', sampleRepos, { taskId: 142 }),
    /task_allowlist_protected_path_rejected/
  )
  assert.throws(
    () => parseTaskAllowlistLines('MODIFY multi-project-workspace:.github/workflows/ci.yml', sampleRepos, { taskId: 146 }),
    /task_allowlist_protected_path_rejected/
  )
})

function initTempGitRepo(dir, branch = 'master') {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-b', branch], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
}

test('projectWriterLeaseCli: end-to-end acquire maps repo ID 4 paths and fails closed on blocked/unready tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpw-lease-cli-'))
  const mpwRepo = join(dir, 'multi-project-workspace')
  const cabRepo = join(dir, 'curl-ai-bridge')
  const dbPath = join(dir, 'test.sqlite')
  initTempGitRepo(mpwRepo, 'master')
  initTempGitRepo(cabRepo, 'main')

  const db = createDatabase(dbPath)
  try {
    const now = new Date().toISOString()
    db.db.prepare('DELETE FROM repositories WHERE id IN (1, 4)').run()
    db.db.prepare(
      'INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).run('multi-project-workspace', mpwRepo, now, now)
    db.db.prepare(
      'INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (4, ?, ?, ?, ?)'
    ).run('curl-ai-bridge', cabRepo, now, now)

    const readyTaskId = Number(db.db.prepare(`
      INSERT INTO tasks (
        title, description, completed, project, status, priority, task_type,
        relevant_files, important_context, work_blocked, created_at, updated_at
      ) VALUES (?, '', 0, 'curl-ai-bridge', 'in_progress', 'high', 'feature', ?, ?, '', ?, ?)
    `).run(
      'CAB Repo 4 Task',
      'CREATE curl-ai-bridge/server/cases/case-register.mjs\nMODIFY apps/api/src/database.js',
      '[swarm-plan-v1] state=complete disposition=ready_for_serialized_implementation',
      now,
      now
    ).lastInsertRowid)

    const blockedTaskId = Number(db.db.prepare(`
      INSERT INTO tasks (
        title, description, completed, project, status, priority, task_type,
        relevant_files, important_context, work_blocked, created_at, updated_at
      ) VALUES (?, '', 0, 'curl-ai-bridge', 'blocked', 'high', 'feature', ?, ?, 'Still blocked', ?, ?)
    `).run(
      'Blocked Task',
      'CREATE curl-ai-bridge/server/cases/case-register.mjs',
      '[swarm-plan-v1] state=complete disposition=ready_for_serialized_implementation',
      now,
      now
    ).lastInsertRowid)
    db.close()

    const out = execFileSync(process.execPath, [
      cliPath, 'acquire',
      '--db', dbPath,
      '--task', String(readyTaskId),
      '--run-id', 'run-1',
      '--worker-id', 'worker-1',
      '--auth-ref', 'AUTH-TEST-1',
      '--idempotency-key', 'lease-cli-test-1'
    ], { encoding: 'utf8' })

    const lease = JSON.parse(out)
    assert.equal(lease.taskId, readyTaskId)
    assert.deepEqual(lease.allowlist.files, [
      { repositoryId: 4, path: 'server/cases/case-register.mjs', operations: ['CREATE'] },
      { repositoryId: 1, path: 'apps/api/src/database.js', operations: ['MODIFY'] }
    ])

    assert.throws(() => execFileSync(process.execPath, [
      cliPath, 'acquire',
      '--db', dbPath,
      '--task', String(blockedTaskId),
      '--run-id', 'run-2',
      '--worker-id', 'worker-1',
      '--auth-ref', 'AUTH-TEST-2'
    ], { encoding: 'utf8', stdio: 'pipe' }), /task_blocked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

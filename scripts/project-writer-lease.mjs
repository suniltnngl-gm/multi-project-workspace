#!/usr/bin/env node
// Local-only CLI for project-wide fenced writer leases. No provider or network calls.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../apps/api/src/database.js'
import {
  STATIC_PROTECTED_PATHS,
  TASK142_RESERVED_PATHS,
  TASK146_PET_INTEGRATION_PATHS
} from '../apps/api/src/projectWriterLease.js'

const MPW_UNQUALIFIED_PREFIXES = Object.freeze(['apps/', 'scripts/', 'docs/', 'schemas/', 'prompts/'])

function assertSafeRelativePath(relPath, rawPath) {
  if (
    typeof relPath !== 'string' ||
    !relPath ||
    relPath.startsWith('/') ||
    relPath.includes('\\') ||
    relPath.split('/').some((seg) => !seg || seg === '.' || seg === '..')
  ) {
    throw new Error(`task_allowlist_path_invalid:${rawPath}`)
  }
  return relPath
}

function assertNotProtectedPath(relPath, taskId) {
  if (STATIC_PROTECTED_PATHS.includes(relPath)) {
    throw new Error(`task_allowlist_protected_path_rejected:${relPath}`)
  }
  if (TASK142_RESERVED_PATHS.includes(relPath)) {
    const petException = taskId === 146 && TASK146_PET_INTEGRATION_PATHS.includes(relPath)
    if (taskId !== 142 && !petException) {
      throw new Error(`task_allowlist_protected_path_rejected:${relPath}`)
    }
  }
}

export function resolveAllowlistEntry(rawPath, repositories, { taskId = null } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error(`task_allowlist_path_invalid:${rawPath}`)
  }
  const trimmed = rawPath.trim()
  if (trimmed.includes('\\')) {
    throw new Error(`task_allowlist_path_invalid:${trimmed}`)
  }

  // 1. Explicit "<repoName>:<relPath>" or "<repoName>/<relPath>" prefix
  for (const repo of repositories) {
    const colonPrefix = `${repo.name}:`
    if (trimmed.startsWith(colonPrefix)) {
      const rel = assertSafeRelativePath(trimmed.slice(colonPrefix.length), trimmed)
      assertNotProtectedPath(rel, taskId)
      return { repositoryId: repo.repositoryId, path: rel }
    }
    const slashPrefix = `${repo.name}/`
    if (trimmed.startsWith(slashPrefix)) {
      const rel = assertSafeRelativePath(trimmed.slice(slashPrefix.length), trimmed)
      assertNotProtectedPath(rel, taskId)
      return { repositoryId: repo.repositoryId, path: rel }
    }
  }

  // 2. Reject unknown "<prefix>:" repository qualifiers fail-closed
  if (/^[a-zA-Z0-9._-]+:/.test(trimmed)) {
    throw new Error(`task_allowlist_repository_unknown:${trimmed}`)
  }

  // 3. Absolute path matched against registered repository roots
  if (trimmed.startsWith('/')) {
    for (const repo of repositories) {
      const rootPrefix = repo.rootPath.endsWith('/') ? repo.rootPath : `${repo.rootPath}/`
      if (trimmed.startsWith(rootPrefix)) {
        const rel = assertSafeRelativePath(trimmed.slice(rootPrefix.length), trimmed)
        assertNotProtectedPath(rel, taskId)
        return { repositoryId: repo.repositoryId, path: rel }
      }
    }
    throw new Error(`task_allowlist_repository_unknown:${trimmed}`)
  }

  // 4. Unqualified relative path: backward-compatible only for unambiguous MPW roots
  const rel = assertSafeRelativePath(trimmed, trimmed)
  const mpwRepo = repositories.find((r) => r.repositoryId === 1)
  if (mpwRepo && MPW_UNQUALIFIED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
    assertNotProtectedPath(rel, taskId)
    return { repositoryId: mpwRepo.repositoryId, path: rel }
  }

  throw new Error(`task_allowlist_repository_ambiguous:${trimmed}`)
}

export function parseTaskAllowlistLines(relevantFilesText, repositories, { taskId = null } = {}) {
  const lines = String(relevantFilesText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    throw new Error('task_allowlist_empty')
  }
  return lines.map((line) => {
    const match = line.match(/^(CREATE|MODIFY|DELETE)\s+([^\s]+)(?:\s+—.*)?$/)
    if (!match) {
      throw new Error(`task_allowlist_line_invalid:${line}`)
    }
    const resolved = resolveAllowlistEntry(match[2], repositories, { taskId })
    return {
      repositoryId: resolved.repositoryId,
      path: resolved.path,
      operations: [match[1]]
    }
  })
}

function runCli() {
  const args = process.argv.slice(2)
  const command = args.shift() || 'status'
  function opt(name, fallback = null) {
    const i = args.indexOf(`--${name}`)
    return i < 0 ? fallback : (args[i + 1] ?? fallback)
  }
  function required(name) {
    const v = opt(name)
    if (!v) throw new Error(`missing --${name}`)
    return v
  }
  const dbPath = opt('db', undefined)
  const db = dbPath ? createDatabase(dbPath) : createDatabase()
  try {
    const leases = db.writerLeases
    if (command === 'status') {
      console.log(JSON.stringify(leases.status(opt('project', 'curl-ai-bridge')), null, 2))
    } else if (command === 'reclaim-expired') {
      console.log(JSON.stringify(leases.reclaimExpired(opt('project', 'curl-ai-bridge')), null, 2))
    } else if (command === 'acquire') {
      const taskId = Number(required('task'))
      const task = db.db.prepare(
        'SELECT id, project, relevant_files, status, work_blocked, important_context FROM tasks WHERE id = ?'
      ).get(taskId)
      if (!task) throw new Error('task_not_found')
      if (task.status === 'blocked' || task.work_blocked.trim()) throw new Error('task_blocked')
      if (
        !task.important_context.includes('state=complete') ||
        !task.important_context.includes('disposition=ready_for_serialized_implementation')
      ) {
        throw new Error('task_planning_gate_not_complete')
      }
      const repoRows = db.db.prepare(
        'SELECT id AS repositoryId, name, root_path AS rootPath FROM repositories WHERE id IN (1, 4) ORDER BY id'
      ).all()
      if (repoRows.length !== 2) {
        throw new Error('writer_repositories_incomplete')
      }
      const repositories = repoRows.map((r) => ({
        ...r,
        branch: execFileSync('git', ['-C', r.rootPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
        headCommit: execFileSync('git', ['-C', r.rootPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      }))
      const files = parseTaskAllowlistLines(task.relevant_files, repositories, { taskId })
      const lease = leases.acquire({
        projectId: opt('project', task.project),
        taskId,
        runId: required('run-id'),
        workerId: required('worker-id'),
        ownerId: opt('owner-id', opt('worker-id')),
        authorizationRef: required('auth-ref'),
        ttlMs: Number(opt('ttl-ms', '30000')),
        idempotencyKey: opt('idempotency-key'),
        repositories,
        allowlist: { files, mutations: ['tasks', 'task_events'] }
      })
      console.log(JSON.stringify(lease, null, 2))
    } else if (command === 'renew') {
      console.log(JSON.stringify(
        leases.renew(required('lease'), Number(required('generation')), required('owner'), Number(opt('ttl-ms', '30000'))),
        null,
        2
      ))
    } else if (command === 'release') {
      console.log(JSON.stringify(
        leases.release(required('lease'), Number(required('generation')), required('owner'), opt('reason', 'released')),
        null,
        2
      ))
    } else if (command === 'write') {
      const id = required('lease')
      const generation = Number(required('generation'))
      const repoId = Number(required('repository-id'))
      const path = required('path')
      const operation = required('operation')
      const content = readFileSync(required('content-file'))
      console.log(JSON.stringify(
        db.writerLeaseGuard.withFencedMutation(id, generation, { repositoryId: repoId, path, operation }, content.toString('utf8')),
        null,
        2
      ))
    } else if (command === 'assert') {
      const id = required('lease')
      const generation = Number(required('generation'))
      console.log(JSON.stringify(
        db.writerLeaseGuard.assertCurrentWriterLease(id, generation, [], { mutation: opt('mutation') }),
        null,
        2
      ))
    } else {
      throw new Error(`unknown_command:${command}`)
    }
  } finally {
    db.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}

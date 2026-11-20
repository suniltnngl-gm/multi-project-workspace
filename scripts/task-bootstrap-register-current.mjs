#!/usr/bin/env node
import { existsSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDatabase } from '../apps/api/src/database.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = 'curl-ai-bridge'
const DEFAULT_DATABASE = join(ROOT, 'apps', 'api', 'data', 'workspace.sqlite')

function parse(argv) {
  const [command = 'status', ...args] = argv
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help', options: {} }
  if (!['status', 'register'].includes(command)) throw new Error('unsupported_command:' + command)
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (!item.startsWith('--')) throw new Error('unexpected_argument:' + item)
    const key = item.slice(2)
    if (Object.hasOwn(options, key)) throw new Error('duplicate_argument:' + item)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('argument_value_required:' + item)
    options[key] = value
    index += 1
  }
  const allowed = new Set(['database', 'expected-generation', 'authorization-ref', 'idempotency-key'])
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error('unsupported_argument:--' + key)
  return { command, options }
}

function resolveDatabase(raw) {
  const path = raw ? resolve(ROOT, raw) : DEFAULT_DATABASE
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('database_missing_or_symlink')
  return path
}

function readTaskInput() {
  if (process.stdin.isTTY) throw new Error('task_json_stdin_required')
  const chunks = []
  return new Promise((resolvePromise, reject) => {
    let size = 0
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('task_json_input_too_large'))
        process.stdin.destroy()
        return
      }
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) throw new Error('task_json_stdin_required')
        const task = JSON.parse(raw)
        if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task_json_object_required')
        resolvePromise(task)
      } catch (error) { reject(error) }
    })
    process.stdin.on('error', reject)
  })
}

function usage() {
  return [
    'Usage:',
    '  node scripts/task-bootstrap-register-current.mjs status [--database PATH]',
    '  node scripts/task-bootstrap-register-current.mjs register --expected-generation N --authorization-ref REF --idempotency-key KEY [--database PATH] < task.json',
    '',
    'Registration uses the current-generation transactional helper and forces the new task to blocked/completed=false.',
    'The authorization reference is stored as provenance only; it is not independently resolved as a grant and never permits dispatch.',
    'The command does not acquire a writer lease or increment the fencing generation.'
  ].join('\n')
}

async function main(argv) {
  const { command, options } = parse(argv)
  if (command === 'help') {
    process.stdout.write(usage() + '\n')
    return
  }
  const databasePath = resolveDatabase(options.database)

  if (command === 'status') {
    const connection = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const state = connection.prepare(
        'SELECT fencing_generation, current_lease_id FROM project_writer_lease_state WHERE project_id = ?'
      ).get(PROJECT)
      if (!state) throw new Error('task_bootstrap_lease_state_missing')
      const currentLease = state.current_lease_id
        ? connection.prepare('SELECT lease_id, status, expires_at FROM project_writer_leases WHERE lease_id = ?').get(state.current_lease_id) ?? null
        : null
      process.stdout.write(JSON.stringify({
        projectId: PROJECT,
        fencingGeneration: state.fencing_generation,
        currentLeaseId: state.current_lease_id,
        currentLease
      }, null, 2) + '\n')
    } finally { connection.close() }
    return
  }

  for (const key of ['expected-generation', 'authorization-ref', 'idempotency-key']) {
    if (!options[key]) throw new Error('missing_argument:--' + key)
  }
  const expectedGeneration = Number(options['expected-generation'])
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('invalid_expected_generation')
  const task = await readTaskInput()
  if (task.project !== PROJECT) throw new Error('task_bootstrap_wrong_project')
  if (task.id !== undefined && task.id !== null) throw new Error('task_bootstrap_existing_id_rejected')

  const db = createDatabase(databasePath)
  try {
    const result = db.registerTaskAtCurrentGeneration({
      task,
      authorizationRef: options['authorization-ref'],
      idempotencyKey: options['idempotency-key'],
      expectedGeneration
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally { db.close() }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(JSON.stringify({ error: { code: error.message, message: error.message } }) + '\n')
  process.exitCode = 2
})

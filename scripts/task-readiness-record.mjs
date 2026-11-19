#!/usr/bin/env node
// Local-only CLI for auditable swarm-plan-v1 task readiness recording. No provider, network, or lease calls.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import {
  SWARM_PLAN_VERSION,
  computeReadinessFingerprint,
  validateSwarmPlanRecord
} from '../apps/api/src/db/taskReadiness.js'

const args = process.argv.slice(2)

function opt(name, fallback = null) {
  const idx = args.indexOf(`--${name}`)
  return idx < 0 ? fallback : (args[idx + 1] ?? fallback)
}

function hasFlag(name) {
  return args.includes(`--${name}`)
}

function required(name) {
  const value = opt(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function readCurrentAnchors(db) {
  const rows = db.db.prepare(
    'SELECT id AS repositoryId, name, root_path AS rootPath FROM repositories WHERE id IN (1, 4) ORDER BY id'
  ).all()
  return rows.map((repo) => ({
    repositoryId: repo.repositoryId,
    name: repo.name,
    rootPath: repo.rootPath,
    branch: execFileSync('git', ['-C', repo.rootPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
    headCommit: execFileSync('git', ['-C', repo.rootPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  }))
}

const dbPath = opt('db', undefined)
const db = dbPath ? createDatabase(dbPath) : createDatabase()

try {
  const taskId = Number(required('task-id'))
  const expectedUpdatedAt = required('expected-updated-at')
  const idempotencyKey = required('idempotency-key')
  const actor = opt('actor', 'operator')
  const planFile = resolve(required('plan-file'))
  const baseDir = opt('base-dir', dirname(planFile))
  const dryRun = hasFlag('dry-run')

  let plan
  try {
    plan = JSON.parse(readFileSync(planFile, 'utf8'))
  } catch (err) {
    throw new Error(`task_readiness_plan_json_invalid:${err.message}`)
  }

  const currentAnchors = readCurrentAnchors(db)

  if (dryRun) {
    const summary = validateSwarmPlanRecord(plan, { currentAnchors, baseDir })
    const payloadHash = computeReadinessFingerprint({ taskId, actor, plan })
    const normalizedKey = idempotencyKey.trim()
    const eventField = `${SWARM_PLAN_VERSION}:${normalizedKey}`
    const existingEvent = db.db.prepare(`
      SELECT id, new_value
      FROM task_events
      WHERE task_id = ? AND action = 'readiness_recorded' AND field = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(taskId, eventField)

    let wouldReplay = false
    if (existingEvent) {
      let parsed = {}
      try {
        parsed = JSON.parse(existingEvent.new_value || '{}')
      } catch {
        parsed = {}
      }
      if (!parsed.payloadHash || parsed.payloadHash !== payloadHash) {
        throw new Error('task_readiness_idempotency_conflict')
      }
      wouldReplay = true
    } else {
      const task = db.db.prepare(
        'SELECT id, status, updated_at FROM tasks WHERE id = ?'
      ).get(taskId)
      if (!task) throw new Error('task_readiness_task_not_found')
      if (task.status !== 'blocked') throw new Error('task_readiness_task_not_blocked')
      if (task.updated_at !== expectedUpdatedAt) throw new Error('task_readiness_cas_conflict')
    }

    console.log(JSON.stringify({
      dryRun: true,
      valid: true,
      wouldReplay,
      taskId,
      expectedUpdatedAt,
      idempotencyKey: normalizedKey,
      payloadHash,
      actor,
      plan: summary,
      authorityGranted: false,
      leaseAcquired: false
    }, null, 2))
  } else {
    const result = db.recordTaskReadiness({
      taskId,
      expectedUpdatedAt,
      idempotencyKey,
      actor,
      plan,
      currentAnchors,
      baseDir
    })
    console.log(JSON.stringify(result, null, 2))
  }
} finally {
  db.close()
}

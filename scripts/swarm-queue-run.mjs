#!/usr/bin/env node
/**
 * SP-007 bounded-job round-robin queue runner.
 *
 * One bounded job per tick: read the queue, pick a task, execute exactly one job with a
 * timeout, atomically write the result, exit. The runner never holds a CLI open across
 * jobs, so a crash loses at most one bounded job.
 *
 * Publish is operator-gated: this runner never passes --allow-publish. A task reaching
 * publish stays in `ready_to_publish` until an operator acts.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  readQueue,
  readTask,
  writeTask,
  nextPendingJob,
  completeJob,
  selectNextTask,
  applyVerdict,
  queueStats,
  DEFAULT_JOB_TIMEOUT_MS
} from '../apps/api/src/toolchain/dispatch/job-queue.js'

const argv = process.argv.slice(2)
const opts = {}
const boolFlags = new Set(['json', 'dry-run', 'allow-publish', 'once'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const name = a.slice(2)
  if (boolFlags.has(name)) opts[name] = true
  else opts[name] = argv[++i]
}
const fail = (msg) => { process.stderr.write(`swarm-queue-run: ${msg}\n`); process.exit(1) }

const queueDir = opts['queue-dir'] ? resolve(opts['queue-dir']) : null
if (!queueDir) fail('missing --queue-dir <dir>')
const wrapper = opts.wrapper ? resolve(opts.wrapper) : resolve(process.cwd(), 'scripts/swarm-run.mjs')

function readVerdictFile(path) {
  if (!path || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Run one bounded job. Returns { status, result, reason }. */
function runJob({ job, task, ctx }) {
  return new Promise((resolvePromise) => {
    if (job.type === 'review') {
      // Review is executed by the Parent between ticks, not by this runner.
      const verdict = readVerdictFile(opts['verdict-file'])
      if (!verdict || !['ACCEPT', 'REJECT'].includes(String(verdict.verdict || '').toUpperCase())) {
        return resolvePromise({ status: 'pending', reason: 'awaiting_review' })
      }
      return resolvePromise({ status: 'done', result: { verdict: String(verdict.verdict).toUpperCase(), reason: verdict.reason ?? null, reviewedAt: verdict.reviewedAt ?? null } })
    }

    const args = [
      wrapper,
      '--session-policy', 'pinned',
      '--work-item', task.taskId,
      '--repository', opts.repository || 'multi-project-workspace',
      '--state-dir', opts['state-dir'] || queueDir,
      '--json'
    ]
    if (job.type === 'plan') {
      args.push('--plan-cli', ctx.cli, '--plan-model', ctx.model, '--plan-prompt', ctx.prompt || `plan ${task.taskId}`)
    } else if (job.type === 'build') {
      args.push('--build-cli', ctx.cli, '--build-model', ctx.model, '--build-prompt', ctx.prompt || `build ${task.taskId}`)
    } else if (job.type === 'publish') {
      // Operator gate: publish is never auto-authorized.
      return resolvePromise({ status: 'skipped', reason: 'publish_requires_operator_authorization' })
    }
    if (opts['allow-publish']) args.push('--allow-publish')
    if (opts['dry-run']) args.push('--dry-run')

    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (status, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ status, result: { stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) }, reason })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000)
      finish('failed', `job_timeout:${job.timeoutMs}`)
    }, job.timeoutMs || DEFAULT_JOB_TIMEOUT_MS[job.type] || 180000)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => finish('failed', `spawn_error:${err.message}`))
    child.on('close', (code) => {
      if (code === 0) return finish('done', null)
      if (code === 3) return finish('failed', 'job_deferred')
      if (code === 2) return finish('failed', 'job_blocked')
      finish('failed', `exit_${code}`)
    })
  })
}

async function main() {
  const tasks = readQueue(queueDir)
  const lastUsedByPool = {}
  for (const t of tasks) {
    if (t.pinned?.compositeKey) {
      const pool = t.pinned.compositeKey.split(':')[0]
      lastUsedByPool[pool] = Math.max(lastUsedByPool[pool] || 0, t.queue?.revision || 0)
    }
  }
  const task = selectNextTask(tasks, { lastUsedByPool })
  if (!task) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ tick: 'idle', stats: queueStats(queueDir) }, null, 2)}\n`)
    else process.stdout.write('queue: idle\n')
    return process.exit(0)
  }

  const job = nextPendingJob(task)
  if (!job) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ tick: 'awaiting_review', taskId: task.taskId }, null, 2)}\n`)
    return process.exit(0)
  }

  const ctx = {
    cli: opts.cli || task.pinned?.cli || 'agy',
    model: opts.model || task.pinned?.model || '',
    prompt: opts.prompt || ''
  }

  const outcome = await runJob({ job, task, ctx })

  let next = task
  if (outcome.status === 'done') {
    const state = job.type === 'plan' ? 'review_plan' : job.type === 'build' ? 'review_build' : task.state
    next = completeJob(task, job.id, { status: 'done', result: outcome.result, state })
  } else if (outcome.status === 'pending') {
    next = { ...task, state: task.state }
  } else if (outcome.status === 'skipped') {
    next = completeJob(task, job.id, { status: 'skipped', result: outcome.result, reason: outcome.reason, state: 'ready_to_publish' })
  } else {
    next = completeJob(task, job.id, { status: 'failed', result: outcome.result, reason: outcome.reason, state: 'parked' })
  }

  const written = writeTask(queueDir, next, { expectedRevision: task.queue?.revision ?? null })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ tick: 'job', taskId: task.taskId, job: job.id, type: job.type, status: outcome.status, reason: outcome.reason, state: written.state, revision: written.queue.revision }, null, 2)}\n`)
  } else {
    process.stdout.write(`${task.taskId} ${job.type} -> ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} [${written.state}]\n`)
  }
  process.exit(outcome.status === 'failed' ? 1 : 0)
}

main()

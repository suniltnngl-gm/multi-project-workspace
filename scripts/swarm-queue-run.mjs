#!/usr/bin/env node
/**
 * SP-007 bounded-job round-robin queue runner.
 *
 * One bounded job per tick: read the queue, pick a task, execute exactly one job with a
 * timeout, atomically write the result, exit. The runner never holds a CLI open across
 * jobs, so a crash loses at most one bounded job.
 *
 * Publish is gated by default: unattended swarm-overnight never passes --allow-publish.
 * Explicit operator/parent runs may pass --allow-publish once checkpointed + reviewed + green CI.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { statePaths } from './swarm-state-paths.mjs'
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
  DEFAULT_JOB_TIMEOUT_MS,
  shouldHarvestTimeoutArtifact
} from '../apps/api/src/toolchain/dispatch/job-queue.js'
import { evaluateFiveHourCap } from '../apps/api/src/toolchain/dispatch/burn-rate-pacer.js'
import { createLeaseStore } from '../apps/api/src/toolchain/dispatch/lease-store.js'
import { acquireOrchestratorLock, releaseOrchestratorLock } from './swarm-orchestrator-lock.mjs'

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
    if (opts.registry) args.push('--registry', resolve(opts.registry))
    if (job.type === 'plan') {
      args.push('--plan-cli', ctx.cli, '--plan-model', ctx.model, '--plan-prompt', ctx.prompt || `plan ${task.taskId}`)
      if (ctx.provider) args.push('--plan-provider', ctx.provider)
    } else if (job.type === 'build') {
      args.push('--build-cli', ctx.cli, '--build-model', ctx.model, '--build-prompt', ctx.prompt || `build ${task.taskId}`)
      if (ctx.provider) args.push('--build-provider', ctx.provider)
    } else if (job.type === 'publish') {
      if (!opts['allow-publish']) {
        return resolvePromise({ status: 'skipped', reason: 'publish_requires_operator_authorization' })
      }
    }
    if (opts['allow-publish']) args.push('--allow-publish')
    if (opts['dry-run']) args.push('--dry-run')
    else args.push('--execute')

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true, // own process group, so a timeout can reap the whole CLI tree
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const jobTimeoutMs = job.timeoutMs || DEFAULT_JOB_TIMEOUT_MS[job.type] || 180000
    const killTree = (signal) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal); return } catch {}
      try { child.kill(signal) } catch {}
    }
    const finish = (status, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ status, result: { stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) }, reason })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      const hardKill = setTimeout(() => killTree('SIGKILL'), 5000)
      const giveUp = setTimeout(() => {
        clearTimeout(hardKill)
        finish('failed', `job_timeout:${jobTimeoutMs}`)
      }, 6000)
      child.once('close', () => {
        clearTimeout(hardKill)
        clearTimeout(giveUp)
      })
    }, jobTimeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => finish('failed', `spawn_error:${err.message}`))
    child.on('close', (code) => {
      if (timedOut) return finish('failed', `job_timeout:${jobTimeoutMs}`)
      if (code === 0) return finish('done', null)
      if (code === 3) return finish('failed', 'job_deferred')
      if (code === 2) return finish('failed', 'job_blocked')
      finish('failed', `exit_${code}`)
    })
  })
}

async function main() {
  // Reap runs/slots left behind by dead pids before starting a new bounded job.
  const leaseStateDir = opts['state-dir'] ? resolve(opts['state-dir']) : queueDir
  try {
    createLeaseStore({ stateDir: leaseStateDir }).reap()
  } catch (err) {
    process.stderr.write(`swarm-queue-run: reap warn: ${err?.message || err}\n`)
  }
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

  const quotaPool = opts['quota-pool'] || task.pinned?.compositeKey?.split(':')[0] || null
  if (quotaPool) {
    const callsInWindow = Number(opts['calls-in-window'] ?? 0)
    const capCheck = evaluateFiveHourCap({ quotaPool, callsInWindow })
    if (!capCheck.admitted) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ tick: 'deferred_5h_cap', taskId: task.taskId, ...capCheck }, null, 2)}\n`)
      else process.stdout.write(`${task.taskId} deferred (${capCheck.reason}: ${quotaPool} ${callsInWindow}/${capCheck.cap})\n`)
      return process.exit(0)
    }
  }

  // MC-206-LOCK-SCOPE: the shared orchestrator lease fences every mutating
  // entrypoint. A queue-run spawned by overnight inherits the parent's lease via
  // SWARM_ORCHESTRATOR_LEASE_PARENT instead of re-acquiring (no self-deadlock).
  const parentLeaseRunId = process.env.SWARM_ORCHESTRATOR_LEASE_PARENT || null
  const orchRunId = `queue-run-${process.pid}-${Date.now()}`
  let orchLease = null
  if (!parentLeaseRunId) {
    const orchRes = acquireOrchestratorLock({
      stateDir: statePaths().root,
      runId: orchRunId,
      resource: 'orchestrator',
      holder: 'swarm-queue-run',
      auditDir: statePaths().root
    })
    if (!orchRes.ok) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ tick: 'deferred_orchestrator_lease', resource: 'orchestrator', reason: orchRes.reason, holder: orchRes.holder, runId: orchRes.runId }, null, 2)}\n`)
      } else {
        process.stderr.write(`swarm-queue-run: ${orchRes.reason}: orchestrator held by ${orchRes.holder}\n`)
      }
      process.exit(3)
    }
    orchLease = orchRes
  }
  const releaseOrchestrator = () => {
    if (!orchLease) return
    try {
      releaseOrchestratorLock({
        stateDir: statePaths().root, runId: orchRunId, generation: orchLease.lock.generation, resource: 'orchestrator'
      })
    } catch { /* already released */ }
    orchLease = null
  }
  if (orchLease) {
    process.on('exit', releaseOrchestrator)
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseOrchestrator(); process.exit(130) })
  }

  // #216: this runner mutates the job queue and drives pool spend, so it must hold the
  // quota-ledger lease for the duration of the bounded job. A live holder fails closed.
  const ledgerRunId = `queue-run-${process.pid}-${Date.now()}`
  const ledgerRes = acquireOrchestratorLock({
    stateDir: leaseStateDir,
    runId: ledgerRunId,
    resource: 'quota-ledger',
    holder: 'swarm-queue-run',
    auditDir: statePaths().root
  })
  if (!ledgerRes.ok) {
    releaseOrchestrator()
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ tick: 'deferred_orchestrator_lease', resource: 'quota-ledger', reason: ledgerRes.reason, holder: ledgerRes.holder, runId: ledgerRes.runId }, null, 2)}\n`)
    } else {
      process.stderr.write(`swarm-queue-run: ${ledgerRes.reason}: quota-ledger held by ${ledgerRes.holder}\n`)
    }
    process.exit(3)
  }
  const releaseLedger = () => {
    try {
      releaseOrchestratorLock({
        stateDir: leaseStateDir, runId: ledgerRunId, generation: ledgerRes.lock.generation, resource: 'quota-ledger'
      })
    } catch { /* already released */ }
  }
  process.on('exit', releaseLedger)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLedger(); process.exit(130) })

  const ctx = {
    cli: opts.cli || task.pinned?.cli || 'opencode',
    model: opts.model || task.pinned?.model || 'opencode/deepseek-v4.1-flash-free',
    provider: opts.provider || task.pinned?.provider || 'opencode',
    prompt: opts.prompt || task.title || ''
  }

  const jobStartedAtMs = Date.now()
  let outcome
  try {
    outcome = await runJob({ job, task, ctx })
  } finally {
    releaseLedger()
  }

  // Case resolution (harvest-verified-artifact): if a plan job timed out after writing a fresh,
  // valid checkpoint plan (>=200 bytes and mtime >= jobStartedAtMs), harvest it.
  if (outcome.status === 'failed' && String(outcome.reason || '').startsWith('job_timeout:') && job.type === 'plan') {
    const planDoc = resolve(process.cwd(), 'docs/checkpoints', `${task.taskId.toUpperCase()}-plan.md`)
    const check = shouldHarvestTimeoutArtifact({ planDocPath: planDoc, jobStartedAtMs, minBytes: 200 })
    if (check.harvest) {
      outcome = {
        status: 'done',
        reason: 'harvested_post_timeout_artifact',
        result: { ...outcome.result, harvestedArtifact: planDoc, harvestedBytes: check.bytes }
      }
    }
  }

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

#!/usr/bin/env node
/**
 * Operator surface for resource-scoped orchestrator leases (#209).
 *
 * Subcommands:
 *   status   [--state-dir <dir>] [--resource <name>]   Inspect one or all leases
 *   reclaim  --resource <name> [--state-dir <dir>]     Reclaim an expired+dead lease
 *
 * `reclaim` applies the same rule as automatic reclamation (expired AND dead holder
 * PID). A live holder is never preempted: the command exits 2 with the reason instead.
 * Default state dir: ~/.local/state/curl-ai-bridge/overnight
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statePaths } from './swarm-state-paths.mjs'
import {
  DEFAULT_ORCHESTRATOR_RESOURCE,
  orchestratorLockPath,
  reclaimExpiredOrchestratorLock
} from './swarm-orchestrator-lock.mjs'

const KNOWN_RESOURCES = ['orchestrator', 'relay-ring', 'quota-ledger']

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, stateDir: statePaths().overnightDir, resource: null }
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--state-dir') options.stateDir = rest[++i]
    else if (a === '--resource') options.resource = rest[++i]
    else throw new Error(`unexpected_argument:${a}`)
  }
  return options
}

function readIfPresent(dir, resource) {
  const path = orchestratorLockPath(dir, { resource })
  if (!existsSync(path)) return { resource, path, present: false }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    return { resource, path, present: true, holder: doc.holder, runId: doc.runId, pid: doc.pid, generation: doc.generation, expiresAt: doc.expiresAt, renewedAt: doc.renewedAt ?? null }
  } catch (err) {
    return { resource, path, present: true, unreadable: err.message }
  }
}

const options = parseArgs(process.argv.slice(2))

if (options.command === 'status') {
  const resources = options.resource ? [options.resource] : KNOWN_RESOURCES
  const rows = resources.map((r) => readIfPresent(options.stateDir, r))
  process.stdout.write(`${JSON.stringify({ ok: true, mode: 'status', stateDir: options.stateDir, leases: rows }, null, 2)}\n`)
  process.exit(0)
}

if (options.command === 'reclaim') {
  const resource = options.resource || DEFAULT_ORCHESTRATOR_RESOURCE
  const res = reclaimExpiredOrchestratorLock({ stateDir: options.stateDir, resource })
  process.stdout.write(`${JSON.stringify({ ...res, mode: 'reclaim', resource, stateDir: options.stateDir }, null, 2)}\n`)
  process.exit(res.ok ? 0 : 2)
}

process.stderr.write('usage: swarm-lease.mjs status [--state-dir <dir>] [--resource <name>]\n')
process.stderr.write('       swarm-lease.mjs reclaim --resource <name> [--state-dir <dir>]\n')
process.exit(64)

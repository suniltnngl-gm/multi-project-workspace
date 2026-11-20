#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  exitCodeForPlans,
  planParallelBatch,
  resolveDispatchTarget
} from '../apps/api/src/toolchain/dispatch/session-pool-dispatcher.js'
import { parseIsoStrict } from '../apps/api/src/toolchain/dispatch/portability.js'

const argv = process.argv.slice(2)
const opts = {}
const flags = new Set(['json', 'force-retry'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const name = a.slice(2)
  if (flags.has(name)) opts[name] = true
  else opts[name] = argv[++i]
}
const list = (v) => (v ? String(v).split(',').filter(Boolean) : [])
const fail = (msg) => {
  process.stderr.write(`swarm-session-plan: ${msg}\n`)
  process.exit(1)
}
// Tolerates CRLF and a UTF-8 BOM.
const readJson = (p) => JSON.parse(readFileSync(resolve(p), 'utf8').replace(/^\uFEFF/, ''))

let nowFn
if (opts.now !== undefined) {
  const t = parseIsoStrict(opts.now)
  if (t === null) fail(`--now must be an ISO-8601 timestamp with Z or offset, got: ${opts.now}`)
  nowFn = () => t
}

let sessions = []
let quotaObservations = []
let providerObservations = []
let leases = []
let inFlight = []
let poolUsage = []
let fallbackCandidates = list(opts['fallback-model']).map((model) => ({ model }))
try {
  if (opts.registry) {
    const parsed = readJson(opts.registry)
    sessions = Array.isArray(parsed) ? parsed : parsed.sessions || []
    if (!Array.isArray(parsed)) {
      quotaObservations = parsed.quotaObservations || []
      providerObservations = parsed.providerObservations || []
      leases = parsed.leases || []
      inFlight = parsed.inFlight || []
      poolUsage = parsed.poolUsage || []
    }
  }
  const arr = (p, key) => { const v = readJson(p); return Array.isArray(v) ? v : v[key] || [] }
  if (opts['quota-observations']) quotaObservations = arr(opts['quota-observations'], 'quotaObservations')
  if (opts['provider-observations']) providerObservations = arr(opts['provider-observations'], 'providerObservations')
  if (opts.leases) leases = arr(opts.leases, 'leases')
  if (opts['in-flight']) inFlight = arr(opts['in-flight'], 'inFlight')
  if (opts['pool-usage']) poolUsage = arr(opts['pool-usage'], 'poolUsage')
  if (opts['fallback-candidates']) fallbackCandidates = arr(opts['fallback-candidates'], 'fallbackCandidates')
} catch (error) {
  fail(`cannot read input: ${error.message}`)
}

const request = {
  role: opts.role,
  repository: opts.repo,
  workItem: opts['work-item'],
  cli: opts.cli,
  model: opts.model,
  gateway: opts.gateway,
  provider: opts.provider,
  quotaPool: opts['quota-pool'],
  dispatchMode: opts['dispatch-mode'],
  forceRetry: opts['force-retry'] === true
}
const shared = {
  sessions,
  unavailableModels: list(opts['unavailable-model']),
  fallbackCandidates,
  quotaObservations,
  providerObservations,
  leases,
  inFlight,
  poolUsage,
  ...(nowFn ? { now: nowFn } : {})
}

let result
try {
  if (opts.batch) {
    const requests = readJson(opts.batch)
    result = planParallelBatch({ ...shared, requests: Array.isArray(requests) ? requests : requests.requests || [], request })
  } else {
    result = resolveDispatchTarget({ ...shared, request, schemaVersion: opts['schema-version'] })
  }
} catch (error) {
  fail(error.message)
}

const plans = Array.isArray(result) ? result : [result]
if (opts.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else {
  const out = []
  for (const plan of plans) {
    const s = plan.selectedSession
    out.push(
      `Session Pool Plan (${plan.schemaVersion}, read-only)`,
      `action=${plan.action} fallbackUsed=${plan.fallbackUsed} routingKey=${plan.routingKey}`,
      s ? `session=${s.compositeKey ?? '(new)'} model=${s.model} pool=${s.quotaPool} cache=${s.cacheState}` : 'session=none',
      ...(plan.nextEligibleAt ? [`nextEligibleAt=${plan.nextEligibleAt}`] : []),
      `reasons: ${plan.reasons.join(', ')}`
    )
  }
  process.stdout.write(`${out.join('\n')}\n`)
}
// Exit codes: 0 ok, 2 any blocked, 3 any deferred/await_in_flight (blocked outranks deferred).
process.exit(exitCodeForPlans(plans))

#!/usr/bin/env node
/**
 * SP-005 swarm-run.mjs — trio gate orchestrator on Path A.
 *
 * Composes existing SP-003/SP-004 primitives. Adds three operator-granted guardrails:
 *   1. Fail-closed review verdict parsing (unparseable -> REJECT).
 *   2. Wrapper-enforced publish stop-gate (never auto-publishes).
 *   3. Auto-wired stateDir (snapshot + readObservations), registry-derived fallback
 *      candidates, and explicit quotaPool attribution (never silently 'agy').
 *
 * Frozen contracts respected: session-pool-dispatch v1.0/v1.1, dispatch-execution.v1.
 * cliArtifactBoundary.mergeNativeArtifacts stays false (enforced by the adapter).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  resolveDispatchTarget,
  exitCodeForPlans
} from '../apps/api/src/toolchain/dispatch/session-pool-dispatcher.js'
import { createLeaseStore, resolveDispatchStateDir } from '../apps/api/src/toolchain/dispatch/lease-store.js'
import { normalizeExecutionRequest } from '../apps/api/src/toolchain/dispatch/execution-request-adapter.js'
import { runDispatch } from '../apps/api/src/toolchain/dispatch/dispatch-executor.js'
import { resolveGateConfig, evaluateResourceGate } from '../apps/api/src/toolchain/dispatch/resource-gate.js'
import { gatherTelemetry } from '../apps/api/src/toolchain/dispatch/host-telemetry.js'
import { parseIsoStrict } from '../apps/api/src/toolchain/dispatch/portability.js'

const argv = process.argv.slice(2)
const opts = {}
const boolFlags = new Set(['json', 'execute', 'dry-run', 'allow-publish', 'force-retry'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const name = a.slice(2)
  if (boolFlags.has(name)) opts[name] = true
  else opts[name] = argv[++i]
}
const fail = (msg) => {
  process.stderr.write(`swarm-run: ${msg}\n`)
  process.exit(1)
}
const readJson = (p) => JSON.parse(readFileSync(resolve(p), 'utf8').replace(/^\uFEFF/, ''))

const GATES = [
  { key: 'plan', role: 'planner', fallbackRole: 'planner-fallback-secondary' },
  { key: 'build', role: 'builder', fallbackRole: 'builder+worker-fallback' }
]

const SESSION_POLICIES = new Set(['per-gate', 'pinned'])
const MAX_CONSECUTIVE_REJECTIONS = 2
// Upstream failures that invalidate the pinned session rather than merely rejecting a checkpoint.
const ROTATION_ERROR_PATTERN = /\b(429|503)\b|rate.?limit|exhaust|resource_exhausted|overloaded/i

// ---- Guardrail 3a: registry-derived sessions + fallback candidates -------------------
function loadRegistry(registryPath) {
  const parsed = readJson(registryPath)
  const sessions = Array.isArray(parsed) ? parsed : parsed.sessions || []
  const resumable = sessions.filter((s) => s && s.sessionId)
  const fallbackCandidates = sessions
    .filter((s) => String(s.role || '').includes('fallback') && s.model && s.sessionId)
    .map((s) => ({
      model: s.model,
      quotaPool: s.cli,
      provider: s.provider ?? null,
      gateway: s.gateway ?? null,
      sessionId: s.sessionId ?? s.session_id ?? null
    }))
  return {
    sessions: resumable,
    fallbackCandidates,
    quotaObservations: Array.isArray(parsed) ? [] : parsed.quotaObservations || [],
    providerObservations: Array.isArray(parsed) ? [] : parsed.providerObservations || []
  }
}

// ---- Guardrail 3b: explicit quotaPool attribution ------------------------------------
// Never silently attribute work to the coarse 'agy' pool when the model belongs to a
// finer-grained pool. Resolve from the registry session when the caller omits --quota-pool.
function resolveQuotaPool({ quotaPoolArg, role, cli, model, sessions }) {
  if (quotaPoolArg) return { pool: quotaPoolArg, source: 'explicit' }
  // Prefer a session bound to the requested role, then cli+model, then cli alone.
  const byRole = sessions.find((s) => s.role === role && s.quotaPool)
  if (byRole) return { pool: byRole.quotaPool, source: 'registry' }
  const byCliModel = sessions.find((s) => s.cli === cli && s.model === model && s.quotaPool)
  if (byCliModel) return { pool: byCliModel.quotaPool, source: 'registry' }
  const byCli = sessions.find((s) => s.cli === cli && s.quotaPool)
  if (byCli) return { pool: byCli.quotaPool, source: 'registry' }
  return { pool: null, source: 'unresolved' }
}

// ---- Guardrail 1: fail-closed review verdict parsing ---------------------------------
// An unparseable, missing or ambiguous verdict is REJECT. Never default to ACCEPT.
// The verdict must be the only token on its line: a trailing word such as
// "VERDICT: ACCEPT REJECT" is ambiguous and rejects.
function parseVerdictText(text) {
  if (typeof text !== 'string' || !text.trim()) return { verdict: 'REJECT', reason: 'empty_review_output' }
  const matches = [...text.matchAll(/^\s*VERDICT\s*:\s*(ACCEPT|REJECT|DEFER)\s*$/gim)]
  if (matches.length !== 1) {
    const loose = [...text.matchAll(/\bVERDICT\s*:\s*(ACCEPT|REJECT|DEFER)\b/gi)]
    return { verdict: 'REJECT', reason: loose.length !== 1 ? `ambiguous_verdict_count:${loose.length}` : 'verdict_line_not_exclusive' }
  }
  const verdict = matches[0][1].toUpperCase()
  return { verdict, reason: null }
}

// Fail-closed wrapper around a review-output file.
function parseVerdict(text) {
  return parseVerdictText(text)
}

async function runGate({ gate, ctx, sessionPolicy, pinned }) {
  const { pool, source } = resolveQuotaPool({
    quotaPoolArg: opts['quota-pool'],
    role: gate.role,
    cli: gate.cli,
    model: gate.model,
    sessions: ctx.registry.sessions
  })
  if (!pool) {
    return { action: 'blocked', reasons: [`quota_pool_unresolved:${gate.cli}/${gate.model}`], poolSource: source }
  }

  // SP-006: in pinned mode, restrict the candidate pool to the pinned session so the
  // dispatcher cannot silently re-select a different one. The pin is by session identity,
  // not by role: the same worker owns plan, build and publish. Falls back to the full pool
  // only when the caller passes no pin (rotation already decided by the caller).
  const candidates = sessionPolicy === 'pinned' && pinned?.sessionId
    ? ctx.registry.sessions.filter((s) => s.sessionId === pinned.sessionId)
    : ctx.registry.sessions

  const plan = resolveDispatchTarget({
    schemaVersion: 'v1.1',
    sessions: candidates,
    fallbackCandidates: ctx.registry.fallbackCandidates,
    quotaObservations: ctx.observations.quotaObservations,
    providerObservations: [...ctx.registry.providerObservations, ...ctx.observations.providerObservations],
    leases: ctx.observations.leases,
    inFlight: ctx.observations.inFlight,
    poolUsage: ctx.observations.poolUsage,
    unavailableModels: [],
    request: {
      // Pinned mode: the pinned session's own role/model/cli govern, so the same worker
      // can carry plan, build and publish. per-gate mode: the caller's role/model apply.
      role: sessionPolicy === 'pinned' && pinned ? (pinned.role ?? gate.role) : gate.role,
      repository: opts.repository,
      workItem: opts['work-item'],
      cli: sessionPolicy === 'pinned' && pinned ? (pinned.cli ?? gate.cli) : gate.cli,
      model: sessionPolicy === 'pinned' && pinned ? (pinned.model ?? gate.model) : gate.model,
      quotaPool: pool,
      // pinned -> round-robin across independent pools; per-gate -> SP-005 fallback behaviour
      dispatchMode: sessionPolicy === 'pinned' ? 'round-robin' : 'fallback',
      forceRetry: opts['force-retry'] === true
    }
  })

  if (plan.action === 'blocked' || plan.action === 'deferred' || plan.action === 'await_in_flight') {
    return { ...plan, poolSource: source, pool }
  }

  const normalized = normalizeExecutionRequest(plan, { prompt: gate.prompt, cwd: opts.cwd || process.cwd() })
  if (!normalized.executable) {
    return { ...normalized.record, poolSource: source, pool }
  }

  const dry = await runDispatch({
    plan: normalized.plan,
    mode: 'dry-run',
    store: ctx.store,
    gate: ctx.gate,
    telemetry: ctx.telemetry,
    now: ctx.now
  })
  if (dry.gate?.verdict === 'deferred') {
    return { action: 'deferred', reasons: [dry.gate.primaryReason || 'resource_gate'], nextEligibleAt: dry.gate.nextEligibleAt, poolSource: source, pool }
  }

  const executed = await runDispatch({
    plan: normalized.plan,
    mode: opts.execute ? 'execute' : 'dry-run',
    store: ctx.store,
    gate: ctx.gate,
    telemetry: ctx.telemetry,
    now: ctx.now
  })

  const verdict = parseVerdictText(gate.verdictText)
  return { ...executed, plan, poolSource: source, pool, verdict: verdict.verdict, verdictReason: verdict.reason }
}

async function main() {
  if (!opts.registry) fail('missing --registry <agy-sessions.json>')
  if (!opts.repository) fail('missing --repository <name>')
  if (!opts['work-item']) fail('missing --work-item <id>')

  const stateDir = opts['state-dir'] || resolveDispatchStateDir({ env: process.env })
  const now = opts.now ? (() => parseIsoStrict(opts.now)) : (() => Date.now())
  if (opts.now && now() === null) fail(`--now must be ISO-8601 with Z or offset, got: ${opts.now}`)

  const store = createLeaseStore({ stateDir, now })
  const snapshot = store.snapshot()
  const providerObservations = store.readObservations()
  const gate = { evaluateResourceGate: (params) => evaluateResourceGate({ ...params, config: resolveGateConfig({ env: process.env }) }) }

  const registry = loadRegistry(opts.registry)
  // SP-006 decision 4: derive poolUsage from stateDir runs + registry, no new state file.
  // Shape required by resolveV11: [{ quotaPool, lastUsedAt }].
  const poolUsage = Object.entries(
    (snapshot.inFlight || []).reduce((acc, f) => {
      const ck = f?.compositeKey
      if (!ck) return acc
      const sid = ck.includes(':') ? ck.slice(ck.indexOf(':') + 1) : null
      const match = registry.sessions.find((s) => s.sessionId && ck.includes(s.sessionId))
      const qp = match?.quotaPool
      if (!qp) return acc
      const at = f?.startedAt ?? null
      if (!acc[qp] || (at && acc[qp] < at)) acc[qp] = at
      return acc
    }, {})
  ).map(([quotaPool, lastUsedAt]) => ({ quotaPool, lastUsedAt }))

  const ctx = {
    registry,
    observations: {
      leases: snapshot.leases || [],
      inFlight: snapshot.inFlight || [],
      // Registry quota observations must reach the dispatcher's v1.1 quota assessment.
      quotaObservations: registry.quotaObservations || [],
      providerObservations,
      poolUsage
    },
    store,
    gate,
    telemetry: gatherTelemetry(),
    now
  }

  const sessionPolicy = SESSION_POLICIES.has(opts['session-policy']) ? opts['session-policy'] : 'per-gate'
  if (opts['session-policy'] && !SESSION_POLICIES.has(opts['session-policy'])) {
    fail(`invalid --session-policy '${opts['session-policy']}' (expected per-gate or pinned)`)
  }

  const results = []
  // SP-006 pinning state. `pinned` is set once a gate produces a resumable session and is
  // held for subsequent gates; it is dropped on upstream failure or after 2 rejections.
  let pinned = null
  let consecutiveRejections = 0

  for (const gateDef of GATES) {
    const cli = opts[`${gateDef.key}-cli`]
    const model = opts[`${gateDef.key}-model`]
    const prompt = opts[`${gateDef.key}-prompt`]
    if (!cli || !model || !prompt) {
      results.push({ gate: gateDef.key, action: 'blocked', reasons: [`missing_gate_input:${gateDef.key}`] })
      continue
    }

    let outcome = await runGate({
      gate: { ...gateDef, cli, model, prompt, verdictText: opts[`${gateDef.key}-verdict`] },
      ctx, sessionPolicy, pinned
    })
    const gateName = gateDef.key
    let record = { ...outcome, gate: gateName, gateName, cli, model }
    if (!record.action) record.action = outcome.outcome ?? 'unknown'

    // Pin on the first gate that yields a resumable session.
    if (sessionPolicy === 'pinned' && !pinned && outcome.plan?.selectedSession?.sessionId) {
      const sel = outcome.plan.selectedSession
      pinned = { sessionId: sel.sessionId, compositeKey: sel.compositeKey, role: sel.role, cli: sel.cli, model: sel.model }
    }

    // Replan/rebuild loop: same pinned worker, bounded by MAX_CONSECUTIVE_REJECTIONS.
    // A missing verdict is fail-closed REJECT but is not a worker rejection: it must not
    // consume the rejection budget or trigger rotation.
    let attempts = 0
    while (sessionPolicy === 'pinned' && outcome.verdict === 'REJECT' && attempts < MAX_CONSECUTIVE_REJECTIONS) {
      const errText = JSON.stringify(outcome)
      if (ROTATION_ERROR_PATTERN.test(errText)) break
      if (outcome.verdictReason === 'empty_review_output' || outcome.verdictReason === 'no_review_output_supplied') break
      attempts += 1
      consecutiveRejections += 1
      outcome = await runGate({
        gate: { ...gateDef, cli, model, prompt, verdictText: opts[`${gateDef.key}-verdict`] },
        ctx, sessionPolicy, pinned
      })
      record = { ...outcome, gate: gateName, gateName, cli, model }
      if (!record.action) record.action = outcome.outcome ?? 'unknown'
    }

    // Rotate: drop the pin so the next gate selects from the full independent pool.
    if (sessionPolicy === 'pinned' && outcome.verdict === 'REJECT') {
      const errText = JSON.stringify(outcome)
      if (ROTATION_ERROR_PATTERN.test(errText) || consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
        pinned = null
        record.rotated = true
        record.rotationReason = ROTATION_ERROR_PATTERN.test(errText) ? 'upstream_failure' : `max_rejections:${MAX_CONSECUTIVE_REJECTIONS}`
      }
    }
    if (outcome.verdict !== 'REJECT') consecutiveRejections = 0

    record.attempts = attempts
    record.pinnedSessionId = pinned?.sessionId ?? null
    results.push(record)

    if (outcome.action === 'blocked' || outcome.action === 'deferred') break
    if (opts.execute && outcome.outcome && outcome.outcome !== 'succeeded') break
  }

  // Review gate: fail-closed. Only --review-output is trusted; a missing file is REJECT.
  let review = { verdict: 'REJECT', reason: 'no_review_output_supplied' }
  if (opts['review-output']) {
    try {
      review = parseVerdict(readFileSync(resolve(opts['review-output']), 'utf8'))
    } catch (e) {
      review = { verdict: 'REJECT', reason: `review_unreadable:${e.code || 'ERROR'}` }
    }
  }

  // Guardrail 2: publish stop-gate. Never publish without an explicit flag.
  const publishBlocked = !opts['allow-publish']
  const summary = {
    schemaVersion: 'swarm-run/v1',
    mode: opts.execute ? 'execute' : 'dry-run',
    sessionPolicy,
    pinnedSessionId: pinned?.sessionId ?? null,
    publish: {
      stopped: publishBlocked,
      authorized: opts['allow-publish'] === true,
      // Decision 3: stop-only by default. With --allow-publish the same pinned worker
      // performs the publish; the wrapper never publishes without it.
      executorSessionId: opts['allow-publish'] ? (pinned?.sessionId ?? null) : null
    },
    review,
    gates: results,
    stateDir
  }

  if (opts['out']) {
    mkdirSync(dirname(resolve(opts['out'])), { recursive: true })
    writeFileSync(resolve(opts['out']), JSON.stringify(summary, null, 2))
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else {
    for (const r of results) {
      process.stdout.write(`${r.gate}: action=${r.action} outcome=${r.outcome || '-'} pool=${r.pool || '-'} (${r.poolSource || '-'})\n`)
    }
    process.stdout.write(`review: ${review.verdict}${review.reason ? ` (${review.reason})` : ''}\n`)
    process.stdout.write(`publish: ${publishBlocked ? 'STOPPED (no --allow-publish)' : 'AUTHORIZED'}\n`)
  }

  const planExit = exitCodeForPlans(results.filter((r) => r.action))
  const reviewExit = review.verdict === 'ACCEPT' ? 0 : review.verdict === 'DEFER' ? 3 : 2
  process.exit(Math.max(planExit, reviewExit))
}

main()

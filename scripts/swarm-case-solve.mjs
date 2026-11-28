#!/usr/bin/env node
/**
 * Step 3 Offload: Autonomous Case Solver (`swarm case-solve`).
 *
 * Scans `queue/cases/*.json` for `state === "open_case"`.
 * - Pauses (tags `requiresOperator: true`) if resolving requires an unrecoverable mutation
 *   (billing/credits, force-push, reset --hard, destructive delete).
 * - Otherwise selects the highest-scoring verified option (or evaluates options via $0
 *   `swarm-direct.mjs --provider cloudflare`) and marks the case `resolved` when `--apply`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statePaths } from './swarm-state-paths.mjs'
import { acquireOrchestratorLock, releaseOrchestratorLock } from './swarm-orchestrator-lock.mjs'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { readCases, writeCase } from '../apps/api/src/toolchain/dispatch/case-registry.js'
import { classifyMutationRisk } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { simulateCaseOptions } from '../apps/api/src/toolchain/dispatch/case-sandbox.js'

const UNRECOVERABLE_RE = /\b(billing|fund|credits?|force[- ]?push|push\s+--force|reset\s+--hard|drop\s+table|gcloud\s+.*delete|rm\s+-rf)\b/i

export function isUnrecoverableOption(opt = {}) {
  const text = `${opt.id || ''} ${opt.label || ''} ${opt.notes || ''}`
  return UNRECOVERABLE_RE.test(text)
}

export function evaluateOpenCase(caseObj) {
  const options = Array.isArray(caseObj?.options) ? caseObj.options : []
  if (!options.length) return { action: 'skip', reason: 'no_options' }

  const safeOptions = options.filter((o) => !isUnrecoverableOption(o))
  if (!safeOptions.length) {
    return { action: 'pause_operator', reason: 'all_options_unrecoverable' }
  }

  // Score from findings if present, filtering out unrecoverable options
  const findings = caseObj?.findings && typeof caseObj.findings === 'object' ? caseObj.findings : {}
  let bestId = null
  let bestScore = -1
  for (const opt of safeOptions) {
    const f = findings[opt.id]
    const score = typeof f?.score === 'number' ? f.score : 50
    if (score > bestScore) {
      bestScore = score
      bestId = opt.id
    }
  }
  if (!bestId) bestId = safeOptions[0].id
  return {
    action: 'resolve',
    selectedOption: bestId,
    score: bestScore,
    reason: 'auto_resolved_highest_safe_option'
  }
}

/**
 * SOLVE-002: $0 default evidence runner. Discovery ranks options best-first, so a
 * safe option's heuristic score decays with its list position; existing findings
 * (recorded by a real sandbox run) always take precedence. Unrecoverable options
 * fail outright so the sandbox pauses instead of ever selecting them.
 */
function defaultEvidenceRunner() {
  return async ({ option, index }) => {
    const risk = classifyMutationRisk(`${option.label || ''} ${option.command || ''}`)
    if (!risk.allowed) return { ok: false, score: 0, notes: `unrecoverable:${risk.rule}` }
    return { ok: true, score: 55 - 5 * Number(index || 0), notes: 'heuristic_safe_option' }
  }
}

export async function solveOpenCases(caseDir, { apply = false, sandbox = false, minScoreMargin } = {}) {
  if (!caseDir || !existsSync(caseDir)) return { ok: true, apply, sandbox, sandboxEnabled: Boolean(sandbox), scanned: 0, resolved: [], paused: [] }
  const files = readdirSync(caseDir).filter((f) => f.endsWith('.json')).filter((f) => f !== 'seed.json').sort()
  const resolved = []
  const paused = []
  let scanned = 0

  const persistResolved = (c, decision, persist) => {
    resolved.push({ id: c.id, selectedOption: decision.selectedOption, score: decision.score })
    if (apply) {
      persist({
        ...c,
        state: 'resolved',
        selectedOption: decision.selectedOption,
        history: [
          ...(Array.isArray(c.history) ? c.history : []),
          { event: 'auto_resolved_by_swarm', selectedOption: decision.selectedOption, score: decision.score, at: new Date().toISOString() }
        ]
      })
    }
  }

  for (const f of files) {
    const fp = join(caseDir, f)
    let c
    try { c = JSON.parse(readFileSync(fp, 'utf8')) } catch { continue }
    if (c.state !== 'open_case') continue
    scanned += 1
    if (sandbox) {
      const verdict = await solveCaseWithSandbox(c, { minScoreMargin })
      if (verdict.action === 'select_winner') {
        persistResolved(verdict.caseRecord, { selectedOption: verdict.selectedOption, score: verdict.results?.find((r) => r.optionId === verdict.selectedOption)?.score ?? 50 }, (next) => protectedWriteFile(fp, `${JSON.stringify(next, null, 2)}\n`))
      } else {
        paused.push({ id: c.id, reason: verdict.reason })
        if (apply) protectedWriteFile(fp, `${JSON.stringify(verdict.caseRecord, null, 2)}\n`)
      }
      continue
    }
    const decision = evaluateOpenCase(c)
    if (decision.action === 'pause_operator') {
      paused.push({ id: c.id, reason: decision.reason })
      continue
    }
    if (decision.action === 'resolve') persistResolved(c, decision, (next) => protectedWriteFile(fp, `${JSON.stringify(next, null, 2)}\n`))
  }

  // Canonical sqlite case registry (skipped when legacy .json files coexist —
  // readCases refuses mixed dirs). Each record's payload is the case object.
  try {
    const registryCases = readCases(caseDir)
    for (const c of registryCases) {
      if (c.state !== 'open_case') continue
      scanned += 1
      if (sandbox) {
        const verdict = await solveCaseWithSandbox(c, { minScoreMargin })
        if (verdict.action === 'select_winner') {
          persistResolved(verdict.caseRecord, { selectedOption: verdict.selectedOption, score: verdict.results?.find((r) => r.optionId === verdict.selectedOption)?.score ?? 50 }, (next) => { writeCase(caseDir, next) })
        } else {
          paused.push({ id: c.id, reason: verdict.reason })
          if (apply) writeCase(caseDir, verdict.caseRecord)
        }
        continue
      }
      const decision = evaluateOpenCase(c)
      if (decision.action === 'pause_operator') {
        paused.push({ id: c.id, reason: decision.reason })
        continue
      }
      if (decision.action === 'resolve') persistResolved(c, decision, (next) => { writeCase(caseDir, next) })
    }
  } catch { /* legacy dir layout: the loose-file pass already covered it */ }

  return { ok: true, apply, sandbox, sandboxEnabled: Boolean(sandbox), scanned, resolvedCount: resolved.length, resolved, pausedCount: paused.length, paused }
}

/**
 * #244: Sandbox-backed open case solver (wires #243 `simulateCaseOptions` into W2 case-solve).
 * Runs candidate options in isolated temp sandboxes, auto-selecting a clear winner and
 * pausing/escalating only on all-fail, ambiguous tie, or unrecoverable risk.
 */
export async function solveCaseWithSandbox(caseObj, { runOption = null, minScoreMargin = 5 } = {}) {
  const runner = runOption || (async ({ option }) => {
    const f = caseObj?.findings?.[option.id]
    if (f && typeof f.score === 'number') {
      return { ok: f.ok !== false, score: f.score, notes: f.notes || 'from_existing_finding' }
    }
    // SOLVE-002 $0 heuristic evidence: discovery ranks options best-first, so the
    // heuristic score decays with list position; unrecoverable options fail outright.
    const risk = classifyMutationRisk(`${option.label || ''} ${option.command || ''}`)
    if (!risk.allowed) return { ok: false, score: 0, notes: `unrecoverable:${risk.rule}` }
    const idx = (caseObj?.options || []).findIndex((o) => o.id === option.id)
    return { ok: true, score: 55 - 5 * Math.max(0, idx), notes: 'heuristic_safe_option' }
  })
  return simulateCaseOptions(caseObj, { runOption: runner, minScoreMargin })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: swarm case-solve [--case-dir <dir>] [--sandbox] [--apply] [--json]')
    process.exit(0)
  }
  const flag = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb }
  const defaultDir = statePaths().casesDir
  const caseDir = resolve(flag('--case-dir', defaultDir))
  const apply = argv.includes('--apply')
  const useSandbox = argv.includes('--sandbox')
  // MC-206-LOCK-SCOPE: only --apply mutates the case registry, so only --apply takes
  // the shared orchestrator lease; dry-runs stay lease-free. Live holder -> exit 3.
  let solveLease = null
  const solveLeaseRunId = `case-solve-${process.pid}-${Date.now()}`
  if (apply) {
    const orchRes = acquireOrchestratorLock({
      stateDir: statePaths().root,
      runId: solveLeaseRunId,
      resource: 'orchestrator',
      holder: 'swarm-case-solve',
      auditDir: statePaths().root
    })
    if (!orchRes.ok) {
      process.stderr.write(`swarm case-solve: ${orchRes.reason}: orchestrator held by ${orchRes.holder} runId=${orchRes.runId}\n`)
      process.exit(3)
    }
    solveLease = orchRes
    process.on('exit', () => {
      try {
        releaseOrchestratorLock({ stateDir: statePaths().root, runId: solveLeaseRunId, generation: solveLease.lock.generation, resource: 'orchestrator' })
      } catch { /* already released */ }
    })
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
  }
  const res = await solveOpenCases(caseDir, { apply, sandbox: useSandbox })
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2))
  else console.log(`swarm case-solve (${apply ? 'apply' : 'dry-run'}): scanned=${res.scanned} resolved=${res.resolvedCount} paused=${res.pausedCount}`)
}

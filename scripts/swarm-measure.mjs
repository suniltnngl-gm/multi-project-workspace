#!/usr/bin/env node
/**
 * SOLVE-003-MEASURE — Measure phase of the Discover -> Decide -> Measure loop.
 *
 * For every resolved case: verify the decision against its recorded findings,
 * append a durable decision-outcome row to the measure ledger, and mark the
 * case history `measured_by_swarm` (idempotent — a measured case is skipped).
 * The same pass aggregates relay attempt telemetry (failureClass, #278) so
 * sibling health is measured alongside decision outcomes. Read-only by default;
 * --apply persists the ledger and case-history updates.
 *
 * Contract:
 *   - Dry-run reports what would be measured, persists nothing (ledgerPath null).
 *   - The ledger is append-only JSONL, one row per (caseId, decision) measurement.
 *   - Telemetry aggregation never throws: unreadable reports are skipped.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statePaths } from './swarm-state-paths.mjs'
import { readCases, readCase, writeCase } from '../apps/api/src/toolchain/dispatch/case-registry.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

export function measureLedgerPath(caseDir) {
  return join(resolve(caseDir, '..'), 'measurements', 'decision-outcomes.jsonl')
}

function readMeasuredCaseIds(ledgerPath) {
  const ids = new Set()
  if (!existsSync(ledgerPath)) return ids
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { ids.add(String(JSON.parse(t).caseId)) } catch { /* skip corrupt row */ }
  }
  return ids
}

export async function measureResolvedCases(caseDir, { apply = false } = {}) {
  if (!caseDir || !existsSync(caseDir)) {
    return { ok: true, apply, scannedCases: 0, measuredCount: 0, measured: [], ledgerPath: null }
  }
  const ledgerPath = measureLedgerPath(caseDir)
  const measuredCaseIds = apply ? readMeasuredCaseIds(ledgerPath) : new Set()
  const measured = []
  let scannedCases = 0
  let pausedCases = 0
  let openCases = 0

  const measureOne = (c, persist) => {
    scannedCases += 1
    if (c.state === 'open_case') openCases += 1
    if (c.state !== 'resolved') {
      if (c.state === 'paused_case' || (Array.isArray(c.history) && c.history.some((h) => h.event === 'pause_operator'))) pausedCases += 1
      return
    }
    if (measuredCaseIds.has(String(c.id))) return
    // Evidence check: the decision's recorded findings for the selected option.
    const finding = c.findings?.[c.selectedOption] || c.findings?.[String(c.selectedOption).replaceAll('-', '_')]
    const evidenceScore = typeof finding?.score === 'number' ? finding.score : null
    const evidenceOk = finding ? finding.ok !== false : null
    const row = {
      caseId: c.id,
      decision: 'resolved',
      selectedOption: c.selectedOption ?? null,
      evidenceScore,
      evidenceOk,
      evidenceSource: finding?.notes || 'no_recorded_finding',
      decisionAt: (Array.isArray(c.history) ? c.history.filter((h) => h.event === 'auto_resolved_by_swarm').pop()?.at : null) ?? null,
      measuredAt: new Date().toISOString()
    }
    measured.push(row)
    if (!apply) return
    mkdirSync(join(ledgerPath, '..'), { recursive: true, mode: 0o700 })
    appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    persist({
      ...c,
      history: [
        ...(Array.isArray(c.history) ? c.history : []),
        { event: 'measured_by_swarm', evidenceScore, evidenceOk, at: row.measuredAt }
      ]
    })
  }

  // Legacy loose-file cases.
  for (const f of existsSync(caseDir) ? readdirSync(caseDir).filter((x) => x.endsWith('.json')).filter((x) => x !== 'seed.json') : []) {
    const fp = join(caseDir, f)
    let c
    try { c = JSON.parse(readFileSync(fp, 'utf8')) } catch { continue }
    measureOne(c, (next) => protectedWriteFile(fp, `${JSON.stringify(next, null, 2)}\n`))
  }
  // Canonical sqlite registry.
  try {
    for (const c of readCases(caseDir)) {
      measureOne(c, (next) => { writeCase(caseDir, next) })
    }
  } catch { /* legacy layout or unreadable registry: loose-file pass covered it */ }

  return {
    ok: true,
    apply,
    scannedCases,
    openCases,
    pausedCases,
    measuredCount: measured.length,
    measured,
    ledgerPath: apply ? ledgerPath : null
  }
}

/** Sum the failureClass/ok distribution over relay-pipeline-*.json reports. Never throws per file. */
export function aggregateRelayTelemetry(reportsDir) {
  const agg = { attemptsTotal: 0, ok: 0, failureClasses: {}, missingTelemetryReports: 0 }
  if (!reportsDir || !existsSync(reportsDir)) return agg
  for (const f of readdirSync(reportsDir).filter((x) => x.startsWith('relay-pipeline-') && x.endsWith('.json'))) {
    let doc
    try { doc = JSON.parse(readFileSync(join(reportsDir, f), 'utf8')) } catch { continue }
    const windows = Array.isArray(doc?.windows) ? doc.windows : []
    let sawAttempt = false
    for (const w of windows) {
      for (const a of Array.isArray(w?.attemptedModels) ? w.attemptedModels : []) {
        sawAttempt = true
        agg.attemptsTotal += 1
        if (a.status === 'ok' || a.status === 'ok_no_findings') agg.ok += 1
        else if (a.failureClass) agg.failureClasses[a.failureClass] = (agg.failureClasses[a.failureClass] || 0) + 1
        else agg.failureClasses.unclassified = (agg.failureClasses.unclassified || 0) + 1
      }
    }
    if (!sawAttempt) agg.missingTelemetryReports += 1
  }
  return agg
}

function parseArgs(argv) {
  const opts = { apply: false, json: false, caseDir: null, stateDir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--json') opts.json = true
    else if (a === '--case-dir') opts.caseDir = resolve(argv[++i])
    else if (a === '--state-dir') opts.stateDir = resolve(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('Usage: swarm measure [--case-dir <dir>] [--apply] [--json]')
    process.exit(0)
  }
  const env = opts.stateDir ? { ...process.env, SWARM_STATE_DIR: opts.stateDir } : process.env
  const caseDir = opts.caseDir || statePaths(env).casesDir
  const decisions = await measureResolvedCases(caseDir, { apply: opts.apply })
  const telemetry = aggregateRelayTelemetry(statePaths(env).reportsDir)
  const out = {
    ok: true,
    mode: opts.apply ? 'apply' : 'dry-run',
    scannedCases: decisions.scannedCases,
    measuredCount: decisions.measuredCount,
    decisions: {
      scannedCases: decisions.scannedCases,
      openCases: decisions.openCases,
      pausedCases: decisions.pausedCases,
      measuredCount: decisions.measuredCount,
      measured: decisions.measured
    },
    telemetry,
    ledgerPath: decisions.ledgerPath
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2))
  else console.log(`swarm measure (${out.mode}): scanned=${decisions.scannedCases} measured=${decisions.measuredCount} attempts=${telemetry.attemptsTotal} -> ${decisions.ledgerPath || '(dry-run, no ledger)'}`)
  // Non-zero exit only on real problems; measurement is advisory.
}

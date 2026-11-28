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
import { RPM_THROTTLE_PATTERN, AUTH_FAILURE_PATTERN, TRANSIENT_PATTERN } from './swarm-relay.mjs'
import { readCases, readCase, writeCase } from '../apps/api/src/toolchain/dispatch/case-registry.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

export function measureLedgerPath(caseDir) {
  return join(resolve(caseDir, '..'), 'measurements', 'decision-outcomes.jsonl')
}

/**
 * W3 (#290): a measured reopen is a failed decision — emit it as a durable
 * LES-DECISION-* lesson so future Decide passes can penalize the failed option
 * class even with zero relay telemetry (cold-start). Append-only JSONL, 0600.
 */
export function recordReopenLesson(lessonsDir, row, caseObj, { now = () => new Date().toISOString() } = {}) {
  if (!lessonsDir) return null
  const lessonId = `LES-DECISION-${String(row.caseId).toUpperCase().replace(/[^A-Z0-9-]/g, '-')}-${String(row.selectedOption || 'na').toUpperCase().replace(/[^A-Z0-9-]/g, '-')}`
  const failedOption = (caseObj?.options || []).find((o) => o.id === row.selectedOption)
  const lesson = {
    lessonId,
    category: 'decision-reopen',
    caseId: row.caseId,
    failedOption: row.selectedOption,
    failedLabel: failedOption?.label || null,
    evidenceScore: row.evidenceScore,
    evidenceSource: row.evidenceSource,
    // Tags = failed-label word tokens (lowercase, >=4 chars), minus generic routing
    // words that appear in almost every option label ('route', 'via', ...) — a
    // tag must be distinctive enough to attribute a future option to the failure.
    tags: [...new Set(String(failedOption?.label || row.selectedOption || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || [])]
      .filter((t) => !['route', 'via', 'with', 'instead', 'retry', 'option', 'then', 'when', 'fallback'].includes(t)),
    recordedAt: now()
  }
  mkdirSync(lessonsDir, { recursive: true, mode: 0o700 })
  appendFileSync(join(lessonsDir, 'decision-lessons.jsonl'), `${JSON.stringify(lesson)}\n`, { mode: 0o600 })
  return lesson
}

/** Load all decision-reopen lessons ($0, tolerate corrupt lines). */
export function loadDecisionLessons(lessonsDir) {
  const path = join(lessonsDir || '', 'decision-lessons.jsonl')
  if (!lessonsDir || !existsSync(path)) return []
  const lessons = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { const j = JSON.parse(t); if (j?.category === 'decision-reopen') lessons.push(j) } catch {}
  }
  return lessons
}

/** W3 cold-start penalty: 15 per lesson whose tags overlap the option text (cap 30). */
export function decisionLessonPenalty(lessons, text, { maxPenalty = 30 } = {}) {
  const lower = String(text || '').toLowerCase()
  let penalty = 0
  for (const l of lessons) {
    for (const tag of l.tags || []) {
      if (lower.includes(tag)) {
        penalty += 15
        break
      }
    }
  }
  return Math.min(penalty, maxPenalty)
}

function measuredKey(row) {
  // A case may be resolved, measured, reopened, and re-resolved: the ledger key is
  // the (caseId, resolution instant) pair so each decision is measured exactly once.
  return `${row.caseId}|${row.decisionAt || ''}`
}

function readMeasuredKeys(ledgerPath) {
  const keys = new Set()
  if (!existsSync(ledgerPath)) return keys
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const row = JSON.parse(t)
      keys.add(`${row.caseId}|${row.decisionAt || ''}`)
    } catch { /* skip corrupt row */ }
  }
  return keys
}

export async function measureResolvedCases(caseDir, { apply = false, lessonsDir = statePaths().lessonsDir } = {}) {
  if (!caseDir || !existsSync(caseDir)) {
    return { ok: true, apply, scannedCases: 0, measuredCount: 0, measured: [], ledgerPath: null }
  }
  const ledgerPath = measureLedgerPath(caseDir)
  const measuredCaseIds = apply ? readMeasuredKeys(ledgerPath) : new Set()
  const measured = []
  let scannedCases = 0
  let pausedCases = 0
  let openCases = 0

  const measureOne = (c, persist) => {
    scannedCases += 1
    if (c.state === 'open_case') openCases += 1
    if (c.state === 'paused_case' || (Array.isArray(c.history) && c.history.some((h) => h.event === 'pause_operator'))) pausedCases += 1
    // #309: governed-registry cases reach 'decided' then 'closed'; both carry a
    // completed decision and both are measurable (only when a decision exists —
    // a closed/rejected case without one is not a measurable outcome).
    const measurable = c.state === 'resolved'
      || ((c.state === 'decided' || c.state === 'closed') && c.decision)
    if (!measurable) return
    const decisionAt = (Array.isArray(c.history) ? c.history.filter((h) => h.event === 'auto_resolved_by_swarm').pop()?.at : null)
      ?? c.decision?.decided_at ?? null
    if (measuredCaseIds.has(`${String(c.id)}|${decisionAt || ''}`)) return
    // Evidence check: the decision's recorded findings for the selected option.
    const finding = c.findings?.[c.selectedOption] || c.findings?.[String(c.selectedOption).replaceAll('-', '_')]
    const evidenceScore = typeof finding?.score === 'number' ? finding.score : null
    const evidenceOk = finding ? finding.ok !== false : null
    // #309 post-decision evidence capture: cases decided through the governed
    // sqlite registry carry no sandbox findings — their recorded evidence is
    // the decision rationale. Measure that instead of 'no_recorded_finding'.
    const selectedOption = c.selectedOption ?? c.decision?.selected_option ?? null
    let recordedEvidence = finding?.notes || null
    if (!recordedEvidence && c.decision && String(c.decision.selected_option || '') === String(selectedOption || '')) {
      let rationale = c.decision.decision_rationale || ''
      try { const j = JSON.parse(rationale); if (j && typeof j.rationale === 'string') rationale = j.rationale } catch { /* plain text rationale */ }
      if (String(rationale).trim()) recordedEvidence = `decision_rationale:${String(rationale).trim().slice(0, 300)}`
    }
    const row = {
      caseId: c.id,
      // SOLVE-004: a decision whose own evidence says it failed is measured as a
      // reopen — the case returns to open_case with the failing finding intact so
      // the next Decide pass decides on real evidence, not the heuristic.
      decision: evidenceOk === false ? 'reopen' : 'resolved',
      selectedOption: selectedOption ?? null,
      evidenceScore,
      evidenceOk,
      evidenceSource: recordedEvidence || 'no_recorded_finding',
      decisionAt: decisionAt ?? null,
      measuredAt: new Date().toISOString()
    }
    measured.push(row)
    if (!apply) return
    mkdirSync(join(ledgerPath, '..'), { recursive: true, mode: 0o700 })
    appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    if (row.decision === 'reopen') {
      // W3 (#290): the failed decision becomes a lesson for future Decide passes.
      try { recordReopenLesson(lessonsDir, row, c) } catch { /* lesson emission never blocks measure */ }
      persist({
        ...c,
        state: 'open_case',
        selectedOption: null,
        history: [
          ...(Array.isArray(c.history) ? c.history : []),
          { event: 'reopened_by_measurement', evidenceScore, evidenceOk, failedOption: c.selectedOption, at: row.measuredAt }
        ]
      })
      return
    }
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

/** Sibling pool tokens shared with case-solve's telemetry penalty (SOLVE-005). */
export const SIBLING_TOKENS = ['gemini-api', 'hermes', 'opencode', 'agy', 'copilot', 'cline', 'codex', 'vibe', 'direct']

/**
 * Sum the failureClass/ok distribution over relay-pipeline-*.json reports. Never throws per file.
 * failureClassesByToken attributes each failed attempt to any sibling token whose first
 * hyphen segment prefixes the model name (e.g. `gemini-api` matches `gemini-3.8-flash`),
 * so case-solve can penalize only the siblings that actually failed.
 */
export function aggregateRelayTelemetry(reportsDir) {
  const agg = { attemptsTotal: 0, ok: 0, failureClasses: {}, failureClassesByToken: {}, missingTelemetryReports: 0 }
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
        else if (a.failureClass) {
          agg.failureClasses[a.failureClass] = (agg.failureClasses[a.failureClass] || 0) + 1
          const model = String(a.model || '').toLowerCase()
          for (const token of SIBLING_TOKENS) {
            if (model.startsWith(token.split('-')[0])) {
              agg.failureClassesByToken[token] = (agg.failureClassesByToken[token] || 0) + 1
            }
          }
        } else {
          // #298: backfill legacy pre-#278 rows — classify from whatever evidence
          // the attempt still carries (status string + stderr tail) so the improve
          // loop sees real failure classes instead of an `unclassified` bucket.
          const evidence = `${a.status || ''}\n${a.stderrTail || a.error || ''}`
          let backfilled = null
          if (RPM_THROTTLE_PATTERN.test(evidence)) backfilled = 'rpm_throttled'
          else if (AUTH_FAILURE_PATTERN.test(evidence)) backfilled = 'auth_failure'
          else if (TRANSIENT_PATTERN.test(evidence)) backfilled = 'transient'
          // Legacy pre-#278 rows carry no output at all — only exit shape.
          else if (a.status === 'exit_null' || a.signal) backfilled = 'stall_killed'
          else if (/^exit_\d+$/.test(String(a.status))) backfilled = 'legacy_exit_failure'
          else if (a.status === 'cli_outcome_failed') backfilled = 'legacy_cli_outcome_failed'
          agg.failureClasses[backfilled || 'unclassified'] = (agg.failureClasses[backfilled || 'unclassified'] || 0) + 1
          if (backfilled) {
            const model = String(a.model || '').toLowerCase()
            for (const token of SIBLING_TOKENS) {
              if (model.startsWith(token.split('-')[0])) {
                agg.failureClassesByToken[token] = (agg.failureClassesByToken[token] || 0) + 1
              }
            }
          }
        }
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

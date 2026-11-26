/**
 * SWARM-CASE-SANDBOX-001 (#243) — Isolated Simulation Sandbox for Multi-Option Cases.
 *
 * Runs each candidate option of a multi-option case inside an isolated temp sandbox
 * directory, records objective `{ ok, score, latencyMs, sandboxType, notes }` findings
 * via `recordOptionFinding`, and determines whether a clear best option can be chosen
 * automatically — pausing for operator input ONLY when:
 *   1. No option passes (`no_passing_option`),
 *   2. Top passing options tie within `minScoreMargin` (`ambiguous_tie`), or
 *   3. Any option is classified as unrecoverable (`unrecoverable_option_detected`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyMutationRisk } from './mutation-guard.js'
import { recordOptionFinding } from './case-registry.js'

export const DEFAULT_MIN_SCORE_MARGIN = 5

/**
 * Evaluate all options of `caseRecord` inside isolated temp sandboxes using `runOption`.
 * `runOption({ option, sandboxDir, caseRecord })` returns `{ ok, score, notes }`.
 */
export async function simulateCaseOptions(caseRecord, {
  runOption,
  sandboxType = 'temp',
  minScoreMargin = DEFAULT_MIN_SCORE_MARGIN
} = {}) {
  if (!caseRecord || !Array.isArray(caseRecord.options) || caseRecord.options.length === 0) {
    throw new Error('case_options_required')
  }
  if (typeof runOption !== 'function') {
    throw new Error('sandbox_runner_required')
  }

  // Fail-closed safety check: if any option proposes an unrecoverable mutation, pause immediately.
  for (const opt of caseRecord.options) {
    const risk = classifyMutationRisk(`${opt.label || ''} ${opt.command || ''}`)
    if (!risk.allowed) {
      return {
        ok: false,
        action: 'pause_operator',
        reason: `unrecoverable_option_detected:${opt.id}:${risk.rule}`,
        selectedOption: null,
        caseRecord
      }
    }
  }

  let updated = caseRecord
  const results = []
  for (const opt of caseRecord.options) {
    const sandboxDir = mkdtempSync(join(tmpdir(), `case-sandbox-${opt.id}-`))
    const startMs = Date.now()
    try {
      const outcome = await runOption({ option: opt, sandboxDir, caseRecord: updated })
      const latencyMs = Math.max(0, Date.now() - startMs)
      updated = recordOptionFinding(updated, {
        optionId: opt.id,
        ok: Boolean(outcome?.ok),
        score: Number(outcome?.score) || 0,
        latencyMs,
        sandboxType,
        notes: String(outcome?.notes || '')
      })
      results.push({ optionId: opt.id, ok: Boolean(outcome?.ok), score: Number(outcome?.score) || 0, latencyMs })
    } catch (err) {
      const latencyMs = Math.max(0, Date.now() - startMs)
      updated = recordOptionFinding(updated, {
        optionId: opt.id,
        ok: false,
        score: 0,
        latencyMs,
        sandboxType,
        notes: `sandbox_error:${err.message}`
      })
      results.push({ optionId: opt.id, ok: false, score: 0, latencyMs, error: err.message })
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true })
    }
  }

  const passing = results
    .filter((r) => r.ok)
    .sort((a, b) => (b.score - a.score) || (a.latencyMs - b.latencyMs) || a.optionId.localeCompare(b.optionId))

  if (passing.length === 0) {
    return {
      ok: false,
      action: 'pause_operator',
      reason: 'no_passing_option',
      selectedOption: null,
      results,
      caseRecord: updated
    }
  }

  if (passing.length >= 2 && (passing[0].score - passing[1].score) < Number(minScoreMargin)) {
    return {
      ok: false,
      action: 'pause_operator',
      reason: `ambiguous_tie:${passing[0].optionId}(${passing[0].score})_vs_${passing[1].optionId}(${passing[1].score})`,
      selectedOption: null,
      results,
      caseRecord: updated
    }
  }

  return {
    ok: true,
    action: 'select_winner',
    reason: `clear_best_option:${passing[0].optionId}:score=${passing[0].score}`,
    selectedOption: passing[0].optionId,
    results,
    caseRecord: updated
  }
}

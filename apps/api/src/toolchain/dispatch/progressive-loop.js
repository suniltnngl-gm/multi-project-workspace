/**
 * #296 — Progressive Improvement Loop (Discover -> Decide -> Solve -> Measure -> Improve).
 *
 * Deterministic, $0 evaluator that turns the measurement signals already recorded
 * by the loop (translation-usage ok-rates + relay telemetry failure classes) into
 * concrete, deduplicated improvement recommendations:
 *   - `adapterFixes`: adapters whose ok-rate fell below the threshold (or that
 *     failed at all) — the next candidate for a targeted code/lesson fix.
 *   - `lessons`: advisory lesson rows (deduplicated against a provided ledger)
 *     so gradual improvement persists across sessions.
 *   - `pruneCandidates`: healthy adapters (ok-rate 1.0, sufficient volume) whose
 *     hot context is safe to prune (feeds `contextBudget`).
 *
 * Never writes on its own — the CLI/nightly caller decides `--apply`.
 */
export const PROGRESSIVE_LOOP_SCHEMA = 'progressive-loop/v1'

export const DEFAULT_IMPROVE_THRESHOLDS = Object.freeze({
  minOkRate: 0.8,
  minVolumeForPrune: 3,
  maxLessonsPerRun: 5
})

function normalizeAdapters(adapters) {
  return (Array.isArray(adapters) ? adapters : [])
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      kind: String(a.kind || 'unknown'),
      adapter: String(a.adapter || a.sibling || 'unknown'),
      total: Number(a.total) || 0,
      ok: Number(a.ok) || 0,
      okRate: Number(a.okRate ?? (a.total ? a.ok / a.total : 0))
    }))
}

/**
 * Core evaluation. Inputs:
 *  - usageAdapters: rows from `translationUsageStats().adapters`
 *  - telemetryFailureClasses: rows like [{ failureClass, count }]
 *  - existingLessons: string keys already recorded (dedup)
 */
export function evaluateProgressiveLoop({
  usageAdapters = [],
  telemetryFailureClasses = [],
  existingLessons = [],
  thresholds = DEFAULT_IMPROVE_THRESHOLDS
} = {}) {
  const t = { ...DEFAULT_IMPROVE_THRESHOLDS, ...(thresholds || {}) }
  const rows = normalizeAdapters(usageAdapters)

  const adapterFixes = rows
    .filter((a) => a.okRate < t.minOkRate)
    .sort((a, b) => a.okRate - b.okRate)
    .map((a) => ({
      kind: a.kind,
      adapter: a.adapter,
      okRate: a.okRate,
      total: a.total,
      reason: a.total === 0 ? 'no_usage' : `ok_rate_below_${t.minOkRate}`
    }))

  for (const [failureClass, count] of Object.entries(telemetryFailureClasses)) {
    if (count > 0) {
      adapterFixes.push({
        kind: 'relay',
        adapter: failureClass,
        total: count,
        okRate: 0,
        reason: `telemetry_failure_class:${failureClass}`
      })
    }
  }

  const pruneCandidates = rows
    .filter((a) => a.okRate >= 1 && a.total >= t.minVolumeForPrune)
    .map((a) => `${a.kind}:${a.adapter}`)

  const seen = new Set(existingLessons.map((l) => String(l).trim().toLowerCase()))
  const lessons = []
  for (const fix of adapterFixes) {
    const key = `improve:${fix.kind}:${fix.adapter}`
    if (seen.has(key)) continue
    seen.add(key)
    lessons.push({
      id: key,
      text: `improve ${fix.kind}/${fix.adapter}: ${fix.reason} (observed ${fix.total}, okRate ${fix.okRate.toFixed(2)})`
    })
    if (lessons.length >= t.maxLessonsPerRun) break
  }

  return {
    schema: PROGRESSIVE_LOOP_SCHEMA,
    evaluatedAt: null, // caller stamps time (keeps this fn deterministic for tests)
    healthy: adapterFixes.length === 0,
    adapterFixes,
    pruneCandidates,
    lessons
  }
}

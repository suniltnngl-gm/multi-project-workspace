/**
 * SPLIT-BRAIN GUARD (#212) — resting-state-only discovery reconciliation.
 *
 * Automated discover consolidation used to be able to merge, deduplicate or archive an
 * item that was scheduled, planning, building, reviewing or publishing. That is the
 * reconcile hazard: an in-flight item disappears mid-window and its window keeps running.
 *
 * Two deterministic rules:
 *   1. Only RESTING states are reconcilable (see cas-state.js for the sets). Anything
 *      active is skipped with `in_flight_skip` and left untouched.
 *   2. Deduplication is fingerprint-based: a candidate whose evidence fingerprint already
 *      exists on a resting record attaches its evidence to that id instead of creating a
 *      second, contradictory task/case.
 *
 * Verdict logic stays pure; optional `auditDir` adds best-effort telemetry only.
 */
import { isReconcilable } from './cas-state.js'
import { appendLifecycleTransition } from './lifecycle-audit.js'

function auditDuplicate(auditDir, event) {
  if (!auditDir) return
  try {
    appendLifecycleTransition(auditDir, event)
  } catch { /* telemetry is best-effort; reconciliation is unchanged */ }
}

/** Fold later records with an identical fingerprint into the first one as duplicates. */
export function dedupeByFingerprint(items = []) {
  const seen = new Map()
  const keep = []
  const duplicates = []
  for (const item of items) {
    const fp = String(item?.fingerprint ?? '')
    if (!fp) {
      keep.push(item)
      continue
    }
    if (seen.has(fp)) {
      duplicates.push({ ...item, duplicateOf: seen.get(fp) })
      continue
    }
    seen.set(fp, item.id ?? item.workItemId ?? keep.length)
    keep.push(item)
  }
  return { keep, duplicates }
}

/**
 * Reconcile freshly discovered candidates against what already exists.
 *
 * `stateOf(record)` returns the state string for an existing record (resting/active).
 * Candidates carry `{ title, fingerprint, summary }`; existing records carry
 * `{ id, fingerprint, state }`.
 *
 * Returns { created, attached, skipped } — nothing is mutated in place.
 */
export function reconcileDiscovered({
  candidates = [],
  existing = [],
  stateOf = (record) => record.state,
  auditDir = null
} = {}) {
  const byFingerprint = new Map()
  const active = []
  for (const record of existing) {
    const state = String(stateOf(record) ?? '')
    if (!isReconcilable(state)) {
      active.push({ record, state })
      continue
    }
    const fp = String(record?.fingerprint ?? '')
    if (fp && !byFingerprint.has(fp)) byFingerprint.set(fp, record)
  }

  const created = []
  const attached = []
  const skipped = []

  for (const candidate of candidates) {
    const fp = String(candidate?.fingerprint ?? '')
    if (fp && byFingerprint.has(fp)) {
      const existingId = byFingerprint.get(fp).id ?? null
      attached.push({ existingId, candidate, fingerprint: fp })
      auditDuplicate(auditDir, {
        event: 'duplicate_fingerprint',
        reason: 'duplicate_fingerprint',
        fingerprint: fp,
        existingId,
        candidateId: candidate?.id ?? candidate?.taskId ?? null
      })
      continue
    }
    created.push(candidate)
  }

  for (const entry of active) {
    skipped.push({ id: entry.record?.id ?? null, state: entry.state, reason: 'in_flight_skip' })
  }

  return { created, attached, skipped }
}

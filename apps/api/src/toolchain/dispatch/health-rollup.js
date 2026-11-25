/**
 * SWARM-HEALTH-001 (#215) — unified, strictly read-only health & progression rollup.
 *
 * Reads the four durable sources through `statePaths()` and computes one machine-readable
 * report. It never writes: no ledger append, no ring-state mutation, no cache. Missing,
 * empty or truncated trailing JSONL lines are tolerated and counted.
 *
 * Honesty rule: a counter is only reported when its event is actually recorded somewhere.
 * Counters with no instrumented source come back as `null` with `source: 'not_instrumented'`
 * rather than an invented zero.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** Read a JSONL file leniently: blank and malformed lines are skipped, never fatal. */
export function readJsonl(path, existsFn = existsSync, readFn = (p) => readFileSync(p, 'utf8')) {
  if (!existsFn(path)) return { rows: [], present: false, malformedLinesSkipped: 0 }
  let text = ''
  try {
    text = String(readFn(path))
  } catch {
    return { rows: [], present: true, malformedLinesSkipped: 0, unreadable: true }
  }
  const rows = []
  let malformedLinesSkipped = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      malformedLinesSkipped += 1
    }
  }
  return { rows, present: true, malformedLinesSkipped }
}

function readJson(path, existsFn = existsSync, readFn = (p) => readFileSync(p, 'utf8')) {
  if (!existsFn(path)) return { doc: null, present: false, malformed: false }
  try {
    return { doc: JSON.parse(String(readFn(path))), present: true, malformed: false }
  } catch {
    return { doc: null, present: true, malformed: true }
  }
}

function counterFromEvents(events, needles) {
  return events.filter((e) => needles.some((n) => String(e?.event || '').includes(n))).length
}

function countQuarantineSnapshots(root, existsFn = existsSync, readdirFn = readdirSync) {
  let count = 0
  for (const dir of [join(root, 'repo-checkpoints', 'quarantine'), join(root, 'quarantine')]) {
    if (!existsFn(dir)) continue
    try {
      for (const stamp of readdirFn(dir)) {
        const inner = join(dir, stamp)
        try {
          count += readdirFn(inner).length
        } catch { /* not a directory */ }
      }
    } catch { /* unreadable quarantine dir */ }
  }
  return count
}

/**
 * Compute the rollup.
 * `paths` should come from statePaths(env); overridable for tests.
 */
export function computeHealthRollup({
  paths,
  nowMs = Date.now(),
  existsFn = existsSync,
  readFn = (p) => readFileSync(p, 'utf8'),
  readdirFn = readdirSync
} = {}) {
  if (!paths) throw new Error('state_paths_required')

  const checkpoints = readJsonl(paths.checkpointLedgerPath, existsFn, readFn)
  const lifecycle = readJsonl(paths.lifecycleTransitionsPath, existsFn, readFn)
  const poolCalls = readJsonl(paths.poolCallsPath, existsFn, readFn)
  const ring = readJson(join(paths.ringStatePath), existsFn, readFn)

  const events = lifecycle.rows
  const commitsPushed = checkpoints.rows.filter((r) => r && (r.pushed === true || r.commitSha)).length
  const filesProtected = checkpoints.rows.reduce((sum, r) => sum + (Number(r?.filesCount) || Number(r?.backupsCount) || 0), 0)
  const quotaTurnsSaved = checkpoints.rows.reduce((sum, r) => sum + (Number(r?.quotaTurnsSaved) || 0), 0)
  const hallucinationsCaught = checkpoints.rows.reduce((sum, r) => sum + (Number(r?.hallucinationsCaught) || 0), 0)
  const singleFileUndos = events.filter((e) => String(e?.action || '') === 'undone_single_file').length
  const withProvenance = checkpoints.rows.filter((r) => r?.verdictArtifactPath || r?.gateSource).length
  const gateProvenanceRate = commitsPushed ? Number(((withProvenance / commitsPushed) * 100).toFixed(1)) : null

  // Per-pool utilization over the rolling 5h window.
  const windowStart = nowMs - FIVE_HOURS_MS
  const pools = {}
  const modelTally = {}
  for (const row of poolCalls.rows) {
    const at = Number(row?.atMs)
    if (!Number.isFinite(at) || at < windowStart) continue
    const pool = String(row.quotaPool || 'unknown')
    const status = String(row.status || 'unknown')
    const bucket = pools[pool] || (pools[pool] = { calls: 0, ok: 0, failover: 0, other: 0 })
    bucket.calls += 1
    if (status === 'ok' || status.startsWith('ok_')) bucket.ok += 1
    else if (/failover|rotat/.test(status)) bucket.failover += 1
    else bucket.other += 1
    const model = row.model || row.primaryModel
    if (model) modelTally[String(model)] = (modelTally[String(model)] || 0) + 1
  }

  const quarantined = countQuarantineSnapshots(paths.root, existsFn, readdirFn)

  return {
    schema: 'swarm-health-rollup/v1',
    generatedAt: new Date(nowMs).toISOString(),
    stateRoot: paths.root,
    readOnly: true,
    sources: {
      checkpointLedger: { present: checkpoints.present, rows: checkpoints.rows.length, malformedLinesSkipped: checkpoints.malformedLinesSkipped },
      lifecycleTransitions: { present: lifecycle.present, rows: lifecycle.rows.length, malformedLinesSkipped: lifecycle.malformedLinesSkipped },
      poolCalls: { present: poolCalls.present, rows: poolCalls.rows.length, malformedLinesSkipped: poolCalls.malformedLinesSkipped },
      ringState: { present: ring.present, malformed: ring.malformed }
    },
    splitBrain: {
      deadLeasesReclaimed: counterFromEvents(events, ['lease_reclaimed']),
      circuitBreakerDemotions: counterFromEvents(events, ['demoted_to_case']),
      dirtyTreesQuarantined: quarantined,
      replanLoops: counterFromEvents(events, ['plan_replan']),
      rebuildLoops: counterFromEvents(events, ['build_rebuild']),
      leaseContentionsBlocked: null,
      casConflictsPrevented: null,
      stalePlansBlocked: null,
      discoverDuplicatesDeduped: null,
      notInstrumented: ['leaseContentionsBlocked', 'casConflictsPrevented', 'stalePlansBlocked', 'discoverDuplicatesDeduped']
    },
    delivery: {
      commitsPushed,
      filesProtected,
      quotaTurnsSaved,
      hallucinationsCaught,
      singleFileUndos,
      withGateProvenance: withProvenance,
      gateProvenanceRate
    },
    pools: {
      windowMs: FIVE_HOURS_MS,
      byPool: pools,
      geminiModelDistribution: Object.fromEntries(
        Object.entries(modelTally).filter(([model]) => /gemini|gemma/.test(model))
      )
    },
    ring: ring.doc
      ? {
          runId: ring.doc.runId ?? null,
          generation: ring.doc.generation ?? null,
          round: ring.doc.round ?? null,
          window: ring.doc.window ?? null,
          activeSlot: ring.doc.activeSlot ?? null,
          mode: ring.doc.mode ?? null,
          updatedAt: ring.doc.updatedAt ?? null
        }
      : null
  }
}

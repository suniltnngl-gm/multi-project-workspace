#!/usr/bin/env node
/**
 * SWARM-HEALTH-001 (#215) — print the unified health & progression rollup.
 * Strictly read-only: reads statePaths() sources and writes nothing.
 *
 *   swarm health            human summary
 *   swarm health --json     machine-readable swarm-health-rollup/v1
 */
import { computeHealthRollup } from '../apps/api/src/toolchain/dispatch/health-rollup.js'
import { statePaths } from './swarm-state-paths.mjs'

const json = process.argv.includes('--json')
const report = computeHealthRollup({ paths: statePaths(process.env) })

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  const sb = report.splitBrain
  const d = report.delivery
  const lines = [
    `swarm health (read-only) stateRoot=${report.stateRoot}`,
    `split-brain: reclaimed=${sb.deadLeasesReclaimed} demotions=${sb.circuitBreakerDemotions} quarantined=${sb.dirtyTreesQuarantined} replans=${sb.replanLoops} rebuilds=${sb.rebuildLoops}`,
    `  not instrumented: ${sb.notInstrumented.join(', ')}`,
    `delivery: commitsPushed=${d.commitsPushed} filesProtected=${d.filesProtected} quotaTurnsSaved=${d.quotaTurnsSaved} hallucinationsCaught=${d.hallucinationsCaught} singleFileUndos=${d.singleFileUndos} gateProvenance=${d.gateProvenanceRate === null ? 'n/a' : `${d.gateProvenanceRate}%`}`,
    `pools (5h): ${Object.entries(report.pools.byPool).map(([p, b]) => `${p}=${b.calls}(ok ${b.ok})`).join(' ') || '(none)'}`,
    `ring: ${report.ring ? `runId=${report.ring.runId} gen=${report.ring.generation} r${report.round ?? '?'}w${report.window ?? '?'}` : '(absent)'}`,
    `sources: ${Object.entries(report.sources).map(([k, s]) => `${k}=${s.present ? 'present' : 'missing'}${s.malformedLinesSkipped ? `(+${s.malformedLinesSkipped} malformed)` : ''}`).join(' ')}`
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

#!/usr/bin/env node
/**
 * #296 — `swarm improve`: progressive improvement loop CLI (continuous/gradual).
 *
 * Zero-LLM: reads translation-usage ok-rates + relay telemetry failure classes,
 * evaluates improvement recommendations, and (with --apply) appends deduplicated
 * `loop-improve` lessons to the lessons ledger. Dry-run by default.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { statePaths } from './swarm-state-paths.mjs'
import { translationUsageStats } from '../apps/api/src/toolchain/dispatch/translation-registry.js'
import { aggregateRelayTelemetry } from './swarm-measure.mjs'
import { evaluateProgressiveLoop, PROGRESSIVE_LOOP_SCHEMA } from '../apps/api/src/toolchain/dispatch/progressive-loop.js'

const isMain = process.argv[1] && process.argv[1].endsWith('swarm-improve.mjs')

if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-improve.mjs [options]
      --apply   Append new improvement lessons to decision-lessons.jsonl (default: dry-run)
      --json    JSON output (always JSON on stdout)
  -h, --help    Show this help
`)
    process.exit(0)
  }
  const apply = argv.includes('--apply')
  const env = process.env
  const paths = statePaths(env)
  const usage = translationUsageStats(null, { env })
  const telemetry = aggregateRelayTelemetry(paths.reportsDir)
  const result = evaluateProgressiveLoop({
    usageAdapters: usage.adapters,
    telemetryFailureClasses: telemetry.failureClasses || {}
  })
  result.evaluatedAt = new Date().toISOString()
  result.mode = apply ? 'apply' : 'dry-run'

  if (apply && result.lessons.length > 0) {
    appendFileSync(join(paths.lessonsDir, 'decision-lessons.jsonl'),
      result.lessons.map((l) => JSON.stringify({ lessonId: l.id, category: 'loop-improve', text: l.text, recordedAt: result.evaluatedAt })).join('\n') + '\n',
      { mode: 0o600 })
  }

  process.stdout.write(`${JSON.stringify({ ok: true, schema: PROGRESSIVE_LOOP_SCHEMA, ...result })}\n`)
}

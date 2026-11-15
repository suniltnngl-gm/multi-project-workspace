#!/usr/bin/env node
/**
 * Inspect the local AI setup without starting models or spending remote quota.
 *
 * The default run is advisory and exits 0 even when a model is offline; pass
 * --strict in scripts or CI to fail on errors. --json prints machine-readable
 * output for bug reports. --offline (or --no-probe) skips every endpoint and
 * CLI probe so the doctor can run in CI, preflight checks, or environments
 * without network access; configuration checks still run and probing is
 * reported as skipped rather than claimed reachable.
 */
import { createModelClient } from '../apps/api/src/modelClient.js'
import { describeError, runDoctorChecks } from './ai-doctor-checks.mjs'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'
import { getEnvSnapshot } from './workspace-env.mjs'

const arguments_ = process.argv.slice(2)
const asJson = arguments_.includes('--json')
const strict = arguments_.includes('--strict')
const offline = arguments_.includes('--offline') || arguments_.includes('--no-probe')

loadWorkspaceEnv()

async function main() {
  const databasePath = resolveDatabasePath({ rootDir: ROOT_DIR })
  const { checks } = await runDoctorChecks({
    env: process.env,
    databasePath,
    modelClient: offline ? undefined : createModelClient(),
    offline
  })
  const envSnapshot = getEnvSnapshot()
  checks.push({
    area: 'workspace-env',
    level: envSnapshot.ok ? 'ok' : 'warn',
    message: `profile=${envSnapshot.activeProfile}, plugins=${envSnapshot.agy.plugins.filter((p) => p.enabled).length} enabled, python=${envSnapshot.python.exists ? 'ok' : 'missing'}, local=${envSnapshot.localInference.status}`,
  })
  const summary = {
    ok: checks.filter((check) => check.level === 'ok').length,
    warnings: checks.filter((check) => check.level === 'warn').length,
    errors: checks.filter((check) => check.level === 'error').length
  }

  if (asJson) {
    console.log(JSON.stringify({
      checks,
      summary,
      ...(offline ? { probing: 'skipped' } : {})
    }, null, 2))
  } else {
    for (const check of checks) {
      const label = check.level === 'ok' ? 'ok' : check.level
      console.log(`[${label}] ${check.area}: ${check.message}`)
    }
    console.log(
      `\nAI doctor: ${summary.ok} ok, ${summary.warnings} warnings, ${summary.errors} errors.`
    )
  }

  process.exitCode = strict && summary.errors > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`AI doctor failed: ${describeError(error)}`)
  process.exitCode = 1
})

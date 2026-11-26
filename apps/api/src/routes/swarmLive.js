// Objective: Read-only swarm dashboard: health rollup, ring state, kill-switch status, and recent checkpoint ledger.
// Requirements: No mutations of any kind; every state path resolves through statePaths() per request so SWARM_STATE_DIR is honoured; missing or corrupt state files degrade to null/empty instead of erroring.
// Decisions: The route composes the existing read-only primitives (computeHealthRollup, readRingState, killSwitchPath) rather than reimplementing them; checkpoint ledger rows are read leniently (blank/malformed lines skipped) and the most recent N rows are returned.
// Relevant Files: apps/api/src/routes/swarmLive.js, apps/api/src/app.js, apps/api/test/swarmLive.test.js, scripts/swarm-state-paths.mjs, scripts/swarm-ring-state.mjs, apps/api/src/toolchain/dispatch/health-rollup.js, apps/api/src/toolchain/dispatch/overnight-supervisor.js
import { Router } from 'express'
import { existsSync } from 'node:fs'
import { computeHealthRollup, readJsonl } from '../toolchain/dispatch/health-rollup.js'
import { readRingState } from '../../../../scripts/swarm-ring-state.mjs'
import { killSwitchPath } from '../toolchain/dispatch/overnight-supervisor.js'
import { statePaths } from '../../../../scripts/swarm-state-paths.mjs'

const MAX_RECENT_CHECKPOINT_ROWS = 50

export function createSwarmLiveRouter({ env = process.env, now = Date.now } = {}) {
  const router = Router()

  router.get('/api/swarm/live', (_request, response) => {
    const paths = statePaths(env)
    const rollup = computeHealthRollup({ paths, nowMs: now() })
    const ledger = readJsonl(paths.checkpointLedgerPath)
    const recentRows = ledger.rows.slice(-MAX_RECENT_CHECKPOINT_ROWS)
    response.json({
      schema: 'swarm-live/v1',
      generatedAt: new Date(now()).toISOString(),
      readOnly: true,
      stateRoot: paths.root,
      health: rollup,
      ring: readRingState(paths.relayDir) ?? null,
      killSwitch: {
        active: existsSync(killSwitchPath(paths.overnightDir)),
        path: paths.stopSwitchPath
      },
      checkpointLedger: {
        path: paths.checkpointLedgerPath,
        present: ledger.present,
        malformedLinesSkipped: ledger.malformedLinesSkipped,
        rows: recentRows,
        returned: recentRows.length
      }
    })
  })

  return router
}
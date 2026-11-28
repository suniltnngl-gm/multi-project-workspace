#!/usr/bin/env node
/**
 * SWARM RELAY — graceful, quota-aware multi-sibling relay runner.
 *
 * Round-robin parent promotion: each sibling works one window, then is promoted to
 * the parent slot for the next sibling; on wrap-around the previous parent is demoted
 * back to a sibling. See scripts/swarm-ring-state.mjs for the durable ledger.
 *
 * Window contract (noHardKill): the relay never installs a routine wall-clock timer.
 * A window is a cooperative budget — the sibling is told the deadline, the relay stops
 * admitting new sub-turns once the budget is spent, and promotion happens at turn exit.
 * Only an explicit `--stall-kill-sec <n>` (default 0 = disabled) interrupts a runaway.
 *
 * Quota-aware slot selection is delegated to scripts/swarm-quota-ring.mjs (pure).
 *
 * Defaults to --dry-run (prints the relay plan, spawns nothing). Pass --execute to run.
 */
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  checkPoolFiveHourAdmission,
  countPoolCallsInWindow,
  recordPoolCall
} from '../apps/api/src/toolchain/dispatch/overnight-supervisor.js'
import { protectedWriteFile, snapshotRestorePoints } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { applyPublishGate, deterministicRoundReview, modifiedFilesSince, readReviewVerdict, roundBaseSha } from './swarm-publish-gate.mjs'
export { applyPublishGate, roundBaseSha }
import { formatQuotaStatusLine } from './swarm-doctor-quota.mjs'
import { windowPolicyEnv } from './swarm-window-policy.mjs'
import { entrypointAuthorizationGate } from '../apps/api/src/toolchain/dispatch/auth-authority.js'
import {
  acquireOrchestratorLock,
  releaseOrchestratorLock,
  renewOrchestratorLock,
  DEFAULT_ORCHESTRATOR_LOCK_TTL_MS
} from './swarm-orchestrator-lock.mjs'
import {
  PIPELINE_JOBS,
  RING_PRESETS,
  loadPoolBudgets,
  poolForSibling,
  readLiveSqliteQuota,
  resolveRing,
  selectSlot,
  guestFallbackCandidates,
  recordEntityFailure,
  recordEntitySuccess
} from './swarm-quota-ring.mjs'
import {
  DEFAULT_RING_STATE_DIR,
  advanceRingState,
  createRingState,
  writeRingState
} from './swarm-ring-state.mjs'
import { advanceGeminiApiRotation, alternateModelForPrimary } from './swarm-gemini-rotation.mjs'
import { preBuildGuard, applyReplanVerdict, applyRebuildVerdict } from '../apps/api/src/toolchain/dispatch/delivery-pipeline.js'
import { normalizeStdoutFindings } from '../apps/api/src/toolchain/dispatch/findings-normalize.js'
import { statePaths } from './swarm-state-paths.mjs'
import { quarantineDirtyWorktree } from '../apps/api/src/toolchain/dispatch/worktree-quarantine.js'
import { readWorkItem, writeWorkItem } from '../apps/api/src/toolchain/dispatch/work-item-registry.js'

export const RELAY_MODES = ['discover', 'fix', 'pipeline', 'case-solve', 'build', 'review', 'publish']
export const DEFAULT_SIBLINGS = ['hermes', 'direct']
export const DEFAULT_WINDOWS = 3
export const DEFAULT_SOFT_WINDOW_SEC = 300
export const DEFAULT_ROUNDS = 1
export const DEFAULT_MAX_CONSERVE_WINDOWS = 1
export const DEFAULT_STALL_KILL_SEC = 0
/** #233: report root resolves through statePaths() at call time; use defaultReportDir(). */
export function defaultReportDir(env = process.env) {
  return statePaths(env).reportsDir
}

/** Sibling CLIs that accept an explicit `--model` flag. */
const MODEL_FLAG_CLIS = new Set(['hermes', 'opencode', 'agy', 'gemini-api', 'codex'])

/**
 * Classify one window's outcome. A sibling that exits 0 without writing its findings
 * artifact is `ok_no_findings` — a legitimate "found nothing" result, never a failure —
 * so the missing-artifact blind spot becomes visible in the ledger instead of silently
 * recording `status:'ok'` for a stage that produced no report.
 */
export function resolveWindowStatus({ error = null, stallKilled = false, exitCode = null, findingsWritten = false } = {}) {
  if (error) return 'spawn_error'
  if (stallKilled) return 'stall_killed'
  if (exitCode !== 0) return 'failed'
  return findingsWritten ? 'ok' : 'ok_no_findings'
}

/** Statuses that count as a successful relay window for the summary verdict. */
export function isSuccessfulWindowStatus(status) {
  return status === 'ok' || status === 'ok_no_findings' || status === 'ok_after_failover' || status === 'ok_after_model_retry'
}

/** #221: W5 cleanup must write to the window's path, never the plan object. */
export function w5CleanupReportPath({ assignment = {} } = {}) {
  const path = assignment.reportPath
  if (typeof path !== 'string' || !path) throw new Error('w5_cleanup_report_path_required')
  return path
}

/**
 * GOV-1 review gate: an ACCEPT requires a valid W4 artifact AND clean deterministic
 * gates AND no unreviewed head advance since the round base.
 * `deterministicOnly` permits an ACCEPT when the sibling emitted no verdict at all,
 * provided every deterministic gate ran and the round actually produced a diff.
 */
export function evaluateReviewGate({ artifactVerdict = null, artifactReason = null, detOk = false, detReason = null, headDrift = false, deterministicOnly = false } = {}) {
  if (artifactVerdict === 'ACCEPT' && detOk && !headDrift) {
    return { verdict: 'ACCEPT', reason: artifactReason || 'w4_accept' }
  }
  if (!detOk) return { verdict: 'REJECT', reason: detReason || 'deterministic_gate_failed' }
  if (headDrift) return { verdict: 'REJECT', reason: 'unexpected_head_advance_before_review' }
  if (deterministicOnly) return { verdict: 'ACCEPT', reason: 'deterministic_only_no_sibling_artifact' }
  return { verdict: 'REJECT', reason: 'w4_verdict_reject' }
}

/** #222: explicit, machine-readable reason when a sibling advances HEAD mid-round. */
export function headDriftReason() {
  return 'head_drift_mid_round'
}

const FORBID_COMMIT_HOOK = `#!/bin/sh
# Scoped relay guard for W1..W4. Refuses commits while SWARM_FORBID_COMMIT=1.
# Removed before W5 publish and on error/exit; never overwrites an existing hook.
if [ "\${SWARM_FORBID_COMMIT:-0}" = "1" ]; then
  echo "swarm relay: commit/push forbidden before the W5 publish gate" >&2
  exit 1
fi
exit 0
`

/** Install the W1..W4 forbid-commit hooks only where no hook already exists. */
export function installForbidCommitHook(repoDir) {
  const hooksDir = join(resolve(repoDir), '.git', 'hooks')
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
  let installed = false
  for (const name of ['pre-commit', 'pre-push']) {
    const hookPath = join(hooksDir, name)
    if (!existsSync(hookPath)) {
      writeFileSync(hookPath, FORBID_COMMIT_HOOK, { mode: 0o700 })
      installed = true
    }
  }
  return installed
}

/** Idempotent cleanup: missing hooks and missing .git/hooks are both fine. */
export function removeForbidCommitHook(repoDir) {
  const hooksDir = join(resolve(repoDir), '.git', 'hooks')
  if (!existsSync(hooksDir)) return
  for (const name of ['pre-commit', 'pre-push']) {
    rmSync(join(hooksDir, name), { force: true })
  }
}

/** Parse only an explicit standalone `VERDICT: ACCEPT|REJECT` line; ignore tool-call JSON. */
export function parseSiblingVerdict(stdoutText) {
  for (const line of String(stdoutText || '').split(/\r?\n/)) {
    const m = line.trim().match(/^VERDICT:\s*(ACCEPT|REJECT)\b/i)
    if (m) return m[1].toUpperCase()
  }
  return null
}

/** Bounded, $0 pre-pack injected into the W4 prompt so a file-less CLI can still review. */
export function buildReviewBrief({ repoDir, baseSha = null, parentFindingsPath = null, det = null, maxBytes = 12000 } = {}) {
  const range = baseSha || 'HEAD'
  const diff = spawnSync('git', ['-C', repoDir, 'diff', range], { encoding: 'utf8', timeout: 5000 }).stdout || ''
  let parentSummary = '(parent findings unavailable)'
  if (parentFindingsPath && existsSync(parentFindingsPath)) {
    try {
      const doc = JSON.parse(readFileSync(parentFindingsPath, 'utf8'))
      const lines = []
      for (const key of ['prioritized_work', 'cases', 'findings']) {
        if (Array.isArray(doc[key]) && doc[key].length) {
          lines.push(`${key}: ${doc[key].slice(0, 8).map((x) => x.title || x.label || x.id || JSON.stringify(x)).join(' | ')}`)
        }
      }
      parentSummary = lines.join('\n') || '(no prioritized items)'
    } catch { /* keep default */ }
  }
  return [
    `## Round diff (base ${range})`,
    '```diff',
    diff.slice(0, 7000) || '(no tracked changes)',
    '```',
    '## Parent findings summary',
    parentSummary.slice(0, 3000),
    '## Deterministic gates (pre-computed)',
    '```json',
    JSON.stringify(det || {}).slice(0, 1500),
    '```'
  ].join('\n').slice(0, maxBytes)
}

/** Prefer a focused unit test from this round's own changed files. */
export function pickFocusedTest(files = []) {
  return (files.find((f) => /\.test\.js$/.test(String(f))) ) || null
}

/**
 * #220: fail-soft read of the pinned board task's exact target paths and acceptance
 * criteria. A CI checkout with no live DB simply gets no injected detail.
 */
export function readPinnedTaskDetails({ repoDir, taskId = null } = {}) {
  const needle = String(taskId ?? '').replace(/^#/, '')
  if (!/^\d+$/.test(needle)) return null
  const dbPath = join(resolve(repoDir), 'apps', 'api', 'data', 'workspace.sqlite')
  if (!existsSync(dbPath)) return null
  let connection = null
  try {
    connection = new Database(dbPath, { readonly: true, fileMustExist: true })
    return connection.prepare(
      'SELECT id,title,relevant_files,acceptance_criteria,description,next_move FROM tasks WHERE id = ?'
    ).get(Number(needle)) || null
  } catch {
    return null
  } finally {
    if (connection) connection.close()
  }
}

/** #220: an empty round diff has its own reason, never the passing deterministic reason. */
export function reviewGateReason({ detReason = null, modifiedCount = 0, headDrift = false } = {}) {
  if (headDrift) return headDriftReason()
  return modifiedCount > 0 ? (detReason || 'deterministic_gate_failed') : 'no_modified_files'
}

/** Resolve the next eligible in_progress/queued task after the current one (board-driven ordering). */
export function resolveNextTaskId(currentTaskId, repoDir) {
  // #234/#237: --task arrives as "#237" in the documented operator form (and as a
  // bare/ numeric id from a prior advance). Strip the leading '#' exactly as
  // readPinnedTaskDetails/buildBuildBrief do — Number("#237") is NaN, which would
  // make W5 checkpoint_pushed silently fail to advance (no_next_task) instead of
  // handing the next eligible task to the following round.
  const needle = String(currentTaskId ?? '').replace(/^#/, '')
  if (!/^\d+$/.test(needle)) return null
  const dbPath = join(resolve(repoDir), 'apps', 'api', 'data', 'workspace.sqlite')
  if (!existsSync(dbPath)) return null
  let connection = null
  try {
    connection = new Database(dbPath, { readonly: true, fileMustExist: true })
    const stmt = connection.prepare(
      `SELECT id, title, status, priority
       FROM tasks
       WHERE status IN ('in_progress', 'queued') AND id > ?
       ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
                CASE priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 WHEN 'P3' THEN 2
                            WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2
                            ELSE 3 END,
                id
       LIMIT 1`
    )
    return stmt.get(Number(needle)) || null
  } catch {
    return null
  } finally {
    if (connection) connection.close()
  }
}

/** Advance the pinned task after a W5 checkpoint_pushed, returning the next task id or null if idle. */
export function advanceTaskAfterCheckpoint({ currentTaskId = null, repoDir = null } = {}) {
  if (!currentTaskId) return null
  const next = resolveNextTaskId(currentTaskId, repoDir)
  if (!next) return null
  return next.id
}

/**
 * $0 pre-pack for W3/W2: the board's in-progress targets, so a single-shot CLI has a
 * concrete deliverable instead of guessing. Pass `--task <id>` to pin one target.
 */
export function buildBuildBrief({ repoDir, taskId = null, maxBytes = 5000 } = {}) {
  const out = spawnSync(resolve(repoDir, 'workspace'), ['task', 'list', '--status', 'in_progress'], { encoding: 'utf8', timeout: 10000 })
  const lines = String(out.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let picked = lines
  if (taskId) {
    const needle = String(taskId).replace(/^#/, '')
    const hit = lines.find((l) => l.includes(`#${needle} `))
    if (hit) picked = [hit]
  }
  const body = picked.slice(0, 3).join('\n') || '(no in-progress board tasks)'
  const pinnedTask = readPinnedTaskDetails({ repoDir, taskId })
  const parts = [
    '## Board target(s) — pick the pinned task or the highest-priority one, implement the smallest verified change, run focused tests',
    body
  ]
  if (pinnedTask?.relevant_files) {
    parts.push('## Exact target files (pinned task relevant_files) — edit these paths only', pinnedTask.relevant_files)
  }
  if (pinnedTask?.acceptance_criteria) {
    parts.push('## Acceptance criteria (pinned task)', pinnedTask.acceptance_criteria)
  }
  if (pinnedTask?.next_move) {
    parts.push('## Next move (pinned task)', pinnedTask.next_move)
  }
  return parts.join('\n').slice(0, maxBytes)
}

export const DEFAULT_HORIZON_MS = 5 * 60 * 60 * 1000

/**
 * Phase 3 horizon: a hard 5h wall-clock cap, pulled earlier when an active pool
 * call in the rolling 5h ledger implies an imminent reset boundary.
 */
export function computeHorizonDeadlineMs({ relayStartMs, maxHorizonMs = DEFAULT_HORIZON_MS, ledgerPath = null, cappedPools = null } = {}) {
  let deadline = relayStartMs + maxHorizonMs
  if (ledgerPath && existsSync(ledgerPath)) {
    try {
      let earliest = null
      for (const line of readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        const rec = JSON.parse(line)
        const at = Number(rec.atMs)
        if (!Number.isFinite(at)) continue
        // Only pools with a real 5h cap define a reset boundary; $0 uncapped pools do not.
        if (cappedPools && !cappedPools.has(String(rec.quotaPool || ''))) continue
        if (at >= relayStartMs - DEFAULT_HORIZON_MS) earliest = earliest === null ? at : Math.min(earliest, at)
      }
      if (earliest !== null) deadline = Math.min(deadline, earliest + DEFAULT_HORIZON_MS)
    } catch { /* malformed ledger: keep the plain horizon */ }
  }
  return deadline
}

/** Advisory window budget for the next window after a drift overrun. */
export function effectiveWindowBudgetMs({ softWindowSec, windowDriftMs = 0, minSubTurnSec = 30 } = {}) {
  const base = Math.max(0, softWindowSec * 1000 - Math.max(0, windowDriftMs))
  return Math.max(minSubTurnSec * 1000, base)
}

const SIBLING_TOKEN = /^[a-z0-9][a-z0-9._-]*$/

function expandHome(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string')
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number (got ${value})`)
  return Math.floor(n)
}

function nonNegativeInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number (got ${value})`)
  return Math.floor(n)
}

export function normalizeSiblings(siblings = DEFAULT_SIBLINGS) {
  const raw = Array.isArray(siblings) ? siblings : String(siblings ?? '').split(',')
  const list = raw
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) throw new Error('siblings must contain at least one sibling CLI name')
  for (const s of list) {
    if (!SIBLING_TOKEN.test(s)) throw new Error(`invalid sibling name '${s}' (allowed: a-z 0-9 . _ -)`)
  }
  return list
}

/** Parse `--model-map a=model,b=model` or a JSON object string. */
export function parseModelMap(value) {
  if (!value) return {}
  if (typeof value === 'object') return { ...value }
  const text = String(value).trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model_map_json_invalid')
    return { ...parsed }
  }
  const map = {}
  for (const pair of text.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    if (!k || !v) throw new Error(`model_map_pair_invalid:${pair}`)
    map[k] = v
  }
  return map
}

/**
 * Parse an optional quota-status JSON file (`{ pools: { pool: { weeklyRemainingPct } }, conservePools: [] }`)
 * OR load live weeklyRemainingPct and conservePools directly from the workspace SQLite `ai_quota` store.
 */
export function readQuotaStatus(path) {
  if (!path) {
    return readLiveSqliteQuota()
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const pools = parsed?.pools && typeof parsed.pools === 'object' ? parsed.pools : {}
  const quota = {}
  for (const [pool, v] of Object.entries(pools)) {
    quota[pool] = { weeklyRemainingPct: Number(v?.weeklyRemainingPct ?? 100) }
  }
  return { ok: true, source: 'file', quota, conservePools: Array.isArray(parsed?.conservePools) ? [...parsed.conservePools] : [] }
}

/**
 * Pure planner: no I/O, no CLI spawning. Deterministic in its inputs.
 */
/** Short, filename-safe id for one run: the time part of its ISO run id (#206). */
export function shortRunId(runId) {
  const raw = String(runId || '')
  const t = raw.indexOf('T')
  return (t >= 0 ? raw.slice(t + 1) : raw).replace(/[^A-Za-z0-9._-]/g, '-')
}

export function buildRelayPlan({
  mode = 'discover',
  siblings = DEFAULT_SIBLINGS,
  windows = null,
  softWindowSec = DEFAULT_SOFT_WINDOW_SEC,
  windowSec = null,
  rounds = DEFAULT_ROUNDS,
  preset = null,
  modelMap = {},
  reportDir = defaultReportDir(),
  runId = null
} = {}) {
  const planMode = (preset === 'k5-pipeline-ring' && (!mode || mode === 'discover'))
    ? 'pipeline'
    : String(mode ?? 'discover').trim().toLowerCase()
  if (!RELAY_MODES.includes(planMode)) {
    throw new Error(`invalid mode '${mode}' (expected one of: ${RELAY_MODES.join('|')})`)
  }
  const list = preset ? resolveRing(null, preset) : normalizeSiblings(siblings)
  const defaultWin = preset ? list.length : DEFAULT_WINDOWS
  const windowCount = positiveInt(windows, defaultWin, 'windows')
  const roundCount = rounds === 'continuous' ? 'continuous' : positiveInt(rounds, DEFAULT_ROUNDS, 'rounds')
  const totalPlanWindows = roundCount === 'continuous' ? windowCount : windowCount * roundCount
  const softSec = positiveInt(windowSec ?? softWindowSec, DEFAULT_SOFT_WINDOW_SEC, 'windowSec')
  const dir = resolve(expandHome(reportDir))
  const models = modelMap && typeof modelMap === 'object' ? modelMap : {}
  // One run id per plan, reused by the executor so ring state and artifacts agree (#206).
  // A millisecond ISO stamp alone can repeat for two plans built in the same tick,
  // so the default run id carries pid + a random suffix (#206 collision guard).
  const planRunId = runId
    || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`
  const stamp = shortRunId(planRunId)

  const assignments = Array.from({ length: totalPlanWindows }, (_, i) => buildAssignment({
    list, index: i, dir, planMode, softSec, models, stamp
  }))

  return {
    version: 'relay-plan/v1',
    mode: planMode,
    siblings: list,
    windows: windowCount,
    softWindowSec: softSec,
    rounds: roundCount,
    preset: preset || null,
    modelMap: models,
    reportDir: dir,
    runId: planRunId,
    runIdShort: stamp,
    execution: 'sequential',
    assignmentStrategy: 'round_robin',
    noHardKill: true,
    hardKill: false,
    killsSiblings: false,
    killSwitchFile: statePaths().stopSwitchPath,
    summaryReportPath: join(dir, `relay-${planMode}-${stamp}-summary.json`),
    assignments
  }
}

/** One window's assignment. `index` is zero-based across the whole run (rounds included). */
export function buildAssignment({ list, index, dir, planMode, softSec, models = {}, allowConserve = false, stamp = '' }) {
  const window = index + 1
  const idx = index % list.length
  const round = Math.floor(index / list.length) + 1
  const rawSibling = list[idx]
  const sibling = rawSibling === 'guest'
    ? guestFallbackCandidates({ list, round, allowConserve })[0]
    : rawSibling
  const job = planMode === 'pipeline'
    ? PIPELINE_JOBS[idx % PIPELINE_JOBS.length]
    : planMode
  const siblingSlot = `sibling${idx + 1}`
  const promotedToParentSlot = `parent${idx + 1}`
  const hasParent = index > 0
  const prevIdx = hasParent ? (index - 1) % list.length : null
  const prevRound = hasParent ? Math.floor((index - 1) / list.length) + 1 : null
  const rawParentSibling = hasParent ? list[prevIdx] : null
  const parentSibling = rawParentSibling === 'guest'
    ? guestFallbackCandidates({ list, round: prevRound, allowConserve })[0]
    : rawParentSibling
  const parentSlot = hasParent ? `parent${prevIdx + 1}` : null
  const parentWindow = hasParent ? index : null
  const parentFindingsPath = hasParent
    ? join(dir, `relay-${planMode}-${stamp}-r${prevRound}-w${parentWindow}-${parentSibling}-findings.json`)
    : null
  const demotedFromParentSlot = index >= list.length ? `parent${idx + 1}` : null

  return {
    window,
    index,
    round,
    sibling,
    rosterSlot: rawSibling,
    job,
    role: 'sibling',
    siblingSlot,
    promotedToParentSlot,
    demotedFromParentSlot,
    parentSibling,
    parentSlot,
    parentWindow,
    parentFindingsPath,
    model: models[sibling] || models[rawSibling] || null,
    pool: poolForSibling(sibling),
    softWindowSec: softSec,
    hardKill: false,
    findingsPath: join(dir, `relay-${planMode}-${stamp}-r${round}-w${window}-${sibling}-findings.json`),
    reportPath: join(dir, `relay-${planMode}-${stamp}-r${round}-w${window}-${sibling}.json`)
  }
}

export function buildSiblingPrompt({
  mode,
  job = null,
  window,
  windows,
  sibling,
  siblingSlot = null,
  promotedToParentSlot = null,
  demotedFromParentSlot = null,
  reviewBrief = '',
  buildBrief = '',
  parentSibling = null,
  parentSlot = null,
  parentFindingsPath = null,
  softWindowSec,
  reportPath,
  deadlineIso = null
}) {
  const activeJob = job || (mode === 'pipeline' ? 'discover' : mode)
  const budget = `Soft window budget ${softWindowSec}s (advisory only — do not self-kill; finish gracefully).`
  const deadlineLine = deadlineIso
    ? `Window deadline ${deadlineIso} (cooperative budget: finish before it; the relay stops admitting new sub-turns once the budget is spent).`
    : ''
  const roleLine = [
    siblingSlot ? `Role: ${siblingSlot} [job=${activeJob}]${demotedFromParentSlot ? ` (demoted from ${demotedFromParentSlot} in round-robin ring)` : ''}.` : '',
    parentSibling
      ? `Active Parent: ${parentSlot} (${parentSibling}) — read parent findings at ${parentFindingsPath} and query via "swarm ask --parent-slot ${parentSlot} <question>" if clarity is needed.`
      : 'Active Parent: none (bootstrap window 1).',
    promotedToParentSlot ? `On completion, you are promoted to ${promotedToParentSlot} for the next sibling.` : ''
  ].filter(Boolean).join(' ')
  if (activeJob === 'fix' || activeJob === 'build') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=${activeJob}).`,
      roleLine,
      `Apply the smallest verified fix set for the active case/task, run focused tests, and write a concise JSON report to ${reportPath}.`,
      'Never force-push, never reset --hard, never discard untracked work.',
      'Never git commit or git push in this window: non-publish windows run with SWARM_FORBID_COMMIT=1 and a scoped pre-commit hook; leave edits for W4 review and W5 gated checkpoint.',
      deadlineLine,
      budget,
      buildBrief,
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'case-solve') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=case-solve).`,
      roleLine,
      `Triage and score open multi-option cases from parent findings, pause only on unrecoverable options, and write a JSON report to ${reportPath}.`,
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'review') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=review).`,
      roleLine,
      'Independently cross-review the round diff and parent findings injected below, verify tests for the touched files, then reply with exactly one explicit verdict line: VERDICT: ACCEPT or VERDICT: REJECT plus a reason code and cited evidence (file:line).',
      'This CLI has no file tools: do NOT emit tool-call JSON. Your stdout is authoritative and is captured as the verdict artifact.',
      deadlineLine,
      budget,
      reviewBrief,
    ].filter(Boolean).join(' ')
  }
  if (activeJob === 'publish') {
    return [
      `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=publish).`,
      roleLine,
      `Consolidate the round result and write the publish report to ${reportPath}. The relay enforces the gate automatically: ACCEPT runs swarm checkpoint --push scoped to this round's modified files; REJECT undoes only those files' last edit and emits replan guidance.`,
      deadlineLine,
      budget
    ].filter(Boolean).join(' ')
  }
  return [
    `swarm relay window ${window}/${windows} -> ${sibling} (mode=${mode}, job=${activeJob}).`,
    roleLine,
    `Discover prioritized work and multi-option cases, then write a concise JSON report to ${reportPath}.`,
    'Read-only exploration only: propose options, do not mutate the working tree.',
    deadlineLine,
    budget
  ].filter(Boolean).join(' ')
}

function envBinName(sibling) {
  return `SWARM_RELAY_${sibling.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`
}

/**
 * Resolve the argv for a sibling CLI. `opencode` is pinned to `run --standalone`
 * (never `serve`, per workspace hard rules). Unknown siblings fall back to a
 * same-named binary. Override with SWARM_RELAY_<SIBLING>_BIN.
 *
 * `cline`/`vibe`/`codex` use the headless shapes measured live on 2026-11-24
 * (#205): a bare `vibe <prompt>` / `codex <prompt>` starts an interactive UI and
 * hangs the window, and cline defaults to yolo auto-approve, so read-only jobs
 * must ask for plan/ask/read-only explicitly. `model` is appended only for CLIs
 * that accept it (and codex spells it `-m`).
 */
const MODEL_FLAG = Object.freeze({ __default: '--model', codex: '-m' })

export function buildSiblingCommand(sibling, { prompt, model = null, cwd = null, readOnly = true } = {}) {
  const override = process.env[envBinName(sibling)]
  const workdir = cwd || process.cwd()
  let base
  if (override && override.trim()) base = override.trim().split(/\s+/)
  else if (sibling === 'hermes') base = ['hermes', '-z']
  else if (sibling === 'opencode') base = ['opencode', 'run', '--standalone', '--model', 'opencode/deepseek-v4.1-flash-free']
  else if (sibling === 'direct') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'cloudflare', '--prompt']
  else if (sibling === 'direct-graphn') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'graphn', '--prompt']
  else if (sibling === 'direct-vercel') base = [process.execPath, resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname), '--provider', 'vercel', '--prompt']
  else if (sibling === 'local') base = [process.execPath, resolve(new URL('./local-llama-cli.mjs', import.meta.url).pathname), '--model', '1.5b', '--prompt']
  else if (sibling === 'copilot') base = ['copilot', '-p']
  else if (sibling === 'gemini-api') base = ['gemini-api', 'generate']
  else if (sibling === 'agy') base = ['agy', '-p']
  else if (sibling === 'cline') base = ['cline', '--cwd', workdir, '--json', ...(readOnly ? ['--plan'] : ['--yolo'])]
  else if (sibling === 'vibe') base = ['vibe', '--workdir', workdir, '--output', 'json', ...(readOnly ? ['--agent', 'ask'] : ['--trust']), '-p']
  else if (sibling === 'codex') base = ['codex', 'exec', ...(readOnly ? ['--sandbox', 'read-only'] : [])]
  else base = [sibling]

  if (base[0] === 'opencode') {
    const rest = base.slice(1)
    if (!rest.includes('run')) base = ['opencode', 'run', '--standalone', ...rest]
    // Hard rule: never launch opencode serve/attach from the relay.
    base = base.filter((token) => token !== 'serve')
  }
  const args = [...base.slice(1)]
  if (model && MODEL_FLAG_CLIS.has(sibling)) args.push(MODEL_FLAG[sibling] || MODEL_FLAG.__default, String(model))
  args.push(prompt)
  return { command: base[0], args }
}

function writeReport(path, payload) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  protectedWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * Run one child. No routine timer: `stallKillSec` defaults to 0 (disabled) so a normal
 * turn is never interrupted. When enabled, a runaway turn is killed at the stall limit.
 */
// #278: sibling failure telemetry — a bare exit code (CLI_OUTCOME_FAILED) masks
// RPM throttling and transient backend errors. Classify from the child's stderr
// so relay reports can distinguish quota pressure from real failures.
export const RPM_THROTTLE_PATTERN = /429|resource_exhausted|rate.?limit|too many requests|quota.*(exceed|exhaust)|exhausted.*quota/i
export const AUTH_FAILURE_PATTERN = /401|403|unauthenticated|unauthorized|invalid api key|api key (not valid|expired|invalid)/i
export const TRANSIENT_PATTERN = /500|502|503|504|unavailable|timeout|timed out|connection reset|econnreset|socket hang up|internal error/i

export function classifyFailure({ exitCode, stderr = '', stdout = '' }) {
  if (exitCode === 0 || exitCode === null) return null
  const text = `${stderr}\n${stdout}`
  if (RPM_THROTTLE_PATTERN.test(text)) return 'rpm_throttled'
  if (AUTH_FAILURE_PATTERN.test(text)) return 'auth_failure'
  if (TRANSIENT_PATTERN.test(text)) return 'transient'
  return 'real_failure'
}

const FAILURE_TAIL_MAX_CHARS = 400

export function classifyFailureTail({ exitCode, stderr = '', stdout = '' }) {
  if (exitCode === 0 || exitCode === null) return ''
  const text = `${stderr}\n${stdout}`.trim()
  if (!text) return ''
  return text.length <= FAILURE_TAIL_MAX_CHARS ? text : text.slice(-FAILURE_TAIL_MAX_CHARS)
}

export function runChild({ command, args, cwd, env, stallKillSec, windowStartMs, horizonDeadlineMs = null, echoStdout = true, progressAwareStall = true }) {
  return new Promise((resolvePromise) => {
    // Cooperative caps: an explicit stall bound and/or the run horizon. Both are opt-in.
    const limits = []
    if (Number(stallKillSec) > 0) limits.push(Number(stallKillSec) * 1000)
    if (horizonDeadlineMs) {
      const remaining = horizonDeadlineMs - Date.now()
      if (remaining <= 0) {
        resolvePromise({ status: null, signal: 'HORIZON', error: new Error('horizon_reached'), stallKilled: false, elapsedMs: Date.now() - windowStartMs })
        return
      }
      limits.push(remaining)
    }
    const limitMs = limits.length ? Math.min(...limits) : 0

    // #278: stderr is piped (was 'inherit') so failure output reaches the telemetry;
    // it still streams through to the relay log, unchanged for humans.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env, detached: true })
    let settled = false
    let timer = null
    let stdoutText = ''
    let stderrText = ''

    // #300 progress-aware stall watchdog: output activity re-arms the stall timer,
    // so a chatty-but-healthy child is never killed mid-stream. A true stall (no
    // output for the full bound) still terminates it. Horizon stays absolute.
    const armStallTimer = () => {
      if (!limitMs || !child.pid || settled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // Graceful first, hard kill 5s later; never a routine hard kill.
        try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
        }, 5000)
        finish(null, 'SIGTERM', null, true)
      }, limitMs)
    }

    // Capture the sibling's stdout (single-shot CLIs print tool-call JSON instead of
    // writing files), while still streaming it through to the relay log.
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdoutText += text
      if (progressAwareStall) armStallTimer()
      if (echoStdout) { try { process.stdout.write(text) } catch { /* log stream closed */ } }
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderrText += text
      if (progressAwareStall) armStallTimer()
      if (echoStdout) { try { process.stderr.write(text) } catch { /* log stream closed */ } }
    })
    const finish = (status, signal, error, stallKilled) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ status, signal, error, stallKilled, elapsedMs: Date.now() - windowStartMs, stdout: stdoutText, stderr: stderrText })
    }
    armStallTimer()
    child.on('error', (err) => finish(null, null, err, false))
    child.on('close', (code, signal) => finish(code, signal, null, false))
  })
}

function parseArgs(argv) {
  const opts = {
    mode: 'discover',
    siblings: DEFAULT_SIBLINGS.join(','),
    windows: null,
    softWindowSec: DEFAULT_SOFT_WINDOW_SEC,
    windowSec: null,
    rounds: String(DEFAULT_ROUNDS),
    preset: null,
    modelMap: null,
    allowConserve: false,
    maxConserveWindows: DEFAULT_MAX_CONSERVE_WINDOWS,
    subTurns: 1,
    stallKillSec: DEFAULT_STALL_KILL_SEC,
    quotaStatus: null,
    quotaAware: false,
    writePlan: null,
    task: null,
    horizonMs: null,
    allowPartialRound: false,
    minSubTurnSec: 30,
    clampToHorizon: false,
    printQuotaStatus: false,
    ringStateDir: DEFAULT_RING_STATE_DIR,
    reportDir: defaultReportDir(),
    workItemId: null,
    planFile: null,
    execute: false,
    json: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--dry-run') opts.execute = false
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--siblings') opts.siblings = argv[++i]
    else if (a === '--windows') opts.windows = argv[++i]
    else if (a === '--soft-window-sec') opts.softWindowSec = argv[++i]
    else if (a === '--window-sec') opts.windowSec = argv[++i]
    else if (a === '--rounds') opts.rounds = argv[++i]
    else if (a === '--preset') opts.preset = argv[++i]
    else if (a === '--model-map') opts.modelMap = argv[++i]
    else if (a === '--allow-conserve') opts.allowConserve = true
    else if (a === '--max-conserve-windows') opts.maxConserveWindows = argv[++i]
    else if (a === '--sub-turns') opts.subTurns = argv[++i]
    else if (a === '--stall-kill-sec') opts.stallKillSec = argv[++i]
    else if (a === '--quota-status' || a === 'quota-status') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        opts.printQuotaStatus = true
      } else {
        opts.quotaStatus = argv[++i]
        opts.printQuotaStatus = true
      }
    }
    else if (a === '--ring-state-dir') opts.ringStateDir = argv[++i]
    else if (a === '--report-dir') opts.reportDir = argv[++i]
    else if (a === '--work-item') opts.workItemId = argv[++i]
    else if (a === '--plan-file') opts.planFile = argv[++i]
    else if (a === '--quota-aware') opts.quotaAware = true
    else if (a === '--task') opts.task = argv[++i]
    else if (a === '--horizon-ms') opts.horizonMs = argv[++i]
    else if (a === '--allow-partial-round') opts.allowPartialRound = true
    else if (a === '--min-sub-turn-sec') opts.minSubTurnSec = argv[++i]
    else if (a === '--clamp-to-horizon') opts.clampToHorizon = true
    else if (a === '--write-plan') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) opts.writePlan = 'auto'
      else opts.writePlan = argv[++i]
    }
    else throw new Error(`unknown argument '${a}' (try --help)`)
  }
  return opts
}

const USAGE = `Usage: node scripts/swarm-relay.mjs [options]

Graceful, quota-aware multi-sibling relay with round-robin parent promotion.
No routine hard kill: a window is a cooperative budget; only --stall-kill-sec interrupts.

      --mode <discover|fix>      Relay intent (default: discover)
      --siblings <csv>           Sibling CLIs to alternate (default: hermes,direct)
      --preset <name>            Roster preset (tier1-ring = hermes,direct,gemini-api,opencode)
      --windows <n>              Windows per round (default: 3)
      --rounds <n|continuous>    Rounds to run (default: 1)
      --window-sec <n>           Cooperative window budget in seconds (default: 300)
      --soft-window-sec <n>      Alias for --window-sec
      --model-map <csv|json>     Per-sibling model, e.g. hermes=model,direct=model
      --allow-conserve           Admit CONSERVE pools (agy-*) up to --max-conserve-windows
      --max-conserve-windows <n> Cap on CONSERVE windows (default: 1)
      --stall-kill-sec <n>       Opt-in runaway kill in seconds (default 0 = disabled)
      --quota-status <file>      JSON with per-pool weeklyRemainingPct + conservePools
      --quota-aware              Assert quota-aware admission (enforced during --execute)
      --task <id>                Board task id passed to the publish gate's checkpoint
      --horizon-ms <n>           Wall-clock horizon (default 18000000 = 5h); the earliest active pool-call reset pulls it earlier
      --allow-partial-round      Allow starting a round that cannot finish inside the horizon
      --min-sub-turn-sec <n>     Floor for a window's advisory budget after drift (default 30)
      --clamp-to-horizon         Also cap each sub-turn at the remaining horizon (--horizon-ms)
      --write-plan [file]        Persist the schedule/plan JSON (bare: <state>/relay/<ts>-schedule.json)
      --ring-state-dir <dir>     Ring ledger directory
      --report-dir <dir>         Report directory (default: ~/.local/state/curl-ai-bridge/reports)
      --dry-run                  Print plan only (default)
      --execute                  Run siblings sequentially, waiting for each to finish
      --json                     Emit structured JSON
  -h, --help                     Show this help
`

export async function runRelay(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return { ok: true, help: true }
  }

  const stateDir = statePaths().overnightDir
  // #206: the orchestrator lease lives beside the ring ledger (relay/), per spec —
  // not in the overnight quota dir, so a relay run never blocks an unrelated
  // supervisor's pool ledger (and vice versa).
  const lockDir = opts.ringStateDir || DEFAULT_RING_STATE_DIR
  if (opts.printQuotaStatus && !opts.execute) {
    const statusInfo = readQuotaStatus(opts.quotaStatus)
    const budgets = loadPoolBudgets({
      countCalls: (pool) => countPoolCallsInWindow(stateDir, pool),
      quota: statusInfo.quota,
      conservePools: statusInfo.conservePools
    })
    const budgetsWithEligibility = Object.fromEntries(
      Object.entries(budgets).map(([pool, b]) => [
        pool,
        { ...b, eligible: Boolean(b.admitted && (!b.conserve || opts.allowConserve)) }
      ])
    )
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'quota-status', source: statusInfo.source || 'sqlite', allowConserve: Boolean(opts.allowConserve), budgets: budgetsWithEligibility }, null, 2)}\n`)
    } else {
      const lines = [
        `swarm relay quota-status (source=${statusInfo.source || 'sqlite'} | 5h window + live weekly/CONSERVE admission):`,
        ...Object.values(budgetsWithEligibility).map((b) => formatQuotaStatusLine(b))
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return { ok: true, mode: 'quota-status', source: statusInfo.source || 'sqlite', budgets: budgetsWithEligibility }
  }

  const plan = buildRelayPlan({
    mode: opts.mode,
    siblings: opts.siblings,
    windows: opts.windows,
    softWindowSec: opts.softWindowSec,
    windowSec: opts.windowSec,
    rounds: opts.rounds,
    preset: opts.preset,
    modelMap: parseModelMap(opts.modelMap),
    reportDir: opts.reportDir
  })
  const startedAt = new Date().toISOString()
  const relayStartMs = Date.now()
  const minSubTurnSec = positiveInt(opts.minSubTurnSec, 30, 'minSubTurnSec')

  if (!opts.execute) {
    // Persist the schedule artifact for cross-session inspection ($0).
    let schedulePath = null
    if (opts.writePlan) {
      const stateRoot = resolve(statePaths().root)
      schedulePath = opts.writePlan === 'auto'
        ? join(stateRoot, 'relay', `${startedAt.replace(/[:.]/g, '-')}-schedule.json`)
        : resolve(opts.writePlan)
      // Fail closed: schedule artifacts must stay inside the curl-ai-bridge state root.
      const rel = relative(stateRoot, schedulePath)
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`--write-plan path outside the state dir is not allowed: ${schedulePath}`)
      }
      mkdirSync(dirname(schedulePath), { recursive: true })
      protectedWriteFile(schedulePath, `${JSON.stringify({ ok: true, mode: 'dry-run', executed: false, startedAt, quotaAware: Boolean(opts.quotaAware), plan }, null, 2)}\n`, { mode: 0o600 })
      process.stderr.write(`relay: schedule written -> ${schedulePath}\n`)
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'dry-run', executed: false, startedAt, quotaAware: Boolean(opts.quotaAware), schedulePath, plan }, null, 2)}\n`)
    } else {
      let copilotSeen = 0
      const lines = [
        `relay plan (dry-run): mode=${plan.mode} windows=${plan.windows} rounds=${plan.rounds} siblings=${plan.siblings.join('->')}${opts.quotaAware ? ' quotaAware=yes' : ''}`,
        `window=${plan.softWindowSec}s noHardKill=${plan.noHardKill} stallKillSec=${opts.stallKillSec} execution=${plan.execution} report_dir=${plan.reportDir}`,
        ...plan.assignments.map((a) => {
          const tags = []
          if (a.pool === 'github-copilot') {
            copilotSeen += 1
            // Runtime admission caps copilot at 1 call / 5h; later nominal slots are substituted.
            if (copilotSeen > 1) tags.push('cap-gated <=1 copilot/5h')
          }
          if (a.conserve && !opts.allowConserve) tags.push('conserve-excluded')
          return `  w${a.window} r${a.round} [${a.job}] ${a.sibling} (${a.pool})${tags.length ? ` [${tags.join(', ')}]` : ''} -> ${a.reportPath}`
        }),
        `summary -> ${plan.summaryReportPath}`,
        'dry-run: no sibling CLIs spawned (pass --execute to run)'
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
    }

    return { ok: true, mode: 'dry-run', executed: false, plan, schedulePath }
  }

  // #206 split-brain containment, #209 resource-scoped leases. Only `--execute` runs
  // take leases; a live holder is never preempted and the caller fails closed with
  // diagnostics. Two resources: relay's own ring ledger, and the shared quota ledger
  // that both relay and the overnight supervisor write.
  const held = []
  const releaseLocks = () => {
    while (held.length) {
      const h = held.pop()
      releaseOrchestratorLock({
        stateDir: h.dir, runId: plan.runId, generation: h.lock.generation, resource: h.resource
      })
    }
  }
  const acquireResource = (resource, dir) => {
    const res = acquireOrchestratorLock({
      stateDir: dir,
      runId: plan.runId,
      resource,
      holder: 'swarm-relay',
      auditDir: statePaths().root
    })
    if (!res.ok) return res
    held.push({ resource, dir, lock: res.lock })
    return res
  }
  let failure = null
  // MC-206-LOCK-SCOPE: the shared orchestrator lease comes first (consistent
  // ordering with overnight/run/queue-run/case-solve prevents ABBA deadlock),
  // giving full cross-entrypoint mutual exclusion.
  // AUTH-001 #307: mechanical authorization pre-flight — an unauthorized actor
  // never reaches the lease. Fail-closed exit 4.
  const authGate = entrypointAuthorizationGate({ actorId: process.env.SWARM_ACTOR_ID || null, actionClass: 'mutate', resource: '/orchestrator', env: process.env })
  if (!authGate.authorized) {
    process.stderr.write(`swarm-relay: authorization denied: ${authGate.reason} actor=${authGate.actorId}\n`)
    process.exit(4)
  }
  for (const [resource, dir] of [['orchestrator', statePaths().root], ['relay-ring', lockDir], ['quota-ledger', stateDir]]) {
    const res = acquireResource(resource, dir)
    if (!res.ok) { failure = res; break }
  }
  if (failure) {
    process.stderr.write(
      `swarm-relay: ${failure.reason}: resource=${failure.lockPath?.split('/').pop()} `
      + `holder=${failure.holder} runId=${failure.runId} pid=${failure.pid} `
      + `ageSec=${failure.ageSec} expiresAt=${failure.expiresAt}\n`
    )
    releaseLocks()
    return { ok: false, mode: 'execute', executed: false, stopReason: failure.reason, lock: failure }
  }
  // #216: pool-call writes must carry the active quota-ledger lease generation.
  const quotaLedgerLease = () => {
    const h = held.find((x) => x.resource === 'quota-ledger')
    return h ? { runId: plan.runId, generation: Number(h.lock.generation), pid: Number(h.lock.pid) } : null
  }
  // Heartbeat (#209 / case-swarm-lease-lifecycle): renew every third of the TTL so a long
  // round cannot lose a lease it still legitimately holds.
  const heartbeatMs = Math.max(60_000, Math.floor(DEFAULT_ORCHESTRATOR_LOCK_TTL_MS / 3))
  const heartbeat = setInterval(() => {
    for (const h of held) {
      renewOrchestratorLock({
        stateDir: h.dir, runId: plan.runId, generation: h.lock.generation,
        pid: h.lock.pid, resource: h.resource, ttlMs: DEFAULT_ORCHESTRATOR_LOCK_TTL_MS
      })
    }
  }, heartbeatMs)
  heartbeat.unref?.()
  // Release on normal exit/error exit, and explicitly on signals so a stall kill or
  // Ctrl-C cannot strand a lease for its full TTL.
  process.on('exit', () => {
    clearInterval(heartbeat)
    releaseLocks()
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      clearInterval(heartbeat)
      releaseLocks()
      process.kill(process.pid, sig)
    })
  }

  // #210: a work-item-driven round declares its binding explicitly. The pre-build guard
  // proves planRevision/baseHeadSha are still current, then ensures the tree is safe to
  // edit. Fail-closed; both flags must be supplied together.
  // #210/#213 work-item context. Populated only when the round declares its binding.
  const stateRoot = statePaths().root
  const workItemRegistryDir = join(stateRoot, 'registries', 'work-items')
  let activeWorkItem = null
  let workItemWriteLease = null

  if (opts.workItemId || opts.planFile) {
    if (!opts.workItemId || !opts.planFile) {
      process.stderr.write('swarm-relay: --work-item and --plan-file must be supplied together\n')
      return { ok: false, mode: 'execute', executed: false, stopReason: 'incomplete_work_item_binding' }
    }
    const cwd = resolve(new URL('..', import.meta.url).pathname)
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
    const headSha = String(headRes.stdout || '').trim() || null
    const workItem = readWorkItem(workItemRegistryDir, opts.workItemId)
    if (!workItem) {
      process.stderr.write(`swarm-relay: work_item_not_found: ${opts.workItemId} (${workItemRegistryDir})\n`)
      return { ok: false, mode: 'execute', executed: false, stopReason: 'work_item_not_found' }
    }
    activeWorkItem = workItem
    const ring = held.find((h) => h.resource === 'relay-ring')
    if (ring) {
      workItemWriteLease = { dir: ring.dir, resource: 'relay-ring', runId: plan.runId, pid: ring.lock.pid, generation: ring.lock.generation }
    }
    const guard = preBuildGuard({
      repoDir: cwd,
      workItemId: opts.workItemId,
      planPath: resolve(opts.planFile),
      workItem,
      headSha,
      backupRoot: statePaths().repoCheckpointsDir,
      allowRestore: false,
      quarantine: quarantineDirtyWorktree,
      auditDir: statePaths().root
    })
    if (!guard.ok) {
      process.stderr.write(`swarm-relay: pre_build_guard:${guard.reason} workItem=${opts.workItemId}\n`)
      return { ok: false, mode: 'execute', executed: false, stopReason: guard.reason, guard }
    }
    process.stdout.write(
      `swarm-relay: pre_build_guard ok workItem=${opts.workItemId} `
      + `planRevision=${workItem.currentPlanRevision ?? 'n/a'} quarantine=${guard.reason}\n`
    )
  }

  const cwd = resolve(new URL('..', import.meta.url).pathname)
  const { quota, conservePools } = readQuotaStatus(opts.quotaStatus)
  const budgets = loadPoolBudgets({
    countCalls: (pool) => countPoolCallsInWindow(stateDir, pool),
    quota,
    conservePools
  })

  // Phase 3 horizon: 5h cap, pulled earlier only by pools that actually have a 5h cap.
  const horizonDeadlineMs = computeHorizonDeadlineMs({
    relayStartMs,
    maxHorizonMs: positiveInt(opts.horizonMs, DEFAULT_HORIZON_MS, 'horizonMs'),
    ledgerPath: join(stateDir, 'pool-calls-5h.jsonl'),
    cappedPools: new Set(Object.entries(budgets).filter(([, b]) => b.limitKnown && Number.isFinite(b.cap)).map(([k]) => k))
  })
  let cumulativeDriftMs = 0
  let lastWindowDriftMs = 0

  // Each invocation gets a fresh, run-scoped ledger: no slot/parent carry-over.
  // The runId comes from the plan so ring state and artifact names share one stamp (#206).
  const runId = plan.runId
  let ringState = createRingState({ siblings: plan.siblings, mode: plan.mode, nowIso: startedAt, generation: 0, runId })

  const windows = []
  let stopReason = 'completed'
  let conserveWindowsUsed = 0
  // SWARM-BACKOFF-RING-001: per-entity backoff state carried across windows in this run.
  let backoff = {}
  let roundBase = null
  const roundVerdicts = new Map()
  const roundVerdictPaths = new Map()
  let roundPreExisting = []
  const backupRoot = statePaths().repoCheckpointsDir
  const totalWindows = plan.rounds === 'continuous' ? Number.POSITIVE_INFINITY : plan.windows * plan.rounds

  // #222: W1..W4 are forbidden from committing. The scoped hook is installed at
  // each round start, removed before W5 publish, and removed again on error/exit.
  try {
  for (let index = 0; index < totalWindows; index += 1) {
    if (index % plan.siblings.length === 0) {
      roundBase = roundBaseSha(cwd)
      // Pre-round baseline: snapshot anything already dirty so a later REJECT can restore it,
      // and remember which files existed before the build window touched them.
      roundPreExisting = modifiedFilesSince({ repoDir: cwd, baseSha: roundBase })
      snapshotRestorePoints(roundPreExisting, { repoDir: cwd, backupRoot })
      // #222: fail-closed W1..W4 guard; removed before W5 publish.
      installForbidCommitHook(cwd)
    }
    const remainingHorizonMs = horizonDeadlineMs - Date.now()
    // Never start a round/window that cannot fit inside the 5h horizon.
    if (index % plan.siblings.length === 0
        && remainingHorizonMs < plan.siblings.length * plan.softWindowSec * 1000
        && !opts.allowPartialRound) {
      stopReason = 'five_hour_horizon_reached'
      break
    }
    if (remainingHorizonMs < plan.softWindowSec * 1000) {
      stopReason = 'five_hour_horizon_reached'
      break
    }
    if (existsSync(plan.killSwitchFile)) {
      stopReason = 'kill_switch_armed'
      break
    }

    const assignment = buildAssignment({
      list: plan.siblings, index, dir: plan.reportDir, planMode: plan.mode,
      softSec: plan.softWindowSec, models: plan.modelMap, allowConserve: opts.allowConserve,
      stamp: plan.runIdShort
    })
    const choice = selectSlot({
      ring: plan.siblings,
      windowIndex: index,
      round: assignment.round,
      budgets,
      modelMap: plan.modelMap,
      allowConserve: opts.allowConserve,
      maxConserveWindows: nonNegativeInt(opts.maxConserveWindows, DEFAULT_MAX_CONSERVE_WINDOWS, 'maxConserveWindows'),
      conserveWindowsUsed,
      backoff,
      nowMs: Date.now()
    })
    // gemini-api primary model: durable per-window round-robin across the Free-tier
    // roster. Persisted in stateDir so restarts continue the cycle (no pile-up on
    // model #1) and the provider's ~200 req/day budget spreads evenly. An explicit
    // --model-map gemini-api=<model> still wins.
    let rotation = null
    if (choice.admitted && choice.sibling === 'gemini-api' && !plan.modelMap['gemini-api']) {
      rotation = advanceGeminiApiRotation(stateDir)
      choice.model = rotation.primaryModel
    }
    if (choice.conserve) conserveWindowsUsed = choice.conserveWindowsUsed
    if (!choice.admitted) {
      windows.push({
        window: assignment.window, round: assignment.round, sibling: assignment.sibling,
        job: assignment.job, status: 'deferred_quota', reason: choice.reason, elapsedMs: 0, hardKilled: false
      })
      stopReason = 'quota_exhausted'
      break
    }

    const windowStartedAt = new Date().toISOString()
    const windowStartMs = Date.now()
    const deadlineMs = windowStartMs + plan.softWindowSec * 1000
    // $0 pre-pack for W4: the single-shot review CLI has no file tools, so give it the
    // actual diff, parent findings summary and deterministic gates inline.
    const reviewBrief = assignment.job === 'review'
      ? buildReviewBrief({
        repoDir: cwd,
        baseSha: roundBase,
        parentFindingsPath: assignment.parentFindingsPath,
        det: deterministicRoundReview({ repoDir: cwd, baseSha: roundBase })
      })
      : ''
    const prompt = buildSiblingPrompt({
      mode: plan.mode,
      job: assignment.job,
      window: assignment.window,
      windows: totalWindows === Number.POSITIVE_INFINITY ? 'continuous' : totalWindows,
      sibling: choice.sibling,
      siblingSlot: assignment.siblingSlot,
      promotedToParentSlot: assignment.promotedToParentSlot,
      demotedFromParentSlot: assignment.demotedFromParentSlot,
      parentSibling: assignment.parentSibling,
      parentSlot: assignment.parentSlot,
      parentFindingsPath: assignment.parentFindingsPath,
      softWindowSec: plan.softWindowSec,
      reportPath: assignment.findingsPath || assignment.reportPath,
      deadlineIso: new Date(deadlineMs).toISOString(),
      reviewBrief,
      buildBrief: assignment.job === 'build' || assignment.job === 'fix'
        ? buildBuildBrief({ repoDir: cwd, taskId: opts.task })
        : ''
    })

    // Read-only jobs (discover/review) must get the headless read-only flag set;
    // build/fix/publish windows opt into the CLI's write mode explicitly (#205).
    const readOnlyWindow = assignment.job === 'discover' || assignment.job === 'review'
    const { command, args } = buildSiblingCommand(choice.sibling, { prompt, model: choice.model, cwd, readOnly: readOnlyWindow })
    // Defense in depth: a publish sibling that self-invokes `swarm checkpoint` is bound
    // to this round's ACCEPT artifact; on a REJECT window no path is exported.
    const roundVerdictPath = roundVerdictPaths.get(assignment.round) || null
    const gateEnv = assignment.job === 'publish' && roundVerdictPath
      ? { SWARM_GATE_VERDICT_PATH: roundVerdictPath, SWARM_WINDOW_ID: `r${assignment.round}-w${assignment.window}` }
      : {}
    const maxSubTurns = positiveInt(opts.subTurns, 1, 'subTurns')
    const childEnvBase = {
      ...process.env,
      ...windowPolicyEnv(assignment.job),
      ...gateEnv,
      SWARM_FORBID_COMMIT: assignment.job === 'publish' ? '0' : '1',
      SWARM_RELAY_WINDOW: String(assignment.window),
      SWARM_RELAY_MODE: plan.mode,
      SWARM_RELAY_JOB: assignment.job,
      SWARM_RELAY_WINDOW_INDEX: String(index),
      SWARM_RELAY_ROUND: String(assignment.round),
      SWARM_RELAY_SLOT: assignment.siblingSlot,
      SWARM_RELAY_PARENT_SLOT: assignment.parentSlot || '',
      SWARM_RELAY_WINDOW_SEC: String(plan.softWindowSec),
      SWARM_RELAY_DEADLINE_AT: new Date(deadlineMs).toISOString(),
      SWARM_WINDOW_DEADLINE_MS: String(deadlineMs)
    }
    let res = null
    let subTurnsExecuted = 0
    let subTurnsStoppedByBudget = false
    for (let subTurn = 1; subTurn <= maxSubTurns; subTurn += 1) {
      if (subTurn > 1) {
        const windowBudgetMs = effectiveWindowBudgetMs({ softWindowSec: plan.softWindowSec, windowDriftMs: lastWindowDriftMs, minSubTurnSec })
        if (Date.now() - windowStartMs >= windowBudgetMs || horizonDeadlineMs - Date.now() <= 0) {
          subTurnsStoppedByBudget = true
          break
        }
      }
      subTurnsExecuted += 1
      res = await runChild({
        command, args, cwd, stallKillSec: opts.stallKillSec, windowStartMs,
        horizonDeadlineMs: opts.clampToHorizon ? horizonDeadlineMs : null,
        // --json output must stay machine-readable; a sibling's raw stdout is persisted as
        // findings instead of being echoed onto the relay's stdout (#207).
        echoStdout: !opts.json,
        env: { ...childEnvBase, SWARM_RELAY_SUB_TURN: String(subTurn) }
      })
      if (res.error || res.status !== 0) break
    }

    const exitCode = typeof res.status === 'number' ? res.status : null
    const findingsPath = assignment.findingsPath || assignment.reportPath || null
    // #207: read-only siblings (cline/vibe/codex/direct) often cannot write the findings
    // file themselves. If they exited 0 without writing it, persist their captured stdout
    // as a normalized artifact. Blank stdout stays fail-closed (never a fake finding).
    let findingsWritten = Boolean(findingsPath && existsSync(findingsPath))
    let findingsFallback = null
    if (!findingsWritten && findingsPath && exitCode === 0 && !res.error && res.stallKilled !== true) {
      const normalized = normalizeStdoutFindings({
        stdout: res.stdout || '',
        sibling: choice.sibling,
        job: assignment.job,
        mode: plan.mode,
        round: assignment.round,
        window: assignment.window
      })
      if (normalized.ok) {
        protectedWriteFile(findingsPath, `${JSON.stringify(normalized.doc, null, 2)}\n`)
        findingsWritten = true
        findingsFallback = 'stdout'
      } else {
        findingsFallback = normalized.reason
      }
    }
    const entry = {
      window: assignment.window,
      round: assignment.round,
      job: assignment.job,
      sibling: choice.sibling,
      pool: choice.pool,
      model: choice.model,
      substitutedFor: choice.substitutedFor,
      command,
      argv: args,
      startedAt: windowStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: res.elapsedMs,
      windowSec: plan.softWindowSec,
      softWindowExceeded: res.elapsedMs > plan.softWindowSec * 1000,
      subTurnsExecuted,
      subTurnsStoppedByBudget,
      hardKilled: res.stallKilled === true,
      killedByStallGuard: res.stallKilled === true,
      exitCode,
      signal: res.signal || null,
      status: resolveWindowStatus({ error: res.error, stallKilled: res.stallKilled === true, exitCode, findingsWritten }),
      error: res.error ? String(res.error.code || res.error.message) : null,
      findingsPath,
      findingsWritten,
      findingsFallback
    }
    // SWARM-BACKOFF-RING-001: update per-entity backoff from this window's outcome.
    // Reuse the relay's canonical success classifier so backoff stays consistent
    // with the summary verdict when new success statuses are introduced.
    if (isSuccessfulWindowStatus(entry.status)) {
      recordEntitySuccess(backoff, entry.sibling)
    } else {
      recordEntityFailure(backoff, entry.sibling, { error: entry.error ?? null, nowMs: Date.now() })
    }
    ringState = advanceRingState(ringState, assignment, {
      model: choice.model, pool: choice.pool, findingsPath: assignment.findingsPath
    })
    ringState.conserveWindowsUsed = conserveWindowsUsed
    writeRingState(opts.ringStateDir, ringState)

    windows.push(entry)
    writeReport(assignment.reportPath, { ...entry, mode: plan.mode, noHardKill: true })

    // Phase 1 publish gate: W4 leaves a verdict contract, W5 acts on it deterministically.
    if (assignment.job === 'review') {
      const modified = modifiedFilesSince({ repoDir: cwd, baseSha: roundBase })
      const testFile = pickFocusedTest(modified)
      const det = deterministicRoundReview({ repoDir: cwd, baseSha: roundBase, testFile })
      const headNow = roundBaseSha(cwd)
      const headDrift = Boolean(roundBase && headNow && headNow !== roundBase)
      // The review CLI has no file tools; recover its verdict from stdout.
      const siblingVerdict = parseSiblingVerdict(res.stdout)
      let artifact = readReviewVerdict(findingsPath, { windowStartedAtMs: windowStartMs })
      if (siblingVerdict) {
        protectedWriteFile(findingsPath, `${JSON.stringify({
          schema: 'review-verdict/v1',
          windowStartedAtMs: windowStartMs,
          roundStartHeadSha: roundBase,
          verdict: siblingVerdict,
          reason: `w4_sibling_stdout_${siblingVerdict.toLowerCase()}`,
          source: 'w4_sibling_stdout'
        }, null, 2)}\n`)
        artifact = { verdict: siblingVerdict, reason: `w4_sibling_stdout_${siblingVerdict.toLowerCase()}`, source: findingsPath }
      }
      const detOk = Boolean(det.ok && !headDrift && modified.length > 0)
      const verdict = evaluateReviewGate({
        artifactVerdict: artifact.verdict,
        artifactReason: artifact.reason,
        detOk,
        detReason: reviewGateReason({ detReason: det.reason, modifiedCount: modified.length, headDrift }),
        headDrift,
        deterministicOnly: Boolean(!siblingVerdict && det.ok && !headDrift && modified.length > 0)
      })
      roundVerdicts.set(assignment.round, verdict)
      roundVerdictPaths.set(assignment.round, artifact.source || null)
      entry.reviewVerdict = verdict
      // #213: circuit breakers on the live W2/W4 verdict path. A rejection before any
      // successful build window in this run counts as a plan REPLAN; after one it is a
      // REBUILD. Overflow walks the adjacent tiers into a Case instead of looping.
      if (opts.workItemId && activeWorkItem && verdict.verdict === 'REJECT') {
        const builtThisRun = windows.some((w) => w.job === 'build' && w.status === 'ok')
        const handler = builtThisRun ? applyRebuildVerdict : applyReplanVerdict
        try {
          const outcome = handler({
            workItem: activeWorkItem,
            caseOptions: [
              { id: 'retry-with-guidance', label: 'Re-run the window with the reviewer critique as guidance' },
              { id: 'operator-review', label: 'Escalate to the operator for a design decision' }
            ],
            ctx: { reason: verdict.reason || 'review_reject' },
            persist: (rec) => writeWorkItem(workItemRegistryDir, rec, {
              expectedStateVersion: activeWorkItem.stateVersion,
              lease: workItemWriteLease
            }),
            auditDir: stateRoot
          })
          if (outcome.action === 'demoted_to_case') {
            stopReason = 'demoted_to_case'
            windows.push({
              ...entry, status: 'demoted_to_case', reason: outcome.reason,
              trail: outcome.trail.map((t) => t.hop)
            })
            break
          }
          if (outcome.workItem) activeWorkItem = outcome.workItem
        } catch (err) {
          stopReason = 'state_write_failed'
          process.stderr.write(`swarm-relay: circuit_breaker:${String(err?.message || err)}\n`)
          break
        }
      }
    }
    if (assignment.job === 'publish') {
      // #222: W1..W4 enforcement ends here; W5 is the only window allowed to commit.
      removeForbidCommitHook(cwd)
      const verdict = roundVerdicts.get(assignment.round) || { verdict: 'REJECT', reason: 'missing_verdict_artifact' }
      const verdictArtifactPath = roundVerdictPaths.get(assignment.round) || null
      const gate = applyPublishGate({
        verdict,
        repoDir: cwd,
        baseSha: roundBase,
        reportDir: plan.reportDir,
        sibling: choice.sibling,
        quotaPool: choice.pool,
        taskId: opts.task || null,
        backupRoot,
        preExisting: roundPreExisting,
        verdictArtifactPath,
        windowId: `r${assignment.round}-w${assignment.window}`,
        gateSource: verdict.reason || null
      })
      entry.publishGate = {
        verdict: verdict.verdict,
        reason: verdict.reason,
        action: gate.action,
        ok: gate.ok !== false,
        files: gate.files,
        commitSha: gate.commitSha || null,
        gate: gate.gate || null,
        remaining: gate.remaining || [],
        replanPath: gate.replanPath || null
      }
      // Advance the pinned task after a W5 checkpoint_pushed for subsequent rounds.
      if (gate.action === 'checkpoint_pushed' && opts.task && cwd) {
        const nextTaskId = advanceTaskAfterCheckpoint({ currentTaskId: opts.task, repoDir: cwd })
        if (nextTaskId) {
          // Per-round ledger attribution: the publish window owned the previous task.
          entry.publishGate.nextTaskId = nextTaskId
          opts.task = nextTaskId
        } else {
          // No next eligible task: stop/idle cleanly after this round.
          entry.taskAdvance = { from: opts.task, to: null, idle: true }
          stopReason = 'no_next_task'
        }
      }
      // Fail loudly: never relay into the next round with unreviewed dirty files.
      if (gate.ok === false) {
        stopReason = 'publish_cleanup_failed'
        writeReport(w5CleanupReportPath({ assignment }), { ...entry, mode: plan.mode, noHardKill: true })
        break
      }
    }

    // Phase 3 drift accounting: charge overruns to subsequent windows' advisory budget.
    const windowDriftMs = Math.max(0, (res.elapsedMs || 0) - plan.softWindowSec * 1000)
    cumulativeDriftMs += windowDriftMs
    lastWindowDriftMs = windowDriftMs

    // Model telemetry + quota ledger: one row per real CLI attempt against the pool used.
    const windowTelemetry = {
      primaryModel: rotation ? rotation.primaryModel : (choice.model || null),
      attemptedModels: [],
      answeredModel: null,
      // #278: prompt size per attempt makes SIBLING_PROMPT_LIMITS measurable from reports.
      promptChars: prompt.length
    }
    const recordAttempt = ({ model, status, exitCode = null, signal = null, error = null, res = null }) => {
      const attempt = { model: model ?? null, status, exitCode: exitCode ?? null, signal: signal ?? null }
      if (error) attempt.error = String(error)
      if (res && exitCode !== 0) {
        const failureClass = classifyFailure({ exitCode, stderr: res.stderr || '', stdout: res.stdout || '' })
        if (failureClass) {
          attempt.failureClass = failureClass
          const tail = classifyFailureTail({ exitCode, stderr: res.stderr || '', stdout: res.stdout || '' })
          if (tail) attempt.stderrTail = tail
        }
      }
      windowTelemetry.attemptedModels.push(attempt)
      if (choice.pool) {
        recordPoolCall(stateDir, {
          quotaPool: choice.pool,
          taskId: `relay-w${assignment.window}`,
          status,
          primaryModel: windowTelemetry.primaryModel,
          attemptedModels: windowTelemetry.attemptedModels.map((a) => ({ ...a })),
          answeredModel: windowTelemetry.answeredModel,
          lease: quotaLedgerLease()
        })
      }
    }
    const flushWindowReport = () => {
      Object.assign(entry, windowTelemetry)
      writeReport(assignment.reportPath, { ...entry, mode: plan.mode, noHardKill: true })
    }

    if (exitCode === 0) {
      windowTelemetry.answeredModel = choice.model || null
      recordAttempt({ model: choice.model, status: 'ok', exitCode: 0, signal: res.signal || null })
      flushWindowReport()
    } else if (res.error && res.error.code === 'ENOENT') {
      // Missing CLI: account the skipped call once, then keep relaying.
      recordAttempt({ model: choice.model, status: 'missing_cli', exitCode, signal: res.signal || null, error: res.error.code })
      flushWindowReport()
      continue
    } else {
      // Failed primary attempt (CLI_OUTCOME_FAILED / non-zero exit).
      recordAttempt({
        model: choice.model,
        status: `exit_${exitCode ?? 'null'}`,
        exitCode,
        signal: res.signal || null,
        error: res.error ? String(res.error.code || res.error.message) : null,
        res
      })

      // Exactly ONE alternate gemini-api model per window, then straight to hermes.
      if (choice.sibling === 'gemini-api') {
        const altModel = rotation ? rotation.alternateModel : alternateModelForPrimary(choice.model)
        const altCmd = buildSiblingCommand('gemini-api', { prompt, model: altModel })
        const altRes = await runChild({
          command: altCmd.command, args: altCmd.args, cwd, stallKillSec: opts.stallKillSec, windowStartMs: Date.now(),
          horizonDeadlineMs: opts.clampToHorizon ? horizonDeadlineMs : null,
          echoStdout: !opts.json,
          env: { ...childEnvBase }
        })
        const altCode = typeof altRes.status === 'number' ? altRes.status : null
        if (!altRes.error && altCode === 0) {
          windowTelemetry.answeredModel = altModel
          recordAttempt({ model: altModel, status: 'ok', exitCode: 0, signal: altRes.signal || null })
          entry.status = 'ok_after_model_retry'
          entry.modelRetry = {
            primaryModel: windowTelemetry.primaryModel,
            alternateModel: altModel,
            attempts: windowTelemetry.attemptedModels.map((a) => ({ ...a }))
          }
          flushWindowReport()
          continue
        }
        recordAttempt({
          model: altModel,
          status: `exit_${altCode ?? 'null'}`,
          exitCode: altCode,
          signal: altRes.signal || null,
          error: altRes.error ? String(altRes.error.code || altRes.error.message) : null,
          res: altRes
        })
      }

      // Self-healing failover: retry once with an alternate $0 sibling (hermes or direct)
      const fallbackSibling = choice.sibling === 'hermes' ? 'direct' : 'hermes'
      const fbPool = poolForSibling(fallbackSibling)
      const fbCmd = buildSiblingCommand(fallbackSibling, { prompt })
      const fbStartMs = Date.now()
      const fbRes = await runChild({
        command: fbCmd.command, args: fbCmd.args, cwd, stallKillSec: opts.stallKillSec, windowStartMs: fbStartMs,
        horizonDeadlineMs: opts.clampToHorizon ? horizonDeadlineMs : null,
        env: { ...childEnvBase, SWARM_RELAY_FALLBACK_FROM: choice.sibling }
      })
      const fbCode = typeof fbRes.status === 'number' ? fbRes.status : null
      // Account the call against the pool that actually ran, and attribute the slot to it.
      const fbFailureClass = classifyFailure({ exitCode: fbCode, stderr: fbRes.stderr || '', stdout: fbRes.stdout || '' })
      recordPoolCall(stateDir, {
        quotaPool: fbPool,
        taskId: `relay-w${assignment.window}`,
        status: !fbRes.error && fbCode === 0 ? 'ok' : `exit_${fbCode ?? 'null'}`,
        lease: quotaLedgerLease(),
        ...(fbFailureClass ? { failureClass: fbFailureClass, stderrTail: classifyFailureTail({ exitCode: fbCode, stderr: fbRes.stderr || '', stdout: fbRes.stdout || '' }) } : {})
      })
      ringState.slots[assignment.siblingSlot] = {
        ...(ringState.slots[assignment.siblingSlot] || {}),
        cli: fallbackSibling,
        pool: fbPool,
        model: null,
        findingsPath: assignment.findingsPath
      }
      ringState.activeSlot = assignment.siblingSlot
      ringState.updatedAt = new Date().toISOString()
      writeRingState(opts.ringStateDir, ringState)
      entry.failover = {
        fallbackSibling,
        pool: fbPool,
        elapsedMs: fbRes.elapsedMs,
        exitCode: fbCode,
        killedByStallGuard: fbRes.stallKilled === true,
        status: !fbRes.error && fbCode === 0 ? 'ok' : 'failed'
      }
      if (entry.failover.status === 'ok') {
        entry.status = 'ok_after_failover'
        flushWindowReport()
        continue
      }
      stopReason = 'sibling_failed'
      flushWindowReport()
    }
  }
  } finally {
    removeForbidCommitHook(cwd)
  }

  const roundsCompleted = new Set(windows.map((w) => w.round)).size
  ringState.finishedAt = new Date().toISOString()
  ringState.stopReason = stopReason
  ringState.relayStartMs = relayStartMs
  ringState.horizonDeadlineMs = horizonDeadlineMs
  ringState.cumulativeDriftMs = cumulativeDriftMs
  ringState.roundsCompleted = roundsCompleted
  writeRingState(opts.ringStateDir, ringState)

  // #303: inline discovery-registration — candidates found while carrying out this
  // task are registered immediately regardless of scope. The relay already holds
  // the orchestrator lease, so registration is serialized; execution scope is
  // untouched (discovered items land as queued tasks / open cases for later).
  let inlineDiscovery = null
  if (opts.execute) {
    try {
      const paths = statePaths()
      const { registerDiscoveredImmediately } = await import('./swarm-discover.mjs')
      inlineDiscovery = registerDiscoveredImmediately({
        repoDir: cwd,
        queueDir: paths.queueActiveDir,
        caseDir: paths.casesDir,
        auditDir: paths.root
      })
    } catch { inlineDiscovery = { ok: false, reason: 'inline_registration_error' } }
  }

  const summary = {
    ok: windows.every((w) => isSuccessfulWindowStatus(w.status)),
    mode: 'execute',
    executed: true,
    relayMode: plan.mode,
    stopReason,
    relayStartMs,
    horizonDeadlineMs,
    cumulativeDriftMs,
    roundsCompleted,
    noHardKill: true,
    inlineDiscovery,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan,
    windows
  }
  writeReport(plan.summaryReportPath, summary)

  if (opts.json) process.stdout.write(`${JSON.stringify({ ...summary, reportPath: plan.summaryReportPath }, null, 2)}\n`)
  else {
    const ran = windows.map((w) => `w${w.window}:${w.sibling}=${w.status}(${Math.round(w.elapsedMs / 1000)}s)`).join(' ')
    process.stdout.write(`relay (execute): ${stopReason} | ${ran || 'no windows run'} | <- ${plan.summaryReportPath}\n`)
  }
  return { ...summary, reportPath: plan.summaryReportPath }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runRelay(process.argv.slice(2))
    .then((result) => {
      if (result && result.mode === 'execute' && result.ok === false) process.exitCode = 1
    })
    .catch((err) => {
      process.stderr.write(`swarm-relay: ${err.message}\n`)
      process.exitCode = 2
    })
}

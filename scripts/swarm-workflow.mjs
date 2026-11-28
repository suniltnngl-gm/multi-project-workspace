#!/usr/bin/env node
/**
 * W2 (#291) — Reusable Workflow Registry.
 *
 * A workflow is declarative data (`workflow/v1`): ordered steps, each mapping to
 * an existing swarm entrypoint with fixed args, an optional `when` gate on the
 * previous step's outcome, and an evidence requirement. Proven sequences become
 * data instead of code, so new project types are registered, not programmed.
 *
 * - `buildWorkflowPlan(def)` is pure: it validates and returns per-step commands
 *   (never spawns) — $0, fully testable.
 * - `runWorkflow(def, { execute })` dry-runs by default; `--execute` spawns each
 *   step sequentially and records a run-ledger row per step.
 * - Built-in `full-cycle` mirrors overnight's Decide+Measure loop
 *   (discover -> case-solve --sandbox -> measure) as the first registered workflow.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { statePaths } from './swarm-state-paths.mjs'
import { classifyMutationRisk } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

/**
 * Operator policy: only unrecoverable mutations escalate to the operator (fail
 * closed, already wired via classifyMutationRisk); wholesale reverts are never
 * allowed anywhere; the only revert is the atomic last-edit diff via
 * protectedWriteFile/undoLastEdit (lean backup, thin undo). A workflow `command:`
 * step is raw argv, so it is screened here — any unrecoverable pattern is a
 * validation failure, not a runtime surprise.
 */
export function commandStepRisk(step) {
  return classifyMutationRisk((step.command || []).join(' '))
}

export const WORKFLOW_SCHEMA = 'workflow/v1'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

/** action -> entrypoint script. Every action is an existing, gated CLI. */
export const WORKFLOW_ACTIONS = Object.freeze({
  discover: 'swarm-discover.mjs',
  'case-solve': 'swarm-case-solve.mjs',
  measure: 'swarm-measure.mjs',
  relay: 'swarm-relay.mjs',
  lessons: 'swarm-lesson-sync.mjs',
  compact: 'swarm-compact.mjs',
  command: null // raw argv in step.command
})

/** Built-in workflows — the proven sequences, now data. */
export const BUILTIN_WORKFLOWS = Object.freeze([
  {
    schema: WORKFLOW_SCHEMA,
    id: 'full-cycle',
    title: 'Decide+Measure full cycle (overnight --full-cycle equivalent)',
    steps: [
      { id: 'discover', action: 'discover', args: ['--mode', 'discover'], when: 'any' },
      { id: 'solve', action: 'case-solve', args: ['--sandbox'], when: 'any' },
      { id: 'measure', action: 'measure', args: [], when: 'any', evidence: 'ledger' }
    ]
  },
  {
    schema: WORKFLOW_SCHEMA,
    id: 'decide-measure',
    title: 'Decide + Measure only (no discovery)',
    steps: [
      { id: 'solve', action: 'case-solve', args: ['--sandbox'], when: 'any' },
      { id: 'measure', action: 'measure', args: [], when: 'any', evidence: 'ledger' }
    ]
  }
])

export function validateWorkflow(def) {
  if (!def || typeof def !== 'object') return { ok: false, reason: 'workflow_not_an_object' }
  if (def.schema !== WORKFLOW_SCHEMA) return { ok: false, reason: `invalid_schema:${def.schema || 'missing'}` }
  if (!def.id || !/^[a-z0-9][a-z0-9-]*$/.test(String(def.id))) return { ok: false, reason: 'invalid_workflow_id' }
  const steps = def.steps
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'no_steps' }
  for (const [i, s] of steps.entries()) {
    if (!s?.id) return { ok: false, reason: `step_${i}_missing_id` }
    if (!(s.action in WORKFLOW_ACTIONS)) return { ok: false, reason: `step_${i}_unknown_action:${s.action}` }
    if (s.action === 'command' && !Array.isArray(s.command)) return { ok: false, reason: `step_${i}_command_requires_argv` }
    if (s.action === 'command') {
      const risk = commandStepRisk(s)
      if (!risk.allowed) return { ok: false, reason: `step_${i}_${risk.reason}` }
    }
    if (s.when && !['ok', 'any'].includes(s.when)) return { ok: false, reason: `step_${i}_invalid_when:${s.when}` }
    if (s.evidence && s.evidence !== 'ledger') return { ok: false, reason: `step_${i}_invalid_evidence:${s.evidence}` }
  }
  const ids = new Set(steps.map((s) => s.id))
  if (ids.size !== steps.length) return { ok: false, reason: 'duplicate_step_ids' }
  return { ok: true }
}

/**
 * Pure planner: validate + resolve each step to { bin, args }. Never spawns.
 * A step defaults to `when: 'ok'` (skip when the previous step failed) — steps
 * that want unconditional chaining set `when: 'any'`.
 */
export function buildWorkflowPlan(def, { stateDir = null } = {}) {
  const check = validateWorkflow(def)
  if (!check.ok) return { ok: false, reason: check.reason }
  const paths = statePaths(stateDir ? { SWARM_STATE_DIR: stateDir } : undefined)
  const plan = []
  let prevOk = true
  for (const s of def.steps) {
    const when = s.when || (plan.length ? 'ok' : 'any')
    const skip = when === 'ok' && !prevOk
    let command = null
    if (!skip) {
      command = s.action === 'command'
        ? { bin: s.command[0], args: s.command.slice(1) }
        : { bin: process.execPath, args: [resolve(SCRIPTS_DIR, WORKFLOW_ACTIONS[s.action]), ...(s.args || [])] }
    }
    plan.push({
      stepId: s.id,
      action: s.action,
      when,
      skippedByGate: skip,
      evidence: s.evidence || null,
      command,
      stateDirs: { workflowsDir: paths.workflowsDir, casesDir: paths.casesDir, lessonsDir: paths.lessonsDir }
    })
    prevOk = !skip
  }
  return { ok: true, workflowId: def.id, steps: plan }
}

/** Load a workflow by id: <workflowsDir>/<id>.json overrides built-ins. */
export function loadWorkflow(id, { workflowsDir = null, env = process.env } = {}) {
  const dir = workflowsDir || statePaths(env).workflowsDir
  const file = join(dir, `${id}.json`)
  let fileDef = null
  if (existsSync(file)) {
    try { fileDef = JSON.parse(readFileSync(file, 'utf8')) } catch { fileDef = null }
  }
  const def = fileDef || BUILTIN_WORKFLOWS.find((w) => w.id === id) || null
  if (!def) return { ok: false, reason: `workflow_not_found:${id}` }
  return { ok: true, def, source: fileDef ? 'file' : 'builtin' }
}

/** List available workflows (built-ins + registered files). */
export function listWorkflows({ workflowsDir = null, env = process.env } = {}) {
  const dir = workflowsDir || statePaths(env).workflowsDir
  const items = BUILTIN_WORKFLOWS.map((w) => ({ id: w.id, title: w.title, source: 'builtin', steps: w.steps.length }))
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const def = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (!validateWorkflow(def).ok) continue
        // A file with a built-in's id overrides it (loadWorkflow prefers the file) —
        // reflect that here instead of silently listing the stale built-in.
        const idx = items.findIndex((i) => i.id === def.id)
        const entry = { id: def.id, title: def.title || def.id, source: 'file', steps: def.steps.length }
        if (idx >= 0) items[idx] = entry
        else items.push(entry)
      } catch { /* skip corrupt */ }
    }
  }
  return items
}

/**
 * Execute a plan. Dry-run by default (no spawn). --execute runs each non-skipped
 * step sequentially and appends a run-ledger row per step (runId, stepId, status).
 */
export function runWorkflow(def, { execute = false, stateDir = null, runLedgerPath = null, spawnFn = null, now = () => new Date().toISOString() } = {}) {
  const plan = buildWorkflowPlan(def, { stateDir })
  if (!plan.ok) return plan
  const runId = `wf-${def.id}-${Date.now()}`
  const steps = []
  let failed = false
  for (const step of plan.steps) {
    if (step.skippedByGate || (failed && step.when === 'ok')) {
      steps.push({ stepId: step.stepId, status: 'skipped_by_gate' })
      continue
    }
    if (!execute) {
      steps.push({ stepId: step.stepId, status: 'planned', command: step.command })
      continue
    }
    const spawn = spawnFn || spawnSync
    const res = spawn(step.command.bin, step.command.args)
    const ok = res.status === 0
    steps.push({ stepId: step.stepId, status: ok ? 'done' : 'failed', exitCode: res.status })
    if (!ok) failed = true
    if (runLedgerPath) {
      mkdirSync(dirname(runLedgerPath), { recursive: true, mode: 0o700 })
      appendFileSync(runLedgerPath, `${JSON.stringify({ runId, workflowId: def.id, stepId: step.stepId, status: ok ? 'done' : 'failed', exitCode: res.status, at: now() })}\n`, { mode: 0o600 })
    }
  }
  return { ok: !failed, runId, workflowId: def.id, mode: execute ? 'execute' : 'dry-run', steps }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write('Usage: swarm workflow list | run <id> [--state-dir <dir>] [--execute] [--json]\n')
    process.exit(0)
  }
  const sub = argv[0]
  const json = argv.includes('--json')
  const execute = argv.includes('--execute')
  const flag = (n, fb = null) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb }
  const stateDirFlag = flag('--state-dir')
  const env = stateDirFlag ? { ...process.env, SWARM_STATE_DIR: resolve(stateDirFlag) } : process.env
  if (sub === 'list') {
    const items = listWorkflows({ env })
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, workflows: items }, null, 2)}\n`)
    else for (const w of items) process.stdout.write(`${w.id} (${w.source}, ${w.steps} steps): ${w.title}\n`)
    process.exit(0)
  }
  if (sub === 'run') {
    const loaded = loadWorkflow(argv[1], { env })
    if (!loaded.ok) { process.stderr.write(`swarm workflow: ${loaded.reason}\n`); process.exit(2) }
    const res = runWorkflow(loaded.def, { execute, stateDir: stateDirFlag ? resolve(stateDirFlag) : null })
    if (json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    else process.stdout.write(`workflow ${res.workflowId} (${res.mode}): ${res.steps.map((s) => `${s.stepId}=${s.status}`).join(' ')}\n`)
    process.exit(res.ok ? 0 : 1)
  }
  process.stderr.write(`swarm workflow: unknown subcommand '${sub}' (list|run)\n`)
  process.exit(1)
}

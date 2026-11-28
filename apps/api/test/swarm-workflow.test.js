// W2 (#291): reusable workflow registry — validation, pure planning, gated
// execution with a run ledger, built-ins + file registration. All $0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKFLOW_SCHEMA,
  BUILTIN_WORKFLOWS,
  validateWorkflow,
  buildWorkflowPlan,
  loadWorkflow,
  listWorkflows,
  runWorkflow
} from '../../../scripts/swarm-workflow.mjs'

function tmpState() {
  return mkdtempSync(join(tmpdir(), 'wf-'))
}

test('W2: validation rejects bad schema/ids/steps and accepts the built-ins', () => {
  for (const bad of [null, {}, { schema: 'nope/v1', id: 'x', steps: [{ id: 's', action: 'measure' }] }, { schema: WORKFLOW_SCHEMA, id: 'Bad_ID', steps: [{ id: 's', action: 'measure' }] }, { schema: WORKFLOW_SCHEMA, id: 'x', steps: [] }, { schema: WORKFLOW_SCHEMA, id: 'x', steps: [{ id: 's', action: 'brain-surg' }] }, { schema: WORKFLOW_SCHEMA, id: 'x', steps: [{ id: 'a', action: 'measure' }, { id: 'a', action: 'measure' }] }]) {
    assert.equal(validateWorkflow(bad).ok, false, JSON.stringify(bad))
  }
  for (const w of BUILTIN_WORKFLOWS) assert.equal(validateWorkflow(w).ok, true, w.id)
})

test('W2: pure plan resolves entrypoint commands and default ok-gates skip after failure', () => {
  const dir = tmpState()
  try {
    const plan = buildWorkflowPlan(BUILTIN_WORKFLOWS[0], { stateDir: dir })
    assert.equal(plan.ok, true)
    assert.equal(plan.steps.length, 3)
    assert.equal(plan.steps[0].command.args[0].endsWith('swarm-discover.mjs'), true)
    assert.equal(plan.steps[2].evidence, 'ledger')
    // A failing step gates the next (default when: ok)...
    const gated = {
      schema: WORKFLOW_SCHEMA, id: 'gated', title: 'gated',
      steps: [
        { id: 'a', action: 'measure', when: 'any' },
        { id: 'b', action: 'measure' }
      ]
    }
    const planned = runWorkflow(gated, { execute: false, stateDir: dir, spawnFn: () => ({ status: 1 }) })
    assert.equal(planned.steps[0].status, 'planned')
    // ...and at execute time: first fails, second is skipped by the gate.
    const exec = runWorkflow(gated, { execute: true, stateDir: dir, spawnFn: () => ({ status: 1 }) })
    assert.equal(exec.ok, false)
    assert.equal(exec.steps[0].status, 'failed')
    assert.equal(exec.steps[1].status, 'skipped_by_gate')
    assert.equal(exec.steps[1].command, undefined, 'gated steps never plan a command')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('W2: execute runs the happy path in order and appends a run-ledger row per step', () => {
  const dir = tmpState()
  try {
    const calls = []
    const ledgerPath = join(dir, 'workflows', 'runs.jsonl')
    const def = {
      schema: WORKFLOW_SCHEMA, id: 'happy', title: 'happy',
      steps: [
        { id: 'one', action: 'measure', when: 'any' },
        { id: 'two', action: 'measure', when: 'any' }
      ]
    }
    const res = runWorkflow(def, {
      execute: true, stateDir: dir, runLedgerPath: ledgerPath,
      spawnFn: (bin, args) => { calls.push(args[0]); return { status: 0 } }
    })
    assert.equal(res.ok, true)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].endsWith('swarm-measure.mjs'))
    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(rows.map((r) => r.stepId), ['one', 'two'])
    assert.ok(rows.every((r) => r.status === 'done' && r.runId.startsWith('wf-happy-')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('W2: file-registered workflow overrides nothing but lists alongside built-ins; load prefers file', () => {
  const dir = tmpState()
  try {
    const wfDir = join(dir, 'workflows')
    mkdirSync(wfDir, { recursive: true })
    const custom = { schema: WORKFLOW_SCHEMA, id: 'full-cycle', title: 'custom override', steps: [{ id: 'only', action: 'measure', when: 'any' }] }
    writeFileSync(join(wfDir, 'full-cycle.json'), JSON.stringify(custom))
    writeFileSync(join(wfDir, 'broken.json'), '{not json')
    const loaded = loadWorkflow('full-cycle', { workflowsDir: wfDir })
    assert.equal(loaded.source, 'file')
    assert.equal(loaded.def.title, 'custom override')
    const listed = listWorkflows({ workflowsDir: wfDir })
    assert.ok(listed.some((w) => w.id === 'decide-measure' && w.source === 'builtin'))
    assert.ok(listed.some((w) => w.id === 'full-cycle' && w.source === 'file'))
    assert.ok(!listed.some((w) => w.id === 'broken'))
    assert.equal(loadWorkflow('missing', { workflowsDir: wfDir }).reason, 'workflow_not_found:missing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('policy: workflow command steps refuse unrecoverable mutations (wholesale revert never planable)', async () => {
  const { commandStepRisk } = await import('../../../scripts/swarm-workflow.mjs')
  // Wholesale reverts are rejected at validation — the workflow cannot even be planned.
  for (const argv of [['git', 'reset', '--hard'], ['git', 'push', '--force'], ['rm', '-rf', '/tmp/x']]) {
    const def = { schema: WORKFLOW_SCHEMA, id: 'reverter', title: 'no', steps: [{ id: 's', action: 'command', command: argv }] }
    assert.equal(validateWorkflow(def).ok, false, argv.join(' '))
  }
  // The risk classifier is reachable and names the rule.
  assert.equal(commandStepRisk({ command: ['git', 'reset', '--hard'] }).reason, 'blocked_unrecoverable_mutation:git_hard_reset')
  // Safe, recoverable command steps still plan.
  const ok = validateWorkflow({ schema: WORKFLOW_SCHEMA, id: 'safe', title: 'ok', steps: [{ id: 's', action: 'command', command: ['npm', 'test'] }] })
  assert.equal(ok.ok, true)
})

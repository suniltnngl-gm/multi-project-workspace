import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test as it } from 'node:test'
import { createDatabase } from '../src/database.js'
import { reconcileConnection, renderText } from '../../../scripts/tracking-reconcile.mjs'

let directory
let database
let connection

before(() => {
  directory = mkdtemp(join(tmpdir(), 'tracking-reconcile-'))
  return directory.then((path) => {
    directory = path
    database = createDatabase(join(directory, 'fixture.sqlite'))
    connection = database.db
    const now = new Date().toISOString()
    const insert = connection.prepare(`INSERT INTO tasks (title,project,status,decisions,important_context,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    const a = insert.run('A prerequisite', 'curl-ai-bridge', 'blocked', JSON.stringify({schema:'swarm-plan-v1',disposition:'ready_for_serialized_implementation',points:{dependencies_and_prerequisites:'Downstream dependents: #2.'}}), '', now, now).lastInsertRowid
    const b = insert.run('B dependent with self ref', 'curl-ai-bridge', 'blocked', JSON.stringify({schema:'swarm-plan-v1',disposition:'ready_for_serialized_implementation',points:{dependencies_and_prerequisites:'Upstream anchors: #2.'}}), '', now, now).lastInsertRowid
    connection.prepare('INSERT INTO task_events (task_id,action,created_at,run_id) VALUES (?,?,?,NULL)').run(a,'created',now)
    connection.prepare('INSERT INTO task_events (task_id,action,created_at,run_id) VALUES (?,?,?,NULL)').run(b,'created',now)
  })
})

after(async () => {
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('reports planning-event, task-run, agent and self-reference gaps without mutating', () => {
  const before = connection.prepare('SELECT COUNT(*) AS n FROM task_events').get().n
  const report = reconcileConnection(connection, { project: 'curl-ai-bridge' })
  assert.equal(report.summary.tasks, 2)
  assert.equal(report.summary.planningRegisters, 2)
  assert.equal(report.summary.planningGateEvents, 0)
  assert.ok(report.findings.some((item) => item.code === 'planning_gate_provenance_missing'))
  assert.ok(report.findings.some((item) => item.code === 'task_event_run_provenance_incomplete'))
  assert.ok(report.findings.some((item) => item.code === 'agent_task_provenance_not_established'))
  assert.ok(report.findings.some((item) => item.code === 'dependency_self_reference' && item.taskId === 2))
  assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, before)
  assert.match(renderText(report), /Tracking reconciliation/)
})

it('detects an unmatched downstream reference and reports selected task scope', () => {
  const report = reconcileConnection(connection, { project: 'curl-ai-bridge', taskIds: [1,2] })
  assert.ok(report.findings.some((item) => item.code === 'dependency_downstream_reference_unmatched'))
  assert.deepEqual(report.scope.taskIds, [1,2])
  assert.equal(report.scope.selection, 'explicit_ids')
})

it('does not include tasks from another project', () => {
  const report = reconcileConnection(connection, { project: 'not-this-project' })
  assert.equal(report.summary.tasks, 0)
  assert.deepEqual(report.scope.taskIds, [])
})


it('recognizes valid embedded gate payloads separately from dedicated gate events', () => {
  connection.prepare('UPDATE tasks SET important_context=? WHERE id=1').run('PLANNING_GATE: swarm-plan-v1\nGATE_RECORDS_JSON={"version":"swarm-plan-v1","state":"complete","records":[{"criterion":"acceptance_criteria","status":"complete","reviewed":true}]}')
  const report = reconcileConnection(connection, { project: 'curl-ai-bridge' })
  assert.equal(report.summary.embeddedGatePayloads, 1)
  assert.ok(!report.findings.some((item) => item.taskId === 1 && item.code === 'planning_gate_provenance_missing'))
  assert.ok(!report.findings.some((item) => item.taskId === 1 && item.code === 'planning_register_missing'))
})


it('recognizes explicit prerequisite statements without treating incidental self mentions as edges', () => {
  connection.prepare('UPDATE tasks SET decisions=? WHERE id=2').run(JSON.stringify({schema:'swarm-plan-v1',disposition:'ready_for_serialized_implementation',points:{dependencies_and_prerequisites:'Task #1 planning complete; Task #2 implementation remains on HOLD.'}}))
  const report = reconcileConnection(connection, { project: 'curl-ai-bridge' })
  assert.equal(report.summary.dependencyEdges, 1)
  assert.equal(report.summary.selfReferences, 0)
  assert.ok(!report.findings.some((item) => item.code === 'dependency_downstream_reference_missing' && item.relatedTaskIds.includes(2)))
})

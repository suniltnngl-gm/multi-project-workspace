#!/usr/bin/env node
// Portable, read-only reconciliation of task progress evidence.
import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = 'tracking-reconciliation-v1'

function parseTaskIds(text) {
  return [...new Set([...String(text ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1])))]
}

function parseRegister(task) {
  try {
    const value = JSON.parse(task.decisions || '{}')
    if (value && typeof value === 'object' && value.schema === 'swarm-plan-v1') {
      return { schema: value.schema, disposition: value.disposition ?? null, points: value.points ?? {} }
    }
  } catch {}
  return null
}

function hasEmbeddedGatePayload(text) {
  const marker = 'GATE_RECORDS_JSON='
  const line = String(text ?? '').split(/\r?\n/).find((item) => item.startsWith(marker))
  if (!line) return false
  try {
    const payload = JSON.parse(line.slice(marker.length))
    return payload?.version === 'swarm-plan-v1' && Array.isArray(payload.records)
  } catch {
    return false
  }
}

function extractRefs(text, pattern) {
  const refs = new Set()
  for (const match of String(text ?? '').matchAll(pattern)) {
    for (const id of parseTaskIds(match[1])) refs.add(id)
  }
  return [...refs].sort((a, b) => a - b)
}

function dependencySets(register) {
  const text = register?.points?.dependencies_and_prerequisites ?? ''
  const upstream = extractRefs(text, /upstream[^:\n]{0,80}:\s*([^\.\n]+)/gi)
  const downstream = extractRefs(text, /downstream[^:\n]{0,80}:\s*([^\.\n]+)/gi)
  // Common singular forms are retained as upstream evidence.
  for (const match of text.matchAll(/(?:depends on|prerequisite(?:s)?(?: include)?):?\s*(?:Task\s*)?#(\d+)/gi)) {
    upstream.push(Number(match[1]))
  }
  for (const match of text.matchAll(/\bTask\s+#(\d+)\s+(?:planning complete|is an? (?:upstream )?prerequisite)\b/gi)) {
    upstream.push(Number(match[1]))
  }
  return {
    upstream: [...new Set(upstream)].sort((a, b) => a - b),
    downstream: [...new Set(downstream)].sort((a, b) => a - b)
  }
}

function finding(code, severity, taskId, relatedTaskIds, message, source, locator, observedValue, recommendation) {
  return {
    code, severity, taskId, relatedTaskIds,
    message,
    evidence: { source, locator, observedValue },
    recommendation
  }
}

function findCycles(taskIds, edges) {
  const allowed = new Set(taskIds)
  const adjacency = new Map(taskIds.map((id) => [id, []]))
  for (const [taskId, deps] of edges) {
    for (const dep of deps.upstream) {
      if (allowed.has(dep) && adjacency.has(dep)) adjacency.get(dep).push(taskId)
    }
  }
  const state = new Map()
  const stack = []
  const cycles = []
  function visit(node) {
    state.set(node, 1)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) {
        const start = stack.indexOf(next)
        const cycle = [...stack.slice(start), next]
        const key = [...new Set(cycle)].sort((a, b) => a - b).join(',')
        if (!cycles.some((item) => item.key === key)) cycles.push({ key, cycle })
      } else if (!state.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const id of taskIds) if (!state.has(id)) visit(id)
  return cycles.map(({ cycle }) => cycle)
}

export function reconcileConnection(connection, { project = 'curl-ai-bridge', taskIds: requestedIds = null, from = null, to = null } = {}) {
  const conditions = ['project = ?']
  const values = [project]
  if (Array.isArray(requestedIds) && requestedIds.length) {
    conditions.push(`id IN (${requestedIds.map(() => '?').join(',')})`)
    values.push(...requestedIds)
  } else {
    if (from !== null) { conditions.push('id >= ?'); values.push(Number(from)) }
    if (to !== null) { conditions.push('id <= ?'); values.push(Number(to)) }
  }
  const tasks = connection.prepare(`SELECT id,title,project,status,decisions,important_context,requirements,work_blocked,updated_at,agent_run_id FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY id`).all(...values)
  const ids = tasks.map((task) => task.id)
  const idSet = new Set(ids)
  const findings = []
  const edges = new Map()
  const stats = {
    tasks: tasks.length, planningRegisters: 0, planningGateEvents: 0, embeddedGatePayloads: 0,
    events: 0, eventsWithoutToolRun: 0, tasksWithAgentProvenance: 0,
    dependencyEdges: 0, selfReferences: 0, cycles: 0
  }

  for (const task of tasks) {
    const register = parseRegister(task)
    if (register) stats.planningRegisters += 1
    const events = connection.prepare('SELECT id,action,field,run_id FROM task_events WHERE task_id=? ORDER BY id').all(task.id)
    const gateEvents = events.filter((event) => event.action === 'planning_gate_recorded' || event.action === 'planning_gate_reviewed')
    const hasGatePayload = hasEmbeddedGatePayload(task.important_context)
    if (gateEvents.length) stats.planningGateEvents += 1
    if (hasGatePayload) stats.embeddedGatePayloads += 1
    if (register && !gateEvents.length && !hasGatePayload) {
      findings.push(finding('planning_gate_provenance_missing', 'medium', task.id, [], 'A swarm-plan-v1 planning register exists, but no dedicated planning-gate event or embedded gate-record payload was found.', 'tasks + task_events', `task:${task.id}.decisions; task_events.task_id=${task.id}`, { register: true, gateEventCount: 0, embeddedGatePayload: false }, 'Review the historical planning evidence and, if appropriate, append a provenance event; do not infer a gate review from the register alone.'))
    }
    if (!register && !hasGatePayload) {
      findings.push(finding('planning_register_missing', 'low', task.id, [], 'No parseable swarm-plan-v1 planning register was found in the task decisions field.', 'tasks', `task:${task.id}.decisions`, 'missing_or_unparseable', 'Determine whether this task requires a planning gate; record missing evidence explicitly.'))
    }
    const nullRunEvents = events.filter((event) => event.run_id === null)
    stats.events += events.length
    stats.eventsWithoutToolRun += nullRunEvents.length
    if (events.length && nullRunEvents.length) {
      findings.push(finding('task_event_run_provenance_incomplete', 'low', task.id, [], 'One or more task activity events have no linked tool-run provenance.', 'task_events + tool_runs', `task_events.task_id=${task.id}`, { eventCount: events.length, eventsWithoutRunId: nullRunEvents.length }, 'Retain the events; where provenance is recoverable, add a separate auditable attribution rather than fabricating run links.'))
    }

    const agentRun = task.agent_run_id
      ? connection.prepare('SELECT id FROM agent_runs WHERE id=?').get(task.agent_run_id)
      : null
    const runByTask = connection.prepare('SELECT id FROM agent_runs WHERE task_id=? LIMIT 1').get(task.id)
    const ops = connection.prepare('SELECT COUNT(*) AS count FROM agent_task_ops WHERE task_id=?').get(task.id).count
    const proposals = connection.prepare("SELECT COUNT(*) AS count FROM task_proposals WHERE created_task_id=? AND origin_agent_run_id<>''").get(task.id).count
    const linked = Boolean(agentRun || runByTask || ops || proposals)
    if (linked) stats.tasksWithAgentProvenance += 1
    else {
      findings.push(finding('agent_task_provenance_not_established', 'info', task.id, [], 'No task-linked agent run, agent task operation, or created-task proposal provenance was found. This does not prove that no agent participated.', 'tasks + agent_runs + agent_task_ops + task_proposals', `task:${task.id}; related tables by task id`, { agentRunId: task.agent_run_id ?? null, agentRunByTask: Boolean(runByTask), agentTaskOps: ops, createdTaskProposals: proposals }, 'Treat authorship as unknown unless independent run evidence is available; do not backfill inferred agent identity.'))
    }

    const deps = dependencySets(register)
    edges.set(task.id, deps)
    stats.dependencyEdges += deps.upstream.filter((id) => id !== task.id).length
    if (deps.upstream.includes(task.id)) {
      stats.selfReferences += 1
      findings.push(finding('dependency_self_reference', 'high', task.id, [task.id], 'The task lists itself as an upstream dependency.', 'tasks.decisions', `task:${task.id}.decisions.points.dependencies_and_prerequisites`, deps.upstream, 'Review the source dependency declaration; do not silently delete or reinterpret it.'))
    }
  }

  for (const [taskId, deps] of edges) {
    for (const upstreamId of deps.upstream) {
      if (upstreamId === taskId || !idSet.has(upstreamId)) continue
      const reciprocal = edges.get(upstreamId)?.downstream ?? []
      if (!reciprocal.includes(taskId)) {
        findings.push(finding('dependency_downstream_reference_missing', 'medium', upstreamId, [taskId], `Task #${taskId} names this task as an upstream prerequisite, but this task's downstream register does not name #${taskId}.`, 'tasks.decisions', `task:${upstreamId} -> task:${taskId}`, { upstreamDeclaration: true, reciprocalDownstreamDeclaration: false }, 'Review whether the downstream index is intended to be reciprocal; if so, update both sides through an authorized, auditable task-store change.'))
      }
    }
    for (const downstreamId of deps.downstream) {
      if (!idSet.has(downstreamId)) continue
      const downstreamUpstream = edges.get(downstreamId)?.upstream ?? []
      if (!downstreamUpstream.includes(taskId)) {
        findings.push(finding('dependency_downstream_reference_unmatched', 'medium', taskId, [downstreamId], `This task names #${downstreamId} as a downstream dependent, but #${downstreamId} does not name this task upstream.`, 'tasks.decisions', `task:${taskId} -> task:${downstreamId}`, { downstreamDeclaration: true, reciprocalUpstreamDeclaration: false }, 'Review whether this is an intentional contextual reference or an inconsistent dependency index; do not auto-correct.'))
      }
    }
  }

  const cycles = findCycles(ids, edges)
  stats.cycles = cycles.length
  for (const cycle of cycles) {
    findings.push(finding('dependency_cycle', 'high', cycle[0], cycle.slice(1), 'A directed dependency cycle exists within the selected task scope.', 'tasks.decisions', 'dependency graph', cycle, 'Resolve the cycle only after reviewing the authoritative dependency intent.'))
  }

  const counts = {}
  for (const item of findings) counts[item.code] = (counts[item.code] ?? 0) + 1
  return {
    schemaVersion: VERSION,
    generatedAt: new Date().toISOString(),
    scope: { project, taskIds: ids, selection: requestedIds?.length ? 'explicit_ids' : (from !== null || to !== null ? 'id_range' : 'all_project_tasks') },
    summary: { ...stats, findingCount: findings.length, findingsByCode: counts },
    findings
  }
}

function parseArgs(argv) {
  const result = { project: 'curl-ai-bridge', format: 'json' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { result.help = true; continue }
    if (!arg.startsWith('--')) throw new Error(`unexpected_argument:${arg}`)
    const key = arg.slice(2)
    if (key === 'all') { result.all = true; continue }
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`missing_value_for:${arg}`)
    if (key === 'db') result.dbPath = value
    else if (key === 'project') result.project = value
    else if (key === 'tasks') result.taskIds = value.split(',').map(Number)
    else if (key === 'from') result.from = Number(value)
    else if (key === 'to') result.to = Number(value)
    else if (key === 'format') result.format = value
    else throw new Error(`unknown_option:${arg}`)
  }
  if (result.taskIds && result.taskIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('invalid_task_ids')
  if (result.from !== undefined && (!Number.isSafeInteger(result.from) || result.from < 1)) throw new Error('invalid_from')
  if (result.to !== undefined && (!Number.isSafeInteger(result.to) || result.to < 1)) throw new Error('invalid_to')
  if (result.format !== 'json' && result.format !== 'text') throw new Error('format_must_be_json_or_text')
  if (result.taskIds && (result.from !== undefined || result.to !== undefined)) throw new Error('choose_tasks_or_range_not_both')
  return result
}

export function renderText(report) {
  const lines = [
    `Tracking reconciliation: ${report.scope.project}`,
    `Tasks: ${report.summary.tasks}; findings: ${report.summary.findingCount}; dependency cycles: ${report.summary.cycles}`,
    `Planning registers: ${report.summary.planningRegisters}; planning-gate events: ${report.summary.planningGateEvents}; embedded gate payloads: ${report.summary.embeddedGatePayloads}`,
    `Task events: ${report.summary.events}; events without tool-run link: ${report.summary.eventsWithoutToolRun}`,
    `Tasks with agent provenance: ${report.summary.tasksWithAgentProvenance}`
  ]
  for (const item of report.findings) lines.push(`[${item.severity}] ${item.code} task=#${item.taskId ?? '-'} related=${item.relatedTaskIds.join(',') || '-'} — ${item.message}`)
  return lines.join('\n')
}

function help() {
  return [
    'Usage: node scripts/tracking-reconcile.mjs [options]',
    '  --db PATH       SQLite database path (default: apps/api/data/workspace.sqlite)',
    '  --project NAME  project scope (default: curl-ai-bridge)',
    '  --tasks 1,2,3   explicit task IDs',
    '  --from ID       inclusive task ID lower bound',
    '  --to ID         inclusive task ID upper bound',
    '  --format json|text (default: json)',
    'The database is opened read-only. Output is written to stdout only.'
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { console.log(help()); return }
  const dbPath = resolve(options.dbPath ?? 'apps/api/data/workspace.sqlite')
  const connection = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    connection.pragma('query_only = ON')
    const report = reconcileConnection(connection, options)
    console.log(options.format === 'text' ? renderText(report) : JSON.stringify(report, null, 2))
  } finally {
    connection.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) {
    console.error(`tracking_reconcile_error: ${error.message}`)
    process.exitCode = 1
  }
}


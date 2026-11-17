# Portable Tracking Reconciliation Contract

**Contract:** `tracking-reconciliation-v1`  
**Purpose:** Reconcile task progress evidence across reusable workspace task stores without changing the source of truth.

## Command

```sh
node scripts/tracking-reconcile.mjs
node scripts/tracking-reconcile.mjs --project curl-ai-bridge --from 121 --to 145 --format text
node scripts/tracking-reconcile.mjs --project curl-ai-bridge --tasks 121,124,143
node scripts/tracking-reconcile.mjs --db /path/to/workspace.sqlite --project my-project
```

The CLI opens SQLite with `readonly: true`, enables `query_only`, and writes its report only to stdout. It does not migrate, repair, backfill, or otherwise mutate the database. The default database path is relative to the current working directory.

## Reconciled domains

- Planning registers (`swarm-plan-v1`) versus dedicated planning-gate events and parseable embedded `GATE_RECORDS_JSON` payloads. The summary reports dedicated events and embedded payloads separately; a valid embedded payload is not misclassified as a missing planning record.
- Task activity event provenance through `task_events.run_id` and `tool_runs`.
- Agent-to-task provenance through `tasks.agent_run_id`, `agent_runs.task_id`, `agent_task_ops.task_id`, and created-task proposal links.
- Dependency direction, downstream reciprocity, self references, and cycles within the selected task scope.

## Finding semantics

| Code | Meaning |
|---|---|
| `planning_gate_provenance_missing` | A planning register exists but no dedicated gate event or embedded gate record was found. |
| `planning_register_missing` | Neither a parseable `swarm-plan-v1` decision register nor a valid embedded gate-record payload was found. |
| `task_event_run_provenance_incomplete` | One or more task events have a null `run_id`. |
| `agent_task_provenance_not_established` | No supported task-to-agent link was found; this is not proof that no agent participated. |
| `dependency_self_reference` | A task lists itself as an upstream dependency. |
| `dependency_downstream_reference_missing` | A downstream task declares this task upstream, but this task omits the reciprocal downstream reference. |
| `dependency_downstream_reference_unmatched` | A downstream reference has no matching upstream declaration. |
| `dependency_cycle` | A directed cycle exists inside the selected task scope. |

References outside the selected task scope are not treated as cycles. Ambiguous prose is not silently converted into a dependency. Findings are observations, not authorization to edit task records. A mismatch may be intentional; review before any correction.

## Portability and safety

- Node.js 22+ and the workspace API's existing `better-sqlite3` dependency.
- No network, provider, inference, quota, credentials, or paid service is used.
- The report schema is `schemas/tracking-reconciliation-report.schema.json` (Draft 2020-12).
- The report includes source locators and observed values; it avoids embedding task descriptions or secrets.
- The tool does not expose absolute database paths in the report.
- Run against a copied database when investigating an untrusted or concurrently changing source.

## Limitations

- A null run link is reported as missing provenance; historical attribution is not inferred.
- Embedded gate payload detection is a presence check, not a complete semantic review of every gate criterion.
- Dependency parsing is intentionally conservative: it reads labelled upstream/downstream references and explicit “Task #N planning complete” prerequisite statements in the structured planning register. Incidental task mentions (for example, a task stating that its own implementation is held) are not treated as dependency edges.
- Cycle detection is limited to the selected task set.
- This utility does not decide whether a dependency is authoritative, whether a task is ready, or whether an implementation HOLD may be lifted.

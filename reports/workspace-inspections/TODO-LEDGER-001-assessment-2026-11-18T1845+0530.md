# TODO-LEDGER-001 — Authoritative Work Ledger Assessment

- Inspection time: 2026-11-18 18:45 Asia/Kolkata
- Device: `sunilkr-H81` (Linux)
- Workspace: `/home/sunilkr/Code/multi-project-workspace`
- Database: `apps/api/data/workspace.sqlite`
- Mode: read-only source and database inspection; this report is the only file created.
- Scope: assess the existing local SQLite task system as a possible authoritative cURL AI Bridge work-intent and authorization ledger.
- No credentials, environment files, or secret values were read.

## Executive disposition

**Candidate foundation: YES. Authoritative #Todos designation: NOT YET.**

The local workspace has a substantial project task store, proposal flow, append-only bootstrap and writer-lease event records, and a same-host fenced writer coordinator. These are valuable foundations. However, the current implementation does not yet enforce one integrated lifecycle for pending, matured, authorized, executing, verified, completed, and deferred work.

The project mandate is explicit that a task record, proposal, Parent/model output, worker lease, available free quota, or prior execution is not authority by itself. It also specifies immutable events, idempotent task-store writes, authorization validation, and a seven-point planning gate. Several of those requirements are not fully implemented by the operational task API.

No records were changed and no implementation was attempted.

## 1. Live database observations

Read-only SQLite inspection used `mode=ro` and `PRAGMA query_only=ON`.

- Database integrity check: `ok`.
- Foreign-key check: no violations returned.
- cURL AI Bridge tasks: 29.
- Task statuses: 13 `done`, 15 `blocked`, 1 `in_progress`.
- cURL AI Bridge task activity events: 158.
- Events with null `run_id`: 158.
- Bootstrap registration events: 7.
- Writer lease records: 31 (14 expired, 17 revoked).
- Task-linked `agent_runs`: 0.
- Task-linked `agent_task_ops`: 0.
- Task proposals exist in the workspace database, but the inspected project-scoped proposal query did not establish a cURL AI Bridge proposal set.
- Current project writer-state pointer refers to a revoked lease; the runtime guard requires active status, unexpired lease, matching generation and current pointer, so the pointer alone does not authorize writes.

Task event records with null run IDs are a provenance gap, not proof that no tool or agent participated. The reconciliation contract explicitly prohibits inferred historical attribution.

## 2. Existing capabilities

### Operational task store

- Project-scoped tasks with descriptions, acceptance criteria, planning fields, dependencies encoded in planning registers, and progress fields.
- Field-level task events.
- Optimistic compare-and-set update helper.
- Task-linked AI job reads and optional agent provenance links.
- Task create/update/delete APIs.

### Proposal store

- Proposal states currently are `proposed`, `approved`, `rejected`, and `rolled_back`.
- Approval creates a task and links drafting origin in one transaction.
- Rejection is recorded.
- Rollback deletes the task created by an approved proposal while retaining the proposal row and its created task ID.

This is a model-backed task improvement proposal mechanism. It is not the complete operator #Todos lifecycle described in the project governance rules.

### Writer lease and bootstrap controls

- cURL AI Bridge task mutations require a task-scoped writer lease through `createTasksStore`.
- Lease acquisition uses SQLite transactions, monotonically increasing fencing generations, a current-lease pointer, repository and HEAD pins, an allowlist, and binding digests.
- Lease events and bootstrap events have database triggers rejecting UPDATE and DELETE.
- The lease runtime documentation correctly limits this to a same-host local SQLite coordinator, not multi-host consensus.
- The runtime guard is enforced inside managed task and task-event write transactions.

## 3. Gaps against the required #Todos governance model

### G1 — No single lifecycle

The operational task API accepts only `todo`, `in_progress`, `blocked`, and `done`. It does not directly model `pending`, `matured`, `authorized`, `verified`, or `deferred` as distinct governance states.

The separate proposal store does not close this gap: its lifecycle is `proposed -> approved/rejected -> rolled_back`, with no reviewed or deferred state.

### G2 — Task activity is not append-only

The `task_events` table has no UPDATE/DELETE protection triggers. Its foreign key is `ON DELETE CASCADE` from tasks. The task deletion route and proposal rollback path can therefore delete task activity history with the task.

This conflicts with the normative mandate's immutable event requirement. Bootstrap and writer-lease event tables are protected; ordinary task events are not.

### G3 — Authorization references are not semantically validated

A JSON Schema exists for authorization references, with level, permission class, scope, source, provenance class, granting identity, and optional expiry. The writer-lease acquisition path currently requires a non-empty `authorizationRef` string but does not validate a structured reference against that schema or resolve its scope/expiry/permission semantics.

The lease allowlist and binding digests protect lease identity and permitted mutations; they do not independently prove that the referenced operator authorization is valid.

### G4 — Task creation path is not reconciled to the live generation

The legacy `createTaskBootstrapStore` is configured with expected generation 9 and checks that the next task ID is exactly 146. Live state has advanced to generation 32 and task IDs through 156/157. That legacy registration path is stale and should fail closed.

A separate `createCurrentGenerationTaskBootstrapStore` exists in `taskBootstrap.js`, but `database.js` wires only `createTaskBootstrapStore` into the active database surface. The current-generation store is not integrated into the normal active API. It must not be assumed usable merely because the helper exists.

The generic task POST route calls `createTask`; for cURL AI Bridge, the store requires a task ID for its lease guard, so a new task cannot be created through that generic path. A new governed registration path needs its own design and authorization.

### G5 — Event run provenance is incomplete

All 158 cURL AI Bridge task events have `run_id = NULL`. The code intentionally permits null when no tool run is active, and the migration made the column nullable to preserve historical rows. Historical run attribution must not be fabricated.

Future writes should require or explicitly record a provenance state (for example, tool-run linked, operator-direct, or system migration) rather than silently presenting null as fully attributable.

### G6 — Reconciliation utility fails on a structured dependency register

The read-only command:

```sh
node scripts/tracking-reconcile.mjs --project curl-ai-bridge --format text
```

failed with:

```
tracking_reconcile_error: text.matchAll is not a function or its return value is not iterable
```

The implementation assumes `dependencies_and_prerequisites` is a string. Task #146 stores that field as a structured object containing `satisfied`, `bootstrap_event_id`, `implementation_prerequisites`, and `downstream`. The parser must handle the declared data shape or report it as unsupported without crashing.

No repair or rerun with modified code was performed.

### G7 — Schema layers are not the same contract

The workspace contains separate JSON Schemas for swarm tasks, work items, authorization references, writer leases, and reconciliation reports. These are not the same as the operational `tasks` SQLite table/API contract.

For example, `work-item.schema.json` has execution statuses such as `PENDING`, `ASSIGNED`, `RUNNING`, `BLOCKED`, `COMPLETED`, and `CANCELLED`; it does not define the complete project-intent and authorization lifecycle. No evidence was found in the inspected application source that these schemas are wired as a unified validator for the operational task routes.

### G8 — Legacy task-type values do not match current API validation

Existing cURL AI Bridge rows include task types such as `review` and `ci`. Current route validation accepts only `feature`, `bug`, `chore`, `test`, and `docs`. The database can preserve legacy values, but clients using the current task-type filter/validator must account for this mismatch.

### G9 — No repository-level Linear/Trello/Todoist sync found

A source search across the inspected workspace areas (`apps`, `scripts`, `packages`, `docs`, and `schemas`) found no references establishing an existing Linear, Trello, or Todoist synchronization implementation. This is a bounded search observation, not proof that no integration exists elsewhere on the machine.

## 4. Governance contract already present

`docs/swarm-execution-mandate.md` is a normative design contract for cURL AI Bridge. It establishes:

- Parallel read-only/proposal work versus one serialized implementation writer.
- Task-specific planning gate and exact path/operation allowlist.
- Explicit authorization separate from task presence or model output.
- A seven-point planning gate.
- Explicit dependencies and downstream disposition.
- Reversibility, risk, budget, and egress boundaries.
- Idempotent writes, compare-and-set, and immutable decision/evidence events.
- No automatic expansion of scope or authority.

The document also states that it is a design contract and that a contract alone does not install runtime enforcement. The current local lease runtime provides meaningful same-host fencing, but the gaps above remain.

## 5. Recommended target architecture

Keep the local SQLite database as the **candidate operational source of truth**, but do not designate it the authoritative #Todos ledger until the gaps are closed and verified.

Recommended separation:

- **SQLite ledger:** canonical work intent, lifecycle, authorization references, event history, dependency records, evidence references, and execution state.
- **Linear:** project/issue visibility and human workflow view; any synchronization should be one-way projection initially.
- **GitHub:** repository code, pull requests, review decisions, CI and commit evidence.
- **Trello:** optional visual overview only.
- **Todoist:** personal reminders only.

Authority must not flow from a Linear/Trello/Todoist card, GitHub issue, agent output, or task status alone. External systems must not independently authorize implementation.

## 6. Required remediation/design sequence

Recommended next phases, each requiring its own bounded work item and scope:

1. **TODO-LEDGER-002 — Canonical lifecycle and state machine:** define the operator intent lifecycle and legal transitions; separate task execution status from authorization state.
2. **TODO-LEDGER-003 — Authorization reference resolution:** validate structured authorization records, scope, permission, source/provenance and expiry at the mutation boundary.
3. **TODO-LEDGER-004 — Immutable event/provenance model:** prevent update/delete of governance events, preserve history across task deletion/rollback, and represent operator/system/tool-run provenance explicitly.
4. **TODO-LEDGER-005 — Registration recovery:** reconcile current-generation bootstrap helper with active database composition and establish an explicit, fail-closed registration path without resetting or forcing IDs/generations.
5. **TODO-LEDGER-006 — Reconciliation parser compatibility:** handle structured and legacy dependency-register values; add regression tests for Task #146's shape.
6. **TODO-LEDGER-007 — External projection contract:** design a one-way SQLite-to-Linear/GitHub projection with stable IDs, idempotency, conflict handling, provenance, and no authority promotion.
7. **TODO-LEDGER-008 — Adoption gate:** run read-only reconciliation, verify all acceptance criteria, then make an explicit operator decision on authoritative designation.

Do not combine these into one broad implementation. Each increment needs an exact allowlist, protected-state anchors, reversible mutation plan, offline tests, and independent verification.

## 7. Repository and safety boundary

Git state observed before and after inspection:

```
## master...origin/master [ahead 6]
 M .github/workflows/ci.yml
?? reports/
```

- Existing modification to `.github/workflows/ci.yml` was preserved.
- Existing untracked `reports/` tree was preserved; this report is an additional uniquely named file within it.
- No source, schema, test, configuration, database, task, proposal, lease, Linear, GitHub, Trello, or Todoist record was modified.
- No migrations, tests, network calls, provider inference, quota consumption, commits, pushes, or deployments were performed.
- The SQLite database was opened read-only; integrity and foreign-key checks were read-only.
- Discovery is bounded to the inspected checkout and live database; it is not a completeness claim.

## Final disposition

**TODO-LEDGER-001 assessment complete.**

**SQLite candidate: retain for remediation and evaluation.**  
**Authoritative #Todos status: NOT DESIGNATED.**  
**Linear: recommended as a one-way project visibility layer after the canonical lifecycle is defined.**  
**Implementation authorization: NOT GRANTED by this assessment.**

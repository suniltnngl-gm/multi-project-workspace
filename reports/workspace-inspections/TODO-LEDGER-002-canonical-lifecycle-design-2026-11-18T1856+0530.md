# TODO-LEDGER-002 — Canonical Lifecycle and State Machine Design

- Observed: 2026-11-18 18:56 Asia/Kolkata
- Device: `sunilkr-H81`
- Workspace: `/home/sunilkr/Code/multi-project-workspace`
- Repository HEAD: `e28afe7eca1a585a58ad8d8c3628fd98322e7549`
- Branch: `master`, upstream `origin/master`, 6 ahead / 0 behind
- Mode: design-only; source, schema, tests and database were inspected read-only.
- Status: **DESIGN PROPOSAL — NOT IMPLEMENTED, NOT AN AUTHORIZATION GRANT**

## 1. Decision summary

Adopt a **separated-dimensions state model** for the future canonical #Todos ledger. Do not use one overloaded task status to represent work readiness, operator authorization, execution, verification and final disposition.

The model has four independent dimensions:

1. **Readiness** — whether the work intent is sufficiently understood and planned.
2. **Authorization** — whether an explicit, valid, scoped operator grant exists for the exact reviewed plan revision.
3. **Execution** — what happened during a bounded execution attempt.
4. **Disposition** — whether the work remains open, was deferred/rejected/superseded, or was completed and closed.

A human-facing **work phase** is derived from those dimensions. It is not an independent permission and must never be used as a substitute for an authorization record or a current writer lease.

This preserves the governing distinction: maturity makes work eligible for an authorization decision; it does not authorize implementation.

## 2. Source-grounded current state

The following were inspected directly in this checkout:

- `docs/swarm-execution-mandate.md` — normative `swarm-plan-v1` planning gate, serialized writer rule, task-specific allowlist, explicit authority, seven planning records, idempotency/CAS and stop conditions.
- `schemas/task.schema.json` — swarm task transport schema; status enum is `queued | running | completed | failed | cancelled`.
- `schemas/work-item.schema.json` — work-item transport schema; status enum is `PENDING | ASSIGNED | RUNNING | BLOCKED | COMPLETED | CANCELLED`; it requires an authorizationRef but is not the operational task schema.
- `schemas/authorization-reference.schema.json` — structured authorization reference with ref, level, permissionClass, scope, source, provenanceClass and optional grantor/expiry.
- `apps/api/src/db/tasks.js`, `taskProposals.js`, `taskBootstrap.js`, `database.js`, `routes/tasks.js`, `routes/proposals.js`, `routes/util.js`, and `db/migrations.js`.
- `docs/task-bootstrap-registration-contract.md` and `docs/tracking-reconciliation-contract.md`.

Observed operational facts at this checkpoint:

- cURL AI Bridge has 29 task rows: 15 `blocked`, 13 `done`, 1 `in_progress`.
- It has 158 task events; all 158 have `run_id IS NULL`.
- Maximum task ID is 157.
- `PRAGMA integrity_check` returned `ok`; `PRAGMA foreign_key_check` returned no rows.
- The operational task table has a legacy `status` and `completed` field, but no dedicated readiness, authorization, verification or disposition fields.
- The API status whitelist is `todo | in_progress | blocked | done`. `completed` is kept consistent with `done`.
- The proposal table currently constrains status to `proposed | approved | rejected | rolled_back`; the route exposes approve, reject and rollback, but not a reviewed or deferred transition.
- The normative mandate describes proposal lifecycle as `proposed -> reviewed -> accepted | rejected | deferred`. The live proposal implementation therefore does not yet match that contract.
- Proposal approval creates a task; it does not establish that the task has passed the seven-point planning gate or has explicit implementation authorization.
- Proposal rollback deletes the task created by the proposal. The task row's event FK is `ON DELETE CASCADE`, so this is incompatible with the desired permanent governance history if used for canonical work intent.
- The generic cURL AI Bridge task creation path reaches a store guard that requires a task-scoped writer lease; create currently has no task ID to supply. The legacy bootstrap contract also pins generation 9 / next ID 146, which is stale relative to observed generation 32 / max task ID 157. The current-generation helper is not wired into `database.js`.
- The existing planning gate has seven evidence points and two dispositions: `incomplete` or `ready_for_serialized_implementation`. Readiness is explicitly limited to the task's exact allowlist; it does not authorize commit, push, release, CI trigger, deployment, provider invocation, paid inference or external egress.

These observations are not changed by this design. Existing rows and schemas must not be silently reinterpreted.

## 3. Canonical dimensions

### 3.1 Readiness

Field: `readiness_state`

Values:

- `PENDING` — work intent has been captured but has not passed the reviewed maturity gate.
- `MATURED` — the intent is sufficiently specified, dependencies and acceptance criteria are reviewed, and the required planning evidence is complete. It is eligible for a separate operator authorization decision only.

Rules:

- New work begins `PENDING`.
- Only a completed, reviewed maturity assessment may move it to `MATURED`.
- Missing, stale, conflicting or unverifiable evidence keeps it `PENDING`.
- A material change to scope, acceptance criteria, dependencies, protected exclusions, allowlist, risk, budget or egress invalidates maturity for the new revision and returns readiness to `PENDING`.
- A readiness transition never grants mutation permission.

### 3.2 Authorization

Authorization is a separate, append-only grant record, not a boolean on the task and not a task status.

Each grant must bind at minimum:

- stable authorization ID and reference;
- project and task identity;
- exact intent revision and canonical plan/allowlist digest;
- permission class and exact scope, including operation types;
- granting actor and provenance;
- issued-at and optional expiry;
- budget and external-egress limits;
- decision source and evidence/decision reference;
- current disposition: active, revoked, expired or consumed.

Only an explicit operator decision can grant implementation authority for a mutation task. A policy reference, proposal acceptance, agent recommendation, task maturity, model output, free quota or writer lease alone is not that grant. The existing authorization schema provides useful fields, but the semantics of A0/A1/A2 and runtime validation still require TODO-LEDGER-003.

Authorization is valid only when its task, revision, digest, scope, permission, provenance and expiry all match the operation being attempted. Scope expansion or plan-digest mismatch invalidates the grant for that operation. Revocation and expiry must be recorded as events; old grants are retained.

### 3.3 Execution

Field: `execution_state`

Values:

- `NOT_STARTED`
- `RUNNING`
- `BLOCKED`
- `SUCCEEDED`
- `FAILED`
- `CANCELLED`

Execution is represented as bounded attempts with stable IDs and provenance, rather than treating a task's mutable status as the full history of all attempts.

Rules:

- `RUNNING` requires a valid authorization for the exact plan revision and a current task-scoped writer lease/fencing generation at the mutation boundary.
- A lease does not create or extend authorization.
- `BLOCKED`, `FAILED` and `CANCELLED` are execution outcomes, not final work-intent dispositions.
- An uncertain outcome is recorded as uncertain/blocked and is not automatically replayed.
- A subsequent attempt requires a new attempt record and revalidation of authorization, plan revision, dependencies and writer lease.
- A task with partial effects cannot be reset to a clean `NOT_STARTED` state. Recovery must inspect and preserve the partial outcome.

### 3.4 Verification

Field: `verification_state`

Values:

- `PENDING`
- `PASSED`
- `FAILED`
- `NOT_APPLICABLE`

Verification is evidence-bearing:

- `PASSED` requires all required acceptance checks to pass with inspectable evidence anchors.
- `FAILED` records failed checks and keeps the work open for re-planning.
- `NOT_APPLICABLE` is allowed only where the reviewed task policy explicitly states why verification does not apply; it is not a shortcut for missing evidence.
- A verification record identifies verifier, time, test/check identity, result, source and digest where available.
- A task is not `COMPLETED` merely because execution returned success or legacy status is `done`.

### 3.5 Disposition

Field: `disposition`

Values:

- `OPEN`
- `DEFERRED`
- `REJECTED`
- `SUPERSEDED`
- `COMPLETED`

Rules:

- New accepted work intent is `OPEN`.
- `DEFERRED` preserves the task and all evidence; reopening requires a new event, reason and review. Any prior authorization must be revalidated and normally reissued against the current revision.
- `REJECTED` records a deliberate decision not to proceed. It is not deletion.
- `SUPERSEDED` records the successor task ID and rationale. The predecessor remains queryable.
- `COMPLETED` is allowed only after verification passes (or a reviewed `NOT_APPLICABLE` disposition) and a closure event records the final evidence and operator disposition.
- Reopening completed work creates a new revision or successor work item; it does not erase the completion event or rewrite history.

## 4. Derived work phase

The user-facing phase is derived from the dimensions above. Suggested precedence:

1. `COMPLETED`, `DEFERRED`, `REJECTED`, `SUPERSEDED` when disposition is final/non-open.
2. `BLOCKED` when an active blocker exists or the current execution attempt is blocked/failed/cancelled pending disposition.
3. `VERIFIED` when execution succeeded and verification passed (or explicitly reviewed as not applicable), but closure has not yet been recorded.
4. `EXECUTING` when a current attempt is running under a valid writer lease and authorization.
5. `AUTHORIZED` when readiness is `MATURED` and a matching, active authorization exists, but execution has not started.
6. `MATURED` when readiness is `MATURED` and no matching active authorization exists.
7. `PENDING` otherwise.

The derived phase is a display/query convenience only. The mutation boundary must independently validate authorization, plan digest, dependency state, writer lease and fencing generation.

## 5. Transition contract

| Event / transition | Required preconditions | Result |
|---|---|---|
| Register work | Valid project identity, provenance and idempotency key | `PENDING`, `OPEN`; no authorization |
| Mature work | Reviewed acceptance criteria, dependencies, seven-point planning evidence, exact scope and risk/reversibility | `MATURED`; no authorization |
| Reopen maturity review | Material plan change, missing/stale evidence or dependency change | `PENDING`; previous maturity evidence retained |
| Grant authorization | Explicit operator decision, current matured revision, exact scope/digest, valid structured reference and limits | Active authorization record; derived phase `AUTHORIZED` |
| Begin execution | Matching active grant, current writer lease/fence, unchanged task revision/dependencies and pre-state anchors | New attempt; `RUNNING` |
| Block / fail / cancel attempt | Recorded reason, checkpoint, effects/unknowns and lease disposition | Attempt outcome retained; work remains open/blocked |
| Complete execution | Bounded attempt reports success | `SUCCEEDED`; verification remains `PENDING` |
| Verify | Required checks and evidence satisfy acceptance criteria | `PASSED` or `FAILED` |
| Close completed work | Verification passed or reviewed N/A; closure evidence and operator disposition | `COMPLETED` |
| Defer | Explicit reason, checkpoint and disposition; stop/fence active execution safely | `DEFERRED`; all prior evidence retained |
| Reopen deferred work | Explicit operator decision and new review event | `OPEN` + `PENDING`; prior attempts/grants retained, new grant required |
| Reject | Explicit decision and rationale | `REJECTED`; no task deletion |
| Supersede | Successor reference and rationale; no active writer | `SUPERSEDED`; predecessor retained |

No generic PATCH operation may perform these transitions by changing a free-form status field. Each transition must be a named command/API operation with a compare-and-set precondition and an appended decision event.

## 6. Proposal lifecycle alignment

The normative mandate's proposal lifecycle should be the target:

`proposed -> reviewed -> accepted | rejected | deferred`

Semantics:

- `proposed`: a candidate from a worker, AI improvement run or operator; no task creation and no authority.
- `reviewed`: human review completed and recorded; this is not acceptance or authorization.
- `accepted`: accepted as a work intent and registered as a new `PENDING` task. It does not mark it `MATURED` and does not authorize implementation.
- `rejected`: retained with decision evidence; no task created unless one already exists for independent reasons.
- `deferred`: retained for later reconsideration; no task creation unless an explicit policy says otherwise.

The live `approved` value should not be silently renamed or mapped during this design phase. A future additive migration must preserve its original value and decision history. `rolled_back` must not mean delete the created task or its events; future compensation should be a tombstone/compensation event and explicit disposition, not history erasure.

## 7. Mapping to existing SQLite structures

### Preserve as legacy operational fields

- `tasks.status` and `tasks.completed` remain legacy execution/UI compatibility fields during migration.
- Existing `todo`, `in_progress`, `blocked`, and `done` values are not automatically converted into readiness, authorization, verification or disposition.
- Existing `task_events` remain historical evidence; null `run_id` remains null. Do not invent attribution.
- Existing `task_proposals.status` values remain unchanged until a separately reviewed migration.
- Existing `swarm-plan-v1` JSON and gate records remain source evidence, not authorization grants.

### Additive target (design recommendation only)

Prefer additive governance sidecar records over repurposing the overloaded task row:

- `task_governance_state`: one current projection per task, including readiness, verification, disposition, current revision and optimistic version.
- `task_governance_events`: append-only lifecycle, review, maturity, authorization-reference, execution, verification and disposition events.
- `task_authorizations`: immutable grant records and explicit revocation/expiry events; never store secrets or credentials.
- `task_execution_attempts`: bounded attempt identity, actor/run/session lineage, plan digest, lease/fence reference, start/end, outcome and evidence references.
- `task_dependencies`: typed directed edges separating hard prerequisites from contextual references; preserve both directions and detect cycles.
- Optional `task_revisions`: immutable canonical intent snapshots/digests where task content changes must invalidate maturity/authorization.

These names are logical design names, not approved SQL/table names. Exact schema, foreign-key policy, indexes and migration strategy belong in a later implementation contract.

Use restrictive foreign keys or tombstones for governance records. Do not cascade-delete task history. The event log is append-only; the state projection may be updated only in the same transaction that appends the corresponding event. Every command uses a stable idempotency key, unique constraint and compare-and-set version.

## 8. Legacy compatibility and migration rules

1. Do not update existing task rows to guess governance states.
2. Existing tasks without a governance record are classified `LEGACY_UNCLASSIFIED` in the read model, not automatically pending, matured, authorized or completed.
3. Existing `done` is not proof of verification; existing `in_progress` is not proof of authorization; existing `blocked` is not a formal deferred disposition.
4. Existing proposal `approved` is not equivalent to the normative `accepted` plus maturity or authorization.
5. Preserve all task IDs, proposal IDs, timestamps, events, run links, lease generations and bootstrap records.
6. Do not force SQLite sequences or reuse IDs.
7. Migration must be additive, transactionally applied, backed up and rehearsed against a copy; pre/post row counts and canonical hashes must be compared.
8. A migration must not remove or rewrite legacy columns until a separate compatibility/removal decision.
9. No live task should become dispatchable solely because a migration created a default state row.

## 9. Required invariants

- **I1 — Maturity is not authority:** `MATURED` alone never permits a mutation.
- **I2 — Explicit grant:** mutation requires an active operator authorization bound to the exact task revision, plan digest and allowlist.
- **I3 — Lease is not authority:** a writer lease provides serialization/fencing, not operator permission.
- **I4 — No scope drift:** any material plan/allowlist/dependency change invalidates prior maturity and authorization for the changed revision.
- **I5 — Execution fence:** mutation requires both the matching grant and current writer lease/fencing generation at the mutation boundary.
- **I6 — Verify before close:** completion requires successful verification or explicitly reviewed N/A.
- **I7 — Preserve history:** reject, defer, supersede, cancel, rollback and reopen are events/dispositions, not deletion.
- **I8 — Unknown is not success:** missing provenance, quota, verification or outcome remains unknown and blocks the corresponding gate.
- **I9 — Idempotent transitions:** duplicate idempotency keys return the original result or a deterministic conflict; they never duplicate a transition.
- **I10 — CAS:** stale versions reject; no last-write-wins.
- **I11 — Dependency integrity:** hard prerequisites are directional, explicit and cycle-checked; contextual links do not block execution.
- **I12 — Project boundary:** no authorization or state is inherited from another project.

## 10. Acceptance test plan for a future implementation

A future implementation is not acceptable until tests demonstrate:

1. New work registers as `PENDING/OPEN` with no authorization.
2. A complete reviewed seven-point gate can mature work but cannot dispatch it.
3. Incomplete, stale or conflicting gate evidence cannot mature work.
4. Proposal acceptance creates a pending work intent only; it cannot authorize execution.
5. Missing, expired, revoked, wrong-project, wrong-task, wrong-revision, wrong-digest, wrong-permission or out-of-scope authorization blocks mutation.
6. A valid authorization without a current writer lease still blocks mutation.
7. A current writer lease without valid authorization still blocks mutation.
8. A scope or dependency change invalidates maturity and prior authorization for the changed revision.
9. Concurrent transitions with stale expected version fail with a conflict and do not overwrite.
10. Duplicate idempotency keys do not create duplicate events, tasks, grants or execution attempts.
11. Execution success without verification cannot complete work.
12. Verification failure cannot complete work and requires re-planning/re-authorization before another mutation attempt.
13. Deferral/rejection/supersession/reopen preserve all prior events and attempts.
14. Deleting or rolling back a task cannot cascade-delete governance history.
15. Legacy rows remain `LEGACY_UNCLASSIFIED` until individually reviewed; no authorization is inferred.
16. Null historical run IDs remain null; future event provenance must be explicit.
17. Dependency cycles and missing hard prerequisites block maturity.
18. A project other than `curl-ai-bridge` cannot inherit Bridge-specific authority or policy.

## 11. Open decisions for TODO-LEDGER-003 and later

- Define exact A0/A1/A2 semantics and whether a grant can be one-shot, bounded by time, or require renewal.
- Define authorization reference resolution, issuer identity, revocation, expiry and operator authentication.
- Define how read-only/proposal work is recorded without unnecessarily requiring mutation grants.
- Define whether verification can be performed by a separate reviewer and what evidence qualifies.
- Define exact dependency edge types and the policy for cycles or superseded prerequisites.
- Define event retention, tombstone and task identity rules.
- Define whether the current legacy task status remains a long-term UI projection or is eventually retired.
- Reconcile task proposal states with the normative mandate without destructive rewriting.
- Design registration recovery and task-scoped authorization issuance as separate increments.

## 12. Scope and disposition

Completed in this increment:

- Read-only review of the current mandate, schemas, task/proposal store, routes, database composition, migration definitions and reconciliation contract.
- Current SQLite integrity and foreign-key checks.
- Canonical lifecycle proposal, transition rules, compatibility mapping and acceptance test plan.
- This report only.

Not performed:

- No source, schema, test, database or configuration changes.
- No task/proposal/lease/authorization records created or modified.
- No migration, task registration, API operation, test run, agent dispatch, provider inference or external connector write.
- No Git staging, commit, push, merge or deployment.
- Existing `.github/workflows/ci.yml` modification and pre-existing untracked `reports/` tree were preserved.

Repository pre-state observed: `master` at `e28afe7eca1a585a58ad8d8c3628fd98322e7549`, 6 ahead of `origin/master`, with `.github/workflows/ci.yml` modified and `reports/` untracked. This design report is the only file created by this increment.

**Final disposition:** TODO-LEDGER-002 design proposal complete. SQLite remains a candidate, not the authoritative #Todos ledger. No implementation authority is granted by this document. Next recommended increment: **TODO-LEDGER-003 — Authorization Reference Resolution Design**, followed by independent review before any implementation.

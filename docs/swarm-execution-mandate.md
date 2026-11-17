# Swarm Execution Mandate

**Contract:** `swarm-execution-mandate-v1`
**Planning gate:** `swarm-plan-v1`
**Scope:** `curl-ai-bridge` project coordination, with the Core workspace task store as the observed task-state authority.
**Status:** Normative design contract. This document and its schema do not themselves install or enforce a runtime distributed lock.

## 1. Purpose and authority

This mandate separates parallel cognition from serialized mutation. Workers may independently inspect, research, review, plan, and prepare proposals. There is exactly one authorized project-wide implementation writer at a time. A task record, proposal, Parent/model output, worker lease, available free quota, or prior execution is not authority by itself.

The task's reviewed planning gate authorizes only the exact implementation allowlist recorded on that task. Consequential or destructive actions, external egress, paid inference, deployments, releases, remote pushes, and other excluded operations require their own separately scoped authorization.

The project-specific task and repository evidence govern this project. Patterns from another project may inform a proposal but do not transfer authority or silently expand scope.

## 2. Execution lanes

### Parallel lane — read-only or proposal-only

Permitted concurrently:
- Repository and task-state inspection that does not mutate the source of truth.
- Research, design, review, test planning, risk analysis, and improvement proposals.
- Drafting candidate task changes without writing them to the task store.
- Preparing evidence references, dependency analysis, and proposed handoffs.

A worker reports its identity, run/task/project context, observations, exact proposed scope, expected files, dependencies, risks, evidence anchors, and proposed task changes. Conflicting observations remain visible; they are not silently reconciled.

### Serialized lane — mutation

The following are serialized project-wide, not merely per worker or per repository:
- Source, documentation, schema, test, configuration, task-board, database, and deployment mutations.
- Acceptance of task proposals and task creation/update.
- Git operations that alter shared repository state.

Only the current writer lease holder may perform an implementation mutation. No overlapping writer leases are permitted. A writer may modify only the reviewed allowlist and may not broaden it during execution.

The current repositories do not provide an already-established project-wide cross-repository writer lease with fencing. This contract specifies the required behavior; it must not be represented as runtime-enforced until an implementation is installed and verified. A process-local mutex or in-process promise queue is not a distributed/project-wide lease.

## 3. Shared execution context

Every execution and handoff carries:
- `project_id`, `task_id`, `run_id`, `worker_id`, and session lineage.
- Repository identity, branch, observed base HEAD, and exact allowlist (including operation type).
- Allowlist digest, authorization reference, and planning-gate version/disposition.
- Context-pack version, dependencies, risk/reversibility classification, and budget/egress policy.
- Evidence anchors with source, locator, observed time, and digest where available.
- Current lease ID and fencing generation when mutation is active.
- State, blockers, decisions, verification results, and next handoff.

The shared ledger is an auditable coordination record, not an independent grant of authority. Evidence must be attributable and verifiable. Missing evidence is recorded as missing, not inferred.

## 4. Writer lease and fencing contract

A lease binds `project_id`, `task_id`, `run_id`, `worker_id`, repository, branch, `base_head`, exact allowlist and its hash, and `authorization_ref`.

A compliant lease service must:
1. Atomically grant a lease only when no unexpired project writer lease exists.
2. Increment a monotonically increasing project-scoped `fencing_generation` on every successful acquisition or recovery.
3. Give each lease a unique ID, owner identity, acquisition time, expiry, and heartbeat time.
4. Accept heartbeat renewal only from the current lease ID, owner, and fencing generation. Renewal cannot revive an expired or superseded generation.
5. Reject every mutation carrying an expired, cancelled, or stale fencing generation, even if the former worker is still running.
6. Revoke the current lease on cancellation and stop further writes.
7. Require recovery to re-read repository HEAD, task `updated_at`, ledger state, working tree, and protected anchors before issuing a new generation.
8. Treat lease expiry as loss of authority, not proof that a worker has stopped. A successor must fence off the prior generation before writing.

The fencing check must be enforced at the mutation boundary, not only by a cooperative client. A lease record without an atomic grant and mutation-time fencing check is insufficient.

## 5. Task proposals and task-store writes

Workers may prepare proposals concurrently. Proposal preparation does not create or modify a task.

All task-store writes pass through one serialized transaction queue and use an individual SQLite `BEGIN IMMEDIATE` transaction. Each operation must:
- Carry a stable, unique idempotency key.
- Detect an already-applied key and return the prior result rather than duplicate the mutation.
- Validate the expected task `updated_at` (compare-and-set).
- Validate proposal identity and lifecycle state before acceptance/rejection/deferment.
- Append an immutable event describing proposal, review, decision, mutation, verification, or handoff.
- Commit only after all preconditions pass.

A stale expected timestamp, duplicate conflict, changed dependency, invalid authority, or failed precondition rejects the write. The caller must re-read and re-plan. Never use last-write-wins, blind retries, or silent overwrites. Task proposal lifecycle is `proposed -> reviewed -> accepted | rejected | deferred`. Acceptance creates or updates a task only through the serialized task-store API.

## 6. Seven-point planning gate — swarm-plan-v1

A planning gate is complete only when all seven records exist, are reviewed, and are supported by inspectable evidence:

1. **Planning evidence and architecture:** distinguish parallel read-only research/planning from one project-wide serialized implementation writer; record inspected systems and observed gaps.
2. **Acceptance criteria:** reviewed, testable criteria with explicit pass/fail outcomes.
3. **Dependencies and downstream disposition:** identify upstream prerequisites, contextual references, downstream tasks, and what remains blocked.
4. **Exact implementation allowlist:** list each permitted path and operation (CREATE/UPDATE/DELETE); no implied wildcards.
5. **Protected exclusions:** name protected paths, hashes/commit anchors, and excluded repositories or subsystems.
6. **Reversibility and risk:** classify each mutation, recovery path, external effects, budget, and egress.
7. **Verification plan:** name offline tests, regression tests, schema checks, protected-baseline checks, and closure evidence.

Missing, stale, unreviewed, or unverifiable records leave the gate incomplete. The gate disposition is either `incomplete` or `ready_for_serialized_implementation`. Readiness authorizes only the exact allowlist on that task; it does not authorize commit, push, release, CI trigger, deployment, provider invocation, paid inference, or external egress.

## 7. Dependency, scope, and protected-state rules

Dependencies must be explicit and directional. A downstream task remains blocked until its stated prerequisites are verified complete. Contextual tasks are not silently promoted to dependencies. No task is created merely to make a workflow appear complete.

For Task #141, the reviewed implementation allowlist is CREATE-only:
- `docs/swarm-execution-mandate.md`
- `schemas/swarm-execution-ledger.schema.json`
- `apps/api/test/swarmExecutionMandate.test.js`

The Bridge repository has no allowlisted files. The following are excluded:
- Core `.github/workflows/ci.yml`, protected by SHA-256 `ef642bcfa20fdfb2bd98b09ff9be978d69a771df3ef04d559e284240b7836880`.
- Existing P3-C contracts/code at Core base `d2e59c632a7a652dd1f67e57465a3c8c1bd62447` and Bridge base `1ea0049d8354857c1202ecd5ff2ee6bd9467f86f`.
- Bridge P3-B validator (protected SHA-256 `ead70861e92633747eac8eb3ff3060c1115691ba06526d031356623a7f27ee36`); because its exact path was not established, the entire Bridge repository is excluded.
- Runtime/source code, task CLI, database schema/migrations, CI/workflows, package manifests/lockfiles, secrets, deployment, and all other unapproved protected files.
- Schema drops, renames, rebuilds, destructive migrations, or other destructive changes.

Any discovered need outside this list is a stop-and-replan condition, not permission to extend scope.

## 8. Risk, reversibility, budget, and egress

Task #141's three additive local files are reversible by removing those newly created files, provided their pre-state absence is verified and recorded. Back up the task database before task-state mutation. Do not overwrite existing files.

Budget ceiling is **$0.00**. External egress is **prohibited**. Do not call hosted providers, consume free-tier quotas, invoke paid inference, install packages, create cloud resources, or deploy. Tests must be deterministic and offline. No commit, push, release, or CI-triggering operation is included.

## 9. Verification and closure

For Task #141:
- Run `node --test apps/api/test/swarmExecutionMandate.test.js`.
- Run `npm test --workspace apps/api`.
- Run the named Core bridge tests and workspace-federation test.
- Validate JSON syntax and Draft 2020-12 schema structure using an appropriate Draft 2020-12 validator when available; do not claim Draft 2020-12 validation from an older validator that does not support it.
- Run `git diff --check`.
- Verify exactly the three allowlisted files were created, no other path was changed, protected hashes remain unchanged, and Bridge remains clean.
- Persist evidence, checksums, test outcomes, and remaining limitations on Task #141. Mark it done only if every required check passes. A failed or unavailable required check leaves the task in progress with a precise blocker.

No commit SHA is required for this local-only task; do not create a commit as part of closure.

## 10. Stop conditions and handoff

Stop immediately on changed base HEAD, changed protected hash, unexpected working-tree content, missing allowlist path, task timestamp conflict, invalid/stale lease, failed test, unexpected external dependency, budget/egress risk, or a request to mutate an excluded path.

On stop, preserve evidence, do not broaden scope, release/revoke the writer lease safely, and record the blocker. A successor must revalidate all preconditions and acquire a new fencing generation. Handoffs include completed work, uncompleted work, evidence, current repository/task state, and the exact next permitted action.

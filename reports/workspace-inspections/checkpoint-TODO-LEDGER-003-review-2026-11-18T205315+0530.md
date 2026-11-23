# cURL AI Bridge — Project Checkpoint / TODO-LEDGER-003 Review

**Observed:** 2026-11-18 20:53:15 +0530  
**Mode:** Read-only inspection and checkpoint reporting  
**Disposition:** TODO-LEDGER-003 reconciliation report found and reviewed; implementation remains unauthorized.  
**Authority:** ChatGPT is the sole project manager for this context. AI_A remains an optional alternative orchestration profile. No worker or sibling was dispatched.

## 1. Executive findings

- Desktop Commander device `sunilkr-H81` was online and the exact primary/work-ledger paths were verified.
- Both repositories' current Git pre-states were captured before source/database reads. Existing changes were preserved.
- A new-to-this-checkpoint report was present: `TODO-LEDGER-003-AUTH-001-reconciliation-2026-11-18T201642+0530.md`. It is 224 lines / 16,358 bytes, SHA-256 `52dfe662a40b63b1cc7f3d6e2f3430093cbad698d21cc9b4966ea681d5c11d7f`.
- A read-only consistency review confirmed the main AUTH-001/G7-01 boundary findings. The review also identified a task-proposal creation path incompatibility and stale task-bootstrap generation assumptions.
- The planning-gate wording conflict and undefined A0/A1/A2 semantics remain unresolved. No interpretation was selected.
- The live SQLite database remains internally consistent. No active writer lease exists.
- Local cURL AI Bridge conversation/collaboration stores are **NOT RECONCILED** because the effective runtime working directory and process-specific `AI_BRIDGE_DATA_DIR` could not be established.
- GitHub Issue #19 remains open. Its body still records PR #18 at an older head than current PR metadata.
- Dropbox identity was explicitly returned and the known protocol manifest's metadata was read. Dropbox is a transport, not project authority.
- No tests, inference, dispatch, synchronization, cache reset, Git mutation, connector write, or authorization change occurred.

## 2. Repository pre-state

### Primary repository

Path: `/home/sunilkr/Code/curl-ai-bridge`

- Branch: `test/ubuntu-self-hosted-runner-smoke`
- HEAD: `1ea0049d8354857c1202ecd5ff2ee6bd9467f86f`
- Upstream: `origin/test/ubuntu-self-hosted-runner-smoke`
- Ahead / behind: 2 / 0
- Tracked modified paths: 11
- Untracked paths: 36

The tracked modifications include README, collaboration workflow, test runner, workspace subtree tooling, server entry/routing/scheduler files, and associated tests. The untracked set includes the Linux self-hosted validation workflow, CC-006E/cloud/quota/workspace documentation, CLI discovery/trust scripts, provider/quota adapters, sibling runtime, cloud/file communication modules, and their tests. The complete porcelain output was inspected; no cleanup or staging occurred.

### Work-ledger candidate workspace

Path: `/home/sunilkr/Code/multi-project-workspace`

- Branch: `master`
- HEAD: `e28afe7eca1a585a58ad8d8c3628fd98322e7549`
- Upstream: `origin/master`
- Ahead / behind: 6 / 0
- Tracked modified path: `.github/workflows/ci.yml`
- Untracked tree: `reports/`

The reports directory existed before this checkpoint. Its existing TODO-LEDGER-001, TODO-LEDGER-002, TODO-LEDGER-003 reconciliation, prior checkpoint and inspection reports were preserved.

## 3. TODO-LEDGER-003 / AUTH-001 reconciliation review

### 3.1 Confirmed authorization-reference limitations

Inspected:
- `schemas/authorization-reference.schema.json`
- `schemas/message.schema.json`
- `schemas/delegation-ledger.schema.json`
- `schemas/provenance.schema.json`
- `schemas/project-writer-lease.schema.json`
- `apps/api/src/db/projectWriterLeases.js`
- `apps/api/src/projectWriterLease.js`

A0, A1 and A2 appear as enum values in the schemas. The bounded search of policy, schema, source and test trees found no normative definitions, ordering, inheritance or permission mapping for those levels. The A1 + READ fixture is not a policy definition. Their semantics remain opaque and must not be inferred.

The authorization-reference schema structurally requires a reference, level, permission class, scope, source and provenance class. It permits optional grantor and expiry. It does not establish authenticated issuer proof, a trusted resolver, task revision/plan digest binding, a source/provenance compatibility matrix, budget/egress constraints, revocation or consumable-grant semantics.

### 3.2 Lease is fencing, not grant resolution

The lease implementation requires a non-empty authorization reference and binds that string into its lease digest/idempotency comparison. It checks lease activity, expiry, fencing generation, current pointer, owner/project/task bindings, repository branch/HEAD anchors and exact allowlist path/operation.

No inspected lease path resolves the reference to a grant or verifies grant issuer, permission, task revision, plan digest, expiry or revocation. The file mutation guard rechecks the lease at the final mutation boundary, but does not compose an operator-grant resolver. A non-empty reference is not proof of authorization.

### 3.3 Normative wording conflict remains open

`docs/swarm-execution-mandate.md` says the reviewed planning gate authorizes the task's exact implementation allowlist (section 1) and says readiness authorizes only that allowlist (section 6).

TODO-LEDGER-002 instead proposes that maturity makes work eligible for a separate explicit operator authorization decision; it expressly says maturity, proposal acceptance, a model output or a writer lease is not a grant.

The current operator authority model also requires explicit scoped authorization and does not allow task/proposal/lease state alone to authorize implementation. The wording conflict is real and must be resolved by the policy owner. This checkpoint did not choose an interpretation or edit policy.

### 3.4 AUTH-001 and G7-01 evidence

Live task #151:
- Title: `AUTH-001: Parent-Delegated Authorization Engine (Rev8)`
- Status: `in_progress`
- Updated: `2026-11-17T07:28:07.539Z`
- `acceptance_criteria`, `objectives`, `requirements` and `decisions` are empty.
- `agent_run_id` is null.
- `important_context` claims 29 paths, 55 acceptance tests and lease generation 13.
- Its task events are IDs 574–576; all have `run_id=NULL`.

The recorded 55-test count is not accompanied by an inspectable 55-case matrix. The task's 26 CREATE targets are all absent in this checkout; all three MODIFY targets exist. This confirms the planned implementation is not present at those paths, not that no external copy exists. The recorded lease generation 13 is stale relative to the live project generation 32.

Live task #127:
- Title: `G7-01 Multi-User OAuth, Operator Identity & Authorization`
- Status: `blocked`
- Blocker: project-wide HOLD and unresolved identity-provider decision; no OAuth setup or remote authentication changes authorized.
- Its planning-register JSON says `ready_for_serialized_implementation` but also `held=true`.

This is consistent with keeping readiness separate from permission. The Bridge G7 security document confirms the current HTTP authentication is one shared bearer token, not multi-user OAuth or per-operator identity. AUTH-001 should consume a trusted principal contract from G7-01, not silently implement or claim production OAuth/RBAC.

### 3.5 Additional source-level integration finding

Static path analysis found that proposal approval calls `tasks.createTask()`. For project `curl-ai-bridge`, the task insert guard requires a task ID before mutation. The generic create path calls the guard without a task ID, so this approval path appears to fail closed with `writer_lease_task_scope_missing`. No proposal was present and this path was not executed. This should be reconciled in the future task-registration design; it is not authorization to change it.

The task-bootstrap path is also stale: `createTaskBootstrapStore` defaults to generation 9; the CLI requires expected generation 9; `database.js` wires that store rather than the separate current-generation helper. The live generation is 32 and the task sequence high-water mark is 157. Do not invoke this bootstrap path or use its historical generation assumptions.

## 4. Live SQLite observation

Database path: `/home/sunilkr/Code/multi-project-workspace/apps/api/data/workspace.sqlite`. It was opened using SQLite URI `mode=ro` and `PRAGMA query_only=ON`.

| Observation | Current value |
|---|---:|
| cURL AI Bridge tasks | 29 |
| Blocked / done / in progress | 15 / 13 / 1 |
| Maximum task row ID | 156 |
| SQLite task sequence | 157 |
| cURL AI Bridge task events | 158 |
| Project task events with null run_id | 158 |
| Task proposals | 0 |
| Project writer generation | 32 |
| Active writer leases | 0 |
| Expired / revoked lease rows | 14 / 17 |

The current lease pointer references task 156, generation 32, status `revoked`; its expiry was `2026-11-18T03:26:46.593Z`. It is not a live lease. Lease-event counts: 31 acquired, 14 expired, 17 released, 67 renewed.

Database-wide `task_events` contains 589 rows, 495 with null `run_id`; the 158 project-specific events are all null. `PRAGMA integrity_check` returned `ok`; `PRAGMA foreign_key_check` returned no rows. No database mutation or migration was performed.

## 5. File-based communication

`server/storage/dependencies.mjs` confirms the effective default expression is `AI_BRIDGE_DATA_DIR || './data'`, with `conversations.json` and `collaboration.json` under that directory.

A targeted process check found no Node process whose command line or working directory identified the cURL AI Bridge server entrypoint/repository. The actual server runtime working directory and process-specific `AI_BRIDGE_DATA_DIR` therefore remain unknown. The inspection shell's environment is not a substitute for the application's environment.

**Disposition: NOT RECONCILED.** Neither local JSON store was read. No provider configuration, environment secrets, credentials, outbox, inbox or identity key was inspected. No `collaboration_sync` or publication attempt occurred.

## 6. GitHub tracking

Issue [#19](https://github.com/suniltnngl-gm/curl-ai-bridge/issues/19) is open, updated `2026-11-18T11:51:30Z`, with 8 comments. The latest substantive communication includes CC-006E's verify-only Parent trust-pin status. No comment was added.

| PR | Current head | State | Verified review / CI notes |
|---|---|---|---|
| [#15 G9.0](https://github.com/suniltnngl-gm/curl-ai-bridge/pull/15) | `6ff1bd261f96a28f24e3a4261903cfebe1a33a3c` | Open, draft, unmerged | CI #99 passed six jobs on exact head; independent review pending |
| [#16 G9.1](https://github.com/suniltnngl-gm/curl-ai-bridge/pull/16) | `d5679b20a8decdf217b4a60a41815751eb9365e8` | Open, draft, unmerged | CI #101 passed six jobs on exact head; independent review pending |
| [#17 G9.2](https://github.com/suniltnngl-gm/curl-ai-bridge/pull/17) | `47f372b6e76b4160516e5795a335959e5c111e7f` | Open, draft, unmerged | PR body reports an independent Amazon Q re-review of this head with no new findings; formal APPROVED review not established |
| [#18 G9.3](https://github.com/suniltnngl-gm/curl-ai-bridge/pull/18) | `fab73ddadd22ae24dc3558a26e333a1ace208630` | Open, draft, unmerged | Exact-head CI #42026487810: all 6 Ubuntu/Windows × Node 18/20/22 checks completed successfully; review comments are on older head `f4218bd...`, no formal APPROVED review |
| [#21 tracking register](https://github.com/suniltnngl-gm/curl-ai-bridge/pull/21) | `eda94bbb1ef7a86059a494164e14b42ffc07eae5` | Open, non-draft, unmerged | No review submissions returned |

Issue #19's body still records PR #18 at `24b4eceef073b72ff2fb1f9201162aea16803dbd`, not the current PR head `fab73ddadd22ae24dc3558a26e333a1ace208630`. PR #18's own body also retains the old head/CI history. This is a tracking discrepancy; no correction was made.

## 7. Integration observer

| Capability | Run classification | Boundary / limitation |
|---|---|---|
| Desktop Commander | CONNECTED, AVAILABLE, READ-TESTED | Device online; exact repositories and files inspected. Tool reported 81% monthly usage; reset date not surfaced. |
| GitHub | AVAILABLE, READ-TESTED | Issue, PR metadata/comments and exact-head check-runs fetched; no writes. Connection state was not separately asserted. |
| Dropbox | CONNECTED, AVAILABLE, READ-TESTED | `who_am_i` returned an identity; metadata read for `/Apps/curl-ai-bridge-cloud/protocol/manifest.json` (1,156 bytes; server modified `2026-11-18T10:29:37Z`). No content write or inbox scan. |
| Linear | AVAILABLE, READ-TESTED | Exact `curl-ai-bridge` project search returned no result; no unrelated issues inspected. |
| Todoist | AVAILABLE, READ-TESTED | Exact active `curl-ai-bridge` project search returned no result; no unrelated personal tasks inspected. |
| Gmail / Calendar | DISCOVERED, AVAILABLE | Tools exposed; not read-tested or used. |
| Automations | AVAILABLE | Tools exposed; no schedule or execution-environment changes. |
| Deployment / database platforms | DISCOVERED, AVAILABLE | Relevant tool namespaces exposed; not read-tested or used. No resources created. |

Dropbox is a cloud object transport, not a multi-writer transactional lease or authorization source. Linear remains a possible human-facing issue view; Todoist remains a personal reminder surface. Neither is adopted as project authority. No broad plugin search was run because this is not the Monday discovery checkpoint.

## 8. Provider, cache and worker boundary

Provider quota status was not requalified in this checkpoint. Historical OpenCode, Copilot, Hermes and AGY account/quota observations are not treated as current proof. No candidate is dispatch-enabled; unknown or stale quota evidence blocks dispatch.

No prompts, inference, quota-consuming checks, worker dispatch, participant configuration, account/key rotation, paid fallback, uncontrolled retry or cache reset occurred. Refreshable catalogue/health metadata remains conceptually separate from credentials, OAuth sessions, conversations, quota history and trust data. No cache lifecycle mutation was performed.

## 9. Next bounded action

1. Obtain policy-owner resolution of the mandate's planning-gate wording versus the explicit operator-grant model.
2. Obtain the actual AUTH-001 55-case acceptance matrix and inspectable seven-point planning-gate evidence.
3. Define the AUTH-001 ↔ G7-01 trusted operator-principal interface, keeping operator login distinct from supervisor/delegation session tokens.
4. Have TODO-LEDGER-003 reviewed independently; this checkpoint is a PM consistency review, not an independent external approval.
5. Only after those gates, consider a separate operator decision on task registration and later implementation. Keep TODO-004/005 as separate future increments; do not combine them with AUTH-001 implementation.

No task, grant, lease, proposal, database row, schema, source file, test, Git state, PR, issue, connector object, deployment or authorization state was changed by this checkpoint. This report records observations only; it does not establish completeness or grant implementation authority.

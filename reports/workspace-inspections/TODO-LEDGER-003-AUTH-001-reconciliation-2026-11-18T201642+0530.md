# TODO-LEDGER-003 — AUTH-001 / G7-01 Reconciliation

**Observed:** 2026-11-18 20:16:42 +0530  
**Disposition:** DESIGN RECONCILIATION COMPLETE; IMPLEMENTATION NOT AUTHORIZED  
**Scope:** Read-only source, task-ledger and SQLite inspection; this report is the only file created by this increment.

## 1. Authorization and boundaries

The operator authorized the recommended TODO-LEDGER-003 sequence:
1. AUTH-001 reconciliation review.
2. G7-01 identity dependency review.
3. Design closure with coverage, gaps, contradictions and unresolved decisions.
4. Independent review before implementation is considered.
5. A separate operator decision on registration and any later implementation authorization.

This increment performed steps 1–3 and prepared the material for step 4. It did not create or update tasks, grants, leases, code, schemas, database records, tests, or Git state. No implementation authorization is inferred.

## 2. Repository and database pre-state

### Work-ledger workspace
- Path: `/home/sunilkr/Code/multi-project-workspace`
- Branch: `master`; HEAD `e28afe7eca1a585a58ad8d8c3628fd98322e7549`
- Upstream: `origin/master`; ahead 6 / behind 0.
- Pre-existing tracked modification: `.github/workflows/ci.yml`.
- Pre-existing untracked tree: `reports/`.
- The report directory `reports/workspace-inspections/` existed before this report.

### cURL AI Bridge repository
- Path: `/home/sunilkr/Code/curl-ai-bridge`
- Branch: `test/ubuntu-self-hosted-runner-smoke`; HEAD `1ea0049d8354857c1202ecd5ff2ee6bd9467f86f`
- Upstream: same branch; ahead 2 / behind 0.
- Pre-existing tracked modifications: README.md, docs/collaboration-workflow.md, scripts/test-all.mjs, scripts/workspace-subtree.mjs, server/index.mjs, server/routing/parent-sibling-router.mjs, server/scheduler/conversation-manager.mjs, tests/scheduler/conversation-manager.mjs, tests/siblings/registry-routing.mjs, tests/smoke.mjs, tests/workspace-federation/workspace-federation.test.mjs.
- Pre-existing untracked paths: 36 entries, including workflow, docs, scripts, provider/sibling/storage modules and tests. All were preserved.

### Live SQLite
- Database: `apps/api/data/workspace.sqlite`.
- Opened read-only using SQLite URI `mode=ro`; `PRAGMA query_only=ON`.
- Integrity check returned `ok`.
- No database writes or migrations were performed.

## 3. AUTH-001 — Task #151 evidence

Live task record:
- Title: `AUTH-001: Parent-Delegated Authorization Engine (Rev8)`.
- Project: `curl-ai-bridge`.
- Status: `in_progress`.
- Description: protected authority state, mechanical evaluator, supervisor sessions, independent gate review, atomic authorization-to-lease, ROP-001 council.
- The task record's `acceptance_criteria`, `objectives`, `requirements` and `decisions` fields are empty.
- `important_context` states: planning gate complete; 29 paths (26 CREATE, 3 MODIFY); repository 1 only; lease anchors repositories {1,4}; generation 13; 55 acceptance tests.
- `agent_run_id` is null. No matching task-151 records were found in the inspected agent run/artifact/event/task-op tables.

### Planned paths

The 26 planned CREATE paths are:
- `schemas/delegated-authority.schema.json`
- `docs/delegated-authorization.md`
- `apps/api/src/canonical.js`
- `apps/api/src/sessionTokens.js`
- `apps/api/src/authoritySchema.js`
- `apps/api/src/authorityPolicy.js`
- `apps/api/src/planningGate.js`
- `apps/api/src/authorityExecution.js`
- `apps/api/src/db/authorityState.js`
- `apps/api/src/db/authorityAdmin.js`
- `apps/api/src/db/planningGateReviews.js`
- `apps/api/src/db/executionSessions.js`
- `scripts/authority-admin.mjs`
- `scripts/authority-authorize.mjs`
- `scripts/authority-review.mjs`
- `scripts/authority-session.mjs`
- `apps/api/test/authorityPolicy.test.js`
- `apps/api/test/authorityState.test.js`
- `apps/api/test/authorityAdmin.test.js`
- `apps/api/test/authorityExecution.test.js`
- `apps/api/test/authorityLifecycle.test.js`
- `apps/api/test/authorityAdversarial.test.js`
- `apps/api/test/authorityIdentity.test.js`
- `apps/api/test/executionSessions.test.js`
- `apps/api/test/planningGateReview.test.js`
- `apps/api/test/planningGateReviews.test.js`

All 26 CREATE targets were absent at inspection time. The three MODIFY targets exist:
- `apps/api/src/db/migrations.js`
- `apps/api/src/database.js`
- `apps/api/src/projectWriterLease.js`

The work-ledger Git status showed no changes to those three targets. This supports the conclusion that the planned AUTH-001 implementation is not present in this checkout; it does not establish whether uninspected external copies exist.

### Acceptance-test evidence qualification

The task record asserts a count of 55 acceptance tests, but does not contain the 55 test cases or a linked test matrix. The ten planned test-file paths are recorded, but all ten are absent. No AUTH-001 test execution or implementation verification was performed.

**Disposition:** AUTH-001 is a registered, in-progress work item with a recorded scope summary. Its detailed acceptance coverage, planning-gate evidence and implementation are not independently verifiable from the live task record and inspected workspace. Do not report the 55 tests as reviewed or passed.

## 4. G7-01 — Task #127 identity dependency

Live task record:
- Title: `G7-01 Multi-User OAuth, Operator Identity & Authorization`.
- Project: `curl-ai-bridge`.
- Status: `blocked`.
- Its stated scope includes OAuth/OIDC operator identity, roles/RBAC, token lifecycle/revocation, per-user audit attribution, PKCE/state/CSRF and ChatGPT custom MCP compatibility.
- Its blocker states project-wide HOLD and unresolved identity-provider decision; it references upstream Tasks #121 and #122.

The Bridge security document `docs/g7-cloud-transport-security.md` explicitly states:
- Current HTTP authentication uses one shared bearer token.
- It is not multi-user OAuth or per-operator identity.
- OAuth, operator identities, roles, revocation and per-user audit attribution are not implemented.
- The cloud transport increment is not a production-readiness certification.

G7-01's recorded path plan does not match the current repository layout in all places:
- `src/auth/oauthOperator.js` — absent.
- `tests/auth/oauthOperator.test.js` — absent.
- `src/server.js` — absent.
- Current documented HTTP entrypoint is `server/http.mjs`; current transport implementation is under `server/`.

**Dependency disposition:** G7-01 is the owner of production operator authentication and external OAuth/OIDC identity. AUTH-001 must consume a trusted operator-principal/assertion contract; it must not silently claim to implement production OAuth/OIDC. AUTH-001's planned `sessionTokens.js` and `authorityIdentity.test.js` need an explicit boundary statement so internal supervisor/delegation sessions are not confused with G7-01's operator login, identity and RBAC responsibilities. This is a conceptual interface overlap, not an observed path collision: AUTH-001's recorded scope is repository 1, while G7-01's planned Bridge paths belong to the Bridge repository.

G7-01 remains blocked. No identity-provider choice or OAuth configuration was made.

## 5. Existing authorization-related contracts and enforcement

### 5.1 Authorization reference schema

`schemas/authorization-reference.schema.json` requires:
- `ref`
- `level`: A0, A1 or A2
- `permissionClass`: READ, PROPOSE or MUTATE
- `scope`: unique array of strings
- `source`: operator, policy or system
- `provenanceClass`: authenticated, claimed_external, operator_direct or system

`grantedBy` and `expiresAt` are optional. The schema does not define A-level meanings/order/inheritance, a source × provenance compatibility policy, scope grammar, issuer authentication proof, task/revision/plan digest binding, issue/not-before times, budget/egress, revocation or consumption semantics. The fixture's A1 + READ example is not an authoritative definition.

### 5.2 Writer lease

The existing writer lease store:
- Requires a non-empty `authorizationRef`.
- Includes that string in the lease binding digest and idempotency comparison.
- Enforces active lease state, expiry, generation, current-lease pointer, owner/task/project bindings, binding digests and allowlist path/operation/mutation restrictions.

It does **not** resolve `authorizationRef` to a grant or verify grant issuer, permission, plan digest, expiry or revocation. The file mutation guard rechecks the lease at the final rename boundary, but no grant resolver is composed into that path. The lease is serialization/fencing, not operator authorization.

Current live lease state:
- Project fencing generation: 32.
- Current pointer references a generation-32 lease for Task #156 with status `revoked`.
- It is not a live writer lease.
- AUTH-001's recorded generation 13 is historical and cannot be used as current lease authority.

### 5.3 Core↔Bridge signed dispatch permit

The separate `contracts/core-bridge/authorization-permit.v1.schema.json` and Bridge validator define a signed EdDSA dispatch permit with task/run/project/request/idempotency/operation, audience, model/role/sibling bindings, local-only and execution-limit constraints, plus freshness and signature validation.

The Bridge validator source explicitly says it is not wired into production listeners. This contract is a Core-signed dispatch control, not a general task-mutation operator grant. It does not supply the TODO-LEDGER-003 task revision, canonical plan digest and exact repository path/operation allowlist contract. Do not merge these contracts without an explicit policy and versioned adapter.

## 6. Coverage and gap matrix

| Requirement | Existing evidence | Disposition |
|---|---|---|
| Strict reference shape | Authorization-reference JSON Schema and four fixture cases | Partial: structural validation only |
| Canonical reference parsing and trusted lookup | No resolver or registry found | Missing |
| A0/A1/A2 semantics | Enum only; no normative definitions found | Unresolved; fail closed where semantics matter |
| Permission mapping | READ/PROPOSE/MUTATE enum only | Partial; no runtime grant evaluator |
| Authenticated operator issuer | G7-01 blocked; Bridge currently shared bearer | Missing for multi-user operator identity |
| Provenance compatibility | Enum only; no proof or source/provenance matrix | Missing |
| Project/task binding | Lease binds project/task; reference schema does not | Partial, lease-only |
| Task revision and canonical plan digest | No grant binding found | Missing |
| Exact repository/path/operation grant scope | Lease allowlist enforces file operations | Partial, lease-only; no grant-to-lease scope equivalence |
| Budget and egress limits | Permit has execution limits/localOnly; mandate has policy constraints | Partial in separate contracts; not a task grant |
| Issued/not-before/expiry | Reference has optional expiry; permit has issued/expiry | Partial and contract-specific |
| Revocation/consumption/replay | Permit trust-key revocation exists; no general task grant lifecycle found | Missing for task grants |
| Atomic grant + lease enforcement | Lease fencing exists; grant resolution absent | Missing as a composed boundary |
| Mutation-time enforcement | Lease recheck exists at file rename boundary | Partial; grant must also be revalidated |
| Legacy reference preservation | TODO-LEDGER-002 design says preserve unresolved legacy references | Design only; no implementation |
| Acceptance coverage | AUTH-001 says 55 tests; no enumerated matrix or test files present | Unverified |

## 7. Normative policy contradiction — blocking

`docs/swarm-execution-mandate.md` states:
- Line 12: the reviewed planning gate “authorizes” the exact implementation allowlist.
- Line 94: readiness “authorizes” only the exact allowlist.

TODO-LEDGER-002 states the opposite separation:
- Maturity makes work eligible for a separate authorization decision.
- Only an explicit, valid, scoped operator grant authorizes mutation.
- A planning gate, task status, lease or proposal acceptance is not itself the operator grant.

This is a real wording/policy contradiction. It must not be silently reconciled by implementation. The policy owner must decide whether the mandate's “authorizes” means only planning-scope eligibility/readiness or whether its normative authority model is being changed. Until resolved, no implementation should rely on either interpretation as a grant.

## 8. Reconciled architecture recommendation

1. **AUTH-001 remains the single delegated-authority engine track** for protected authority state, mechanical policy evaluation, supervisor/delegation sessions, independent review and atomic coordination with the writer lease.
2. **TODO-LEDGER-003 remains a contract-level reconciliation**, not a parallel grant engine. Its output should define the authorization-reference resolution interface, grant semantics, denial dispositions, provenance requirements, lifecycle and mutation-boundary invariants for AUTH-001 to consume.
3. **G7-01 owns external operator identity**: OAuth/OIDC, PKCE/state/CSRF, roles/RBAC, operator token lifecycle and per-user audit attribution. AUTH-001 consumes authenticated principal claims through a versioned trusted interface.
4. **Writer lease remains independent**: both grant and lease/fencing must validate immediately before protected mutation. Non-empty reference strings never become grants by themselves.
5. **Core↔Bridge dispatch permit remains separate**: it can be an input/consumer contract only after explicit mapping; it is not the task-grant registry.
6. **A0/A1/A2 remain opaque** until the policy owner defines semantics. No ordering or permission mapping may be inferred.
7. Legacy references remain unresolved evidence; no automatic grant backfill or migration.

## 9. Required closure items before implementation consideration

- [ ] Obtain the actual AUTH-001 55-case acceptance matrix and map each case to a named test/file and expected denial/pass outcome.
- [ ] Verify all seven planning-gate records and evidence for Task #151; the current task row's summary alone is insufficient.
- [ ] Define the AUTH-001 ↔ G7-01 authenticated-principal interface and separate operator login from supervisor/delegation session tokens.
- [ ] Resolve the swarm mandate vs TODO-LEDGER-002 wording conflict under explicit policy-owner decision.
- [ ] Define A0/A1/A2 semantics and the source × provenance compatibility matrix, or explicitly remove A-level dependence from decisions.
- [ ] Specify canonical reference grammar, immutable grant record, resolver lookup trust boundary, issuer proof, revocation/expiry/consumption and replay semantics.
- [ ] Specify task revision/plan digest and exact grant scope binding, including equality/subset rules against lease allowlists.
- [ ] Define atomicity/TOCTOU behavior for grant revocation concurrent with lease-protected mutation.
- [ ] Reconcile G7-01 planned paths with the actual Bridge repository layout and its upstream blockers.
- [ ] Conduct independent review of the reconciled contract and acceptance matrix.

## 10. Sequence status and final disposition

| Approved sequence item | Status |
|---|---|
| AUTH-001 reconciliation review | Complete at plan/source-evidence level; 55 tests and gate artifact remain unverified |
| G7-01 identity dependency review | Complete; blocked identity work and interface boundary identified |
| Design closure | Complete as a recommendation; policy and semantic decisions remain open |
| Independent review | Pending |
| Separate operator decision on task registration / later implementation | Not requested or performed |

**Final disposition:** TODO-LEDGER-003 should be retained as an AUTH-001 contract reconciliation layer. AUTH-001 is the sole delegated-authorization implementation track; G7-01 is the external operator-identity owner. The existing permit and writer lease remain separate controls. The policy wording contradiction, undefined A-level semantics, missing AUTH-001 test matrix and unverified planning-gate evidence are blockers to implementation readiness.

No tasks, proposals, grants, leases, database rows, code, schemas or tests were changed. No tests/builds, Git staging/commit/push, deployment, OAuth setup or external calls were performed. Pre-existing dirty and untracked state in both repositories was preserved.

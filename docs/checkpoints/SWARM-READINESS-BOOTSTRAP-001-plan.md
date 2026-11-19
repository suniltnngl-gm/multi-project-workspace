# SWARM-READINESS-BOOTSTRAP-001 (`MPW` Task `#160`) — Reviewed Plan & Verification Record

- **Task:** MPW Task `#160` — `SWARM-READINESS-BOOTSTRAP-001 — Auditable Task Readiness Recording and Writer-Lease CLI Repository Mapping`
- **Plan Version:** `swarm-plan-v1`
- **Date:** `2026-11-19`
- **Scope:** Strictly 7 files in `multi-project-workspace` (`MPW`); 0 files in `curl-ai-bridge` (`CAB`).
- **Pre-State Anchors:**
  - `MPW` (Repo ID `1`): branch `master`, `HEAD` = `ea96dc95b60b9c6f82dbddc3c6c7c4baf4d5aa05`
  - `CAB` (Repo ID `4`): branch `test/ubuntu-self-hosted-runner-smoke`, `HEAD` = `b90d2c2b0594ddc0ac517834b45a855aaee8e1cd` (clean)
  - Live `workspace.sqlite` SHA-256: `1e0620ef1713bfc6583b680e38f8988c6090d12e8c473338785af120b3aae1fa` (unchanged)

## Seven-Point Implementation Summary

1. **Planning Evidence & Architecture:**
   - Added dedicated readiness-only store `apps/api/src/db/taskReadiness.js` with strict `swarm-plan-v1` validation (7 required sections, reviewed flag, reviewer, inspectable evidence refs, repository HEAD anchors), serialized `BEGIN IMMEDIATE` transaction, `expectedUpdatedAt` CAS, idempotent replay, append-only `task_events` provenance, and hard no-authority invariants (`status` remains `blocked`, `work_blocked` preserved, lease state and `fencing_generation` untouched).
   - Wired `recordTaskReadiness` into `apps/api/src/database.js` while preserving all existing exports and bootstrap/case-registry wiring.
   - Added bounded local CLI `scripts/task-readiness-record.mjs` with `--dry-run` support and zero network/lease calls.
   - Updated `scripts/project-writer-lease.mjs` to map each allowlist path to its registered repository identity (`1` or `4`) via explicit `<repo>:<path>`, `<repo>/<path>`, or registered absolute root prefix (with backward-compatible MPW-root handling and fail-closed rejection of unknown/ambiguous repos, traversal, and protected paths).
2. **Acceptance Criteria:** AC-1 through AC-8 verified by offline deterministic tests.
3. **Dependencies:** Resolves handoff finding `F-H1` (Repo ID `4` writer-lease mapping prerequisite) without bypassing governance gates.
4. **Exact 7-File Allowlist:**
   - `CREATE apps/api/src/db/taskReadiness.js`
   - `MODIFY apps/api/src/database.js`
   - `CREATE scripts/task-readiness-record.mjs`
   - `MODIFY scripts/project-writer-lease.mjs`
   - `CREATE apps/api/test/taskReadiness.test.js`
   - `CREATE apps/api/test/projectWriterLeaseCli.test.js`
   - `CREATE docs/checkpoints/SWARM-READINESS-BOOTSTRAP-001-plan.md`
5. **Protected Exclusions Preserved:** `.github/workflows/ci.yml`, `TASK142_RESERVED_PATHS`, `apps/api/src/db/tasks.js`, `apps/api/src/db/taskBootstrap.js`, `apps/api/src/projectWriterLease.js`, `apps/api/src/db/projectWriterLeases.js`, `apps/api/data/workspace.sqlite`, pre-existing untracked `MPW` paths, and the entire `curl-ai-bridge` repository.
6. **Reversibility, Budget & Egress:** Fully reversible; `$0.00` budget; zero network/provider calls; no commit or push.
7. **Verification Results:**
   - `node --check` on all 4 JS/MJS source files: **PASS**
   - `node --test apps/api/test/taskReadiness.test.js apps/api/test/projectWriterLeaseCli.test.js`: **9/9 PASS** (including idempotency payload conflict & invalid-plan rejection, `--dry-run` read-only pre-checks, end-to-end readiness CLI temp-DB write/replay, and Task 142/146 protected-path exceptions)
   - `npx eslint apps/api/src scripts`: **0 errors**
   - `git diff --check`: **PASS**
   - Live `workspace.sqlite` SHA-256 unchanged (`1e0620ef1713bfc6583b680e38f8988c6090d12e8c473338785af120b3aae1fa`); `curl-ai-bridge` clean at `b90d2c2`.

# Project-Wide Fenced Single-Writer Lease Runtime

## Purpose and scope

This runtime serializes authorized implementation mutations for the `curl-ai-bridge` project across the registered `multi-project-workspace` repository (ID 1) and `curl-ai-bridge` repository (ID 4). Both checkouts coordinate through the same local `workspace.sqlite` database in SQLite WAL mode.

This is a **same-host local SQLite coordinator**, not multi-host distributed consensus. Do not place the coordinating database on an unsupported network filesystem or infer cross-machine safety from this implementation.

The file mutation broker enforces its allowlist for callers that use it. SQLite cannot intercept arbitrary writes performed by unrelated processes; unbrokered writes are prohibited by project contract, but this is not kernel-level filesystem interception or an OS sandbox.

## Lease identity

A lease binds project ID, task ID, run ID, worker ID, owner ID, both registered repository roots, each repository branch and base HEAD, the canonical allowlist digest, authorization reference, expiry, lease ID, and fencing generation. A second binding digest covers the complete lease identity, repository anchors, and allowlist; both digests are recomputed at every assertion so database tampering fails closed. The two repository IDs and canonical root paths are checked against the workspace repository registry on acquisition.

## Lifecycle

`acquire` executes inside a SQLite write transaction. It expires overdue active rows, rejects a still-live holder, increments the durable project generation exactly once, inserts the lease and updates the current-lease pointer atomically. Generations are never reset by release or expiry.

`renew` requires the current lease ID, generation and owner and refuses expired or superseded leases. `release` revokes only the current holder and is idempotent for an already revoked/expired row. `reclaim-expired` marks overdue rows expired idempotently; reclamation does not itself acquire a successor. The next successful acquire increments the generation.

## Mutation boundaries

`assertCurrentWriterLease(leaseId, expectedGeneration, targetPaths)` verifies active status, expiry, current project generation, lease identity, optional owner/project binding, mutation capability, exact path/operation allowlist, repository registration, branch/HEAD anchors, traversal and symlink boundaries, and protected exclusions.

Managed task and task-event writes for project `curl-ai-bridge` call the guard inside their SQLite transaction immediately before the write. The process must provide `PROJECT_WRITER_LEASE_ID`, `PROJECT_WRITER_FENCING_GENERATION`, and `PROJECT_WRITER_OWNER_ID`. Other project task behavior remains unchanged. Migration and one-time task bootstrap are serialized bootstrap operations, not a claimed writer-lease generation. The final Task #144 closure and removal of its prerequisite blocker from Task #142 are also one serialized bootstrap-close transaction, explicitly performed before the first real lease so Task #142 can acquire generation 1. Lease lifecycle events are append-only at the database layer.

Managed file writes use `withFencedMutation` or CLI `write`. The broker stages content beside the destination, opens a SQLite write transaction, rechecks the lease and path, then atomically renames the staged file. Parent directories must already exist. Symlink components, traversal, unlisted targets, wrong operations, branch/HEAD drift and protected paths fail closed.

Task #142's thirteen reserved paths are protected from this task's mutation allowlist. The Bridge P3-B validator, Task #141 closed artifacts and Core CI workflow are protected as well.

## CLI

Run from the workspace root:

- `node scripts/project-writer-lease.mjs status`
- `node scripts/project-writer-lease.mjs acquire --task 142 --run-id <run> --worker-id <worker> --auth-ref <authorization>`
- `node scripts/project-writer-lease.mjs renew --lease <id> --generation <n> --owner <owner>`
- `node scripts/project-writer-lease.mjs release --lease <id> --generation <n> --owner <owner>`
- `node scripts/project-writer-lease.mjs reclaim-expired`
- `node scripts/project-writer-lease.mjs assert --lease <id> --generation <n>`
- `node scripts/project-writer-lease.mjs write --lease <id> --generation <n> --repository-id 1 --path <relative-path> --operation CREATE|MODIFY --content-file <staged-content>`

`acquire` derives the exact file allowlist from the selected task's `relevant_files` and pins both registered repositories to their current branch and HEAD. Keep the returned lease ID, generation and owner in the controlled execution environment; never log secrets (the lease contains no credentials).

## Bootstrap and generation 1

Task #144 itself is implemented under a one-time serialized bootstrap session because no verified runtime exists before its implementation. That bootstrap is explicitly not a lease and does not consume a fencing generation. After all Task #144 verification succeeds, the generation counter must remain zero; the first real lease acquired for Task #142 must therefore be generation 1.

## Verification and rollback

The tests cover lease lifecycle, idempotency, generation progression, process-level acquisition contention, schema shape, and mutation-path rejection. Before closing Task #144, also run the full API suite, the mandate test, coreBridge tests, and workspace-federation tests; verify SQLite integrity, protected hashes, repository states, Task #142's reserved paths and a zero generation counter. Changes are limited to the task's twelve-path allowlist. Rollback uses the verified pre-implementation SQLite backup and per-file restoration; no destructive schema operation is used.

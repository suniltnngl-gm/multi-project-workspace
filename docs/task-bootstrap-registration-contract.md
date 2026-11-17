# Task Bootstrap Registration Contract

Status: Phase A implementation contract. This mechanism is a one-time local control-plane registration path, not a writer lease and not a general task mutation API.

## Scope and authority

The only supported project is `curl-ai-bridge`. The operator invokes the local CLI `scripts/task-bootstrap-register.mjs`; no HTTP route is exposed. The bootstrap method accepts a new task descriptor, a non-empty authorization reference and a unique idempotency key. Task IDs are database allocated; caller-supplied IDs are rejected.

## Generation protocol

For the Phase A bootstrap, the expected live generation is 9 and the next SQLite task ID must be exactly 146 (both `MAX(tasks.id)` and `sqlite_sequence` are checked before and inside the transaction). Any sequence drift fails closed; IDs are never forced or reused.  The method checks that generation and rejects any active writer lease before entering its immediate SQLite transaction, then repeats the checks inside the transaction to close the race. A successful registration atomically:

1. inserts a new task with `project='curl-ai-bridge'`, `status='blocked'` and `completed=0`;
2. inserts its creation event;
3. inserts one row into `project_writer_bootstrap_events` for generation 10;
4. updates `project_writer_lease_state` to generation 10 and explicitly sets `current_lease_id=NULL`.

Any failure rolls back all writes. The bootstrap generation is retired immediately: no row is inserted into `project_writer_leases`, and it cannot authorize task mutations. The next ordinary writer lease, after its own task gate and authorization, is a separate generation.

## Audit and replay protection

The bootstrap event stores event ID, project, task ID, generation, authorization reference, unique idempotency key and timestamp. Database triggers reject UPDATE and DELETE. Reusing an idempotency key is rejected; it is not treated as an idempotent success response. The database unique constraint is the final replay barrier.

## Input and output

Required input: `task.title`, `task.project`, `authorizationRef`, `idempotencyKey`. The project must equal `curl-ai-bridge`; title length is 1–200 characters after trimming. Caller-provided task IDs are forbidden. Task status and completion inputs are ignored; persisted state is always blocked/incomplete.

CLI requires `--title`, `--authorization-ref`, `--idempotency-key`, and `--expected-generation 9`. Optional `--description` and `--database` support local operator use and isolated testing. Unknown flags fail closed.

## Safety boundaries

- No public route, generic mutation switch, provider call, network egress or package installation.
- No live registration is performed as part of Phase A implementation or tests.
- No task is created and no generation is consumed until the operator explicitly invokes the CLI against the intended database.
- The normal task writer guard remains unchanged and continues requiring an existing task-scoped lease.
- The CLI is local-only. Its database argument must be a deliberate operator-selected path.

# Portable Execution Tracking (PET) v0.1

PET links task-register identity to execution evidence without making the task register an execution log.

## Identity envelope

`task_id`, `execution_id`, `tool_run_id`, `agent_run_id`, and `session_id` are separate fields. A task may have many executions; a run or session is never substituted for a task ID.

## Evidence

The JSONL event ledger is append-only by API and hash-chained with SHA-256. Manifests hash explicitly selected regular files and record relative path, byte size, modification timestamp, and digest. Sensitive filenames (credentials, tokens, `.env`, private keys, chat/conversation/transcript payloads) are rejected or excluded.

## Discovery and locations

Discovery is opt-in. Defaults are `PET_OPENCODE_TEMP_ROOTS=[]`, `PET_AGY_TEMP_ROOTS=[]`, and `PET_STATE_ROOT=""`. No roots are guessed or probed. Explicit roots must be real directories; symlinks, traversal, and out-of-bounds paths fail closed. Collectors emit metadata only; adapters accept metadata objects and never ingest prompt or conversation bodies.

## Reconciliation

Reconciliation consumes a caller-supplied read-only task reader and evidence events, returning a derived view. It has no task-store write API and never changes task rows.

## Runtime

Node.js built-ins only; no runtime dependencies, provider calls, network access, package installation, or paid inference.

# Agent control plane

The agent control plane lets one parent agent coordinate workers without letting the
workers talk to each other. Routing, leases, retries, cancellation, and task writes
are deterministic code; a model is only called when an agent has to make a decision.
That keeps the star topology enforceable and stops quota from being spent on message
forwarding.

## Topology

```
                +-------------------+
   reviewer <-->|  primary parent   |<--> worker A
   (optional)   |  (task authority) |<--> worker B
                +-------------------+<--> worker C
```

- A run has exactly one parent, at most one reviewer, and at most six workers.
- Workers may address only `parent`. Worker-to-worker and worker-to-reviewer edges
  are rejected with `403`, even when a worker knows the other agent's id.
- The reviewer is parent-side. It can return `verdict` messages to the parent but is
  never worker-addressable.
- The primary parent is the only agent that may write tasks. Workers report results,
  progress, questions, and errors; the parent decides what becomes a task change.

## Run lifecycle

```
draft -> planning -> dispatching -> running -> reviewing -> completed
                                          \-> failed
any non-terminal ---------------------------> cancelled
```

Transitions are explicit (`POST /api/agents/runs/:id/transition`). Cancelling a run
expires every queued, leased, or delivered message and marks all unfinished agents
`cancelled`. A terminal run rejects new messages with `409`.

## Message envelope

Every message is a typed envelope:

```json
{
  "run_id": "run_...",
  "to": "worker-a",
  "kind": "assign",
  "payload": { "goal": "scan the API routes" },
  "artifact_refs": ["file:apps/api/src/routes/agents.js"],
  "idempotency_key": "assign-routes-1",
  "correlation_id": "work-1",
  "deadline_at": "2026-11-12T12:30:00.000Z"
}
```

| Kind | From | To | Purpose |
| --- | --- | --- | --- |
| `assign` | parent | worker | Give a worker a bounded unit of work |
| `progress` | worker | parent | Report phase, facts, or partial output |
| `question` | worker | parent | Ask for a decision or missing input |
| `result` | worker | parent | Return completed output |
| `error` | worker | parent | Report a failure that needs a decision |
| `cancel` | parent | worker | Stop the work in flight |
| `verdict` | reviewer | parent | Approve or reject a candidate result |
| `handoff` | parent | reviewer | Send a candidate result for review |

Rules enforced by the broker:

- Sender identity comes from the `x-agent-token` header (or `Authorization: Bearer`),
  never from the body. Raw tokens are returned only by `POST /api/agents/runs`.
- Payloads are capped at 12 KB and artifact references at 20 entries; the API JSON
  body limit remains 16 KB.
- Credential-shaped keys and values (API keys, tokens, secrets, passwords,
  authorization headers, common provider key patterns) are redacted before storage.
- Idempotency is scoped to the run. Replaying the same key with the same sender,
  recipient, kind, payload, and refs returns the original message with `duplicate:
  true`. Reusing the key for different content returns `409`.
- Claims are leased. A delivered message stays unavailable until its lease expires;
  an expired lease puts it back in the queue. Attempts are counted only on failure,
  so a crashed worker does not consume a retry.
- Messages past `deadline_at` expire instead of being delivered. The default TTL is
  five minutes (`AGENT_MESSAGE_TTL_MS`).

## Task authority

Task writes go through `POST /api/agents/runs/:id/task-ops` and are available only to
the parent agent. Each op carries an `op_id`; replaying an `op_id` returns the recorded
result instead of applying it twice.

```json
{
  "ops": [
    {
      "op_id": "create-1",
      "op": "create_task",
      "title": "Add a script for route scans",
      "description": "The same scan ran three times.",
      "priority": "medium"
    },
    {
      "op_id": "progress-1",
      "op": "update_task",
      "task_id": 42,
      "expected_updated_at": "2026-11-12T10:00:00.000Z",
      "fields": {
        "status": "in_progress",
        "work_active": "Extracting the scan."
      }
    },
    {
      "op_id": "propose-1",
      "op": "propose_task",
      "title": "Review the new scan helper",
      "rationale": "Opportunistic follow-up, not part of the assigned work."
    }
  ]
}
```

- `create_task` is limited to five created tasks per run and must hang off the run's
  task or a task created by the same run. New tasks get `parent_task_id` and
  `agent_run_id`, plus an `agent_linked` activity event.
- `update_task` requires `expected_updated_at`. A stale timestamp returns `conflict`
  with the current timestamp; it never overwrites a human edit.
- Setting `status: "done"` requires `verified: true` and non-empty acceptance
  criteria. Setting `status: "blocked"` requires a reason, which is written to
  `work_blocked`.
- `propose_task` creates a pending proposal with `origin_agent_run_id`; it does not
  create a task. A duplicate pending proposal is skipped.

## Script-first resolution

Before asking a model to repeat a known procedure, resolve the intent:

```json
POST /api/agents/scripts/resolve
{ "intent": "list markdown files in a folder", "input": { "path": "docs" } }
```

The result is one of:

- `script` — a registered script matched and every required input is present.
- `needs_input` — a script matched but `missingInputs` still has to be supplied.
- `model` — no script matched, so the caller may spend quota on a model.

The registry stores the command but never executes it; execution stays with the
worker runtime, under its own sandbox and timeout. Verified scripts win ties; editing
a script bumps its version and clears verification. Register scripts with
`POST /api/agents/scripts` and mark a successful run with
`POST /api/agents/scripts/:id/verify`.

Artifacts are content-addressed. `POST /api/agents/artifacts` stores a small summary
by SHA-256 and writes the bytes beside the database under
`apps/api/data/agent-artifacts/` (override with `AGENT_ARTIFACT_DIR`). Workers should
reference artifacts instead of pasting large outputs into messages:

```json
{
  "kind": "summary",
  "producer": "worker-a",
  "content": "{\"files\":[\"README.md\",\"docs/agent-protocol.md\"]}"
}
```

Expired artifacts are removed by `pruneAgentArtifacts()` with their files; the HTTP
surface exposes metadata and optional content through
`GET /api/agents/artifacts/:hash?content=true`.

## Routes

- `POST /api/agents/runs` — create a run; returns each agent's raw token once
- `GET /api/agents/runs` / `GET /api/agents/runs/:id` — inspect runs, agents,
  messages, events, and task ops
- `POST /api/agents/runs/:id/start` — move `draft` to `planning`
- `POST /api/agents/runs/:id/transition` — move to an allowed next state
- `POST /api/agents/runs/:id/cancel` — cancel and expire pending work
- `POST /api/agents/runs/:id/checkpoint` — authenticated bounded run checkpoint
- `GET|POST /api/agents/runs/:id/usage` — run usage totals, or record a worker's real usage
- `GET /api/agents/runs/:id/dispatch-plan` — zero-token provider headroom and concurrency plan
- `GET /api/models/providers` — provider-level quota headroom for the whole roster
- `GET /api/agents/runs/:id/messages|events|task-ops` — run history
- `POST /api/agents/messages` — send a typed message
- `POST /api/agents/inbox/claim` — lease the next inbox messages
- `POST /api/agents/messages/:id/ack|complete|fail` — settle a claimed message
- `POST /api/agents/heartbeat` — extend an agent lease
- `POST /api/agents/runs/:id/task-ops` — parent-only task writes
- `GET|POST /api/agents/scripts`, `POST /api/agents/scripts/resolve`,
  `POST /api/agents/scripts/:id/verify` — script registry and resolver
- `POST /api/agents/artifacts`, `GET /api/agents/artifacts/:hash` — content-addressed artifact metadata

The control-plane routes are unauthenticated for reads, like the rest of the local
board. The API binds to `127.0.0.1` by default; agent writes require a per-run token.

## Limits and configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RUN_BUDGET_TOKENS` | `20000` | Default token budget stored on a run |
| `AGENT_RUN_BUDGET_CALLS` | `20` | Default model-call budget |
| `AGENT_RUN_BUDGET_MS` | `600000` | Default wall-clock budget |
| `AGENT_MESSAGE_TTL_MS` | `300000` | Default message deadline |
| `AGENT_MESSAGE_MAX_ATTEMPTS` | `3` | Delivery attempts before dead-letter |
| `AGENT_LEASE_MS` | `30000` | Default inbox lease |
| `AGENT_CLAIM_LIMIT` | `10` | Default messages per claim |
| `AGENT_MAX_CLAIM_LIMIT` | `20` | Largest allowed claim |
| `AGENT_CHECKPOINT_MAX_BYTES` | `65536` | Checkpoint size cap |
| `AGENT_MAX_PARALLEL_PER_PROVIDER` | `1` | Active assignments allowed per provider quota domain |
| `AGENT_ARTIFACT_DIR` | `apps/api/data/agent-artifacts` | Artifact byte directory |

Budgets are stored on the run and reported by the broker; they do not bypass the
existing model quota ledger. Provider `429`/`503` responses and `Retry-After` remain
authoritative, and changing a model mid-run remains forbidden because it discards the
provider prompt cache.

## Provider-aware dispatch

An `assign` message is the only message kind that asks a worker to spend model
quota, so the broker gates it before writing the queue record. Three checks run in
order, and a refusal costs no model call:

1. The run budget must have remaining tokens, calls, and wall-clock time.
2. The worker's model must have quota headroom in the existing `modelBudget`
   ledger. A blocked or cooling-down provider returns `429` with `retryAfter` and
   the limiter snapshot.
3. The provider quota domain must have fewer than
   `AGENT_MAX_PARALLEL_PER_PROVIDER` active assignments. A provider is blocked
   until a claimed assignment is completed, failed, or expired.

Messages other than `assign` stay ungated so a worker can always report a result,
ask a question, or fail. Workers report real usage with
`POST /api/agents/runs/:id/usage`; the broker stores it in `agent_run_usage` and
counts it toward the run budget even when the spend pushes the run over. The next
assignment is what stops. `GET /api/agents/runs/:id/usage` returns totals by model,
and `GET /api/agents/runs/:id/dispatch-plan` returns the same plan the broker uses:
which model each agent is pinned to, which provider it spends, current headroom,
active assignments, and the budget that remains. Provider grouping is data-driven:
named backends share a quota domain, while each generic `serverless` slot or
`ollama` model keeps its own domain because it may be a different account. Billing
category is ordering metadata only and never grants permission.

Reservations are memory-only. A dispatch reserves a slot before the call and
settles the real usage afterward, so two concurrent jobs cannot both consume the
last request. A crash loses the reservation, not the persisted usage already
settled into `ai_quota`.

## Example flow

1. `POST /api/agents/runs` with a parent and workers; keep the returned tokens.
2. `POST /api/agents/runs/:id/start`.
3. The parent resolves an intent with `POST /api/agents/scripts/resolve`. If the
   decision is `script`, run it locally; only call a model for `model`.
4. The parent sends `assign` messages and workers claim, work, and return `result`
   messages.
5. The parent applies `task-ops` with optimistic tokens, sending `done` only after a
   verifier result. Opportunistic work becomes `propose_task`.
6. The parent transitions to `reviewing`, optionally uses the reviewer for a
   `verdict`, then moves to `completed`.

Every message, state change, task op, and checkpoint is appended to `agent_events`,
so a run can be reconstructed without replaying model output.

## Swarm orchestration & multi-agent draft routes

For higher-level orchestration built on top of this protocol — including the
non-native `2+2+2` swarm runner (`./workspace ai swarm` and `/api/agents/swarm/*`),
`parent_mode` (`deterministic`, `auto`, `ai`), reviewer retry rounds, register
backfill, context hydration, and multi-agent execution across `/api/local-ai/*` and
`/api/ai/*` — see [AGENTS.md](../AGENTS.md).

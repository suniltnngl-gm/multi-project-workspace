# AGENTS.md — Multi-Agent Architecture & Contributor Guide

This file documents how AI agents, swarm runs, context hydration, resource/quota gates, and repository tracking conventions work in **multi-project-workspace**.

---

## 1. Architecture & Topology

Every agent orchestration path in this workspace uses a **star topology** backed by SQLite rather than unmanaged peer-to-peer chat:

```text
                  +-------------------+
   reviewer <---->|  primary parent   |<----> worker-1
  (parent-side)   | (task authority)  |<----> worker-2
                  +-------------------+<----> worker-N (up to 6)
```

- **Zero-Token Control Plane ([apps/api/src/agentBus.js](apps/api/src/agentBus.js))**: Routing, per-agent token auth (`x-agent-token`), inbox leases, retries, cancellation, checkpoints, and `agent_task_ops` writes are deterministic code. Workers cannot address each other or the reviewer (`403`); all worker messages flow through `parent`.
- **Non-Native `2+2+2` Swarm Runner ([apps/api/src/swarmRunner.js](apps/api/src/swarmRunner.js))**: Coordinates parallel workers across distinct quota domains (**2 local** + **2 CLI** + **2 remote** pools via [apps/api/src/providerQuota.js](apps/api/src/providerQuota.js)) using isolated `promptCacheKey` values and compact `#seq` delta pointers instead of replaying full transcripts.
- **Multi-Agent Draft Routes ([apps/api/src/routes/aiDrafts.js](apps/api/src/routes/aiDrafts.js))**: All four drafting endpoints execute as tracked `agentBus` runs (`parent` + `worker-1..N` + optional `reviewer`) while preserving backward-compatible HTTP responses (`jobId` + `agentRunId`):
  - `POST /api/local-ai/refine-task`
  - `POST /api/local-ai/jobs`
  - `POST /api/ai/complete`
  - `POST /api/ai/improve` (stamps proposals with `originAgentRunId`)

Supported multi-agent request fields on draft routes: `workers` / `worker_count` (`1..6`), `models` (array of up to 6 model IDs), `include_reviewer` (`boolean`), `include_context` (`boolean`), and `backfill_registers` (`boolean`).

---

## 2. Permanent Workflow Strategy: Parallel Swarm + Self-Improvement

Every multi-step engineering, refactoring, portability, or review task should use the **parallel swarm + parallel self-improvement strategy** (`selfImprove: true` by default in `swarmRunner.js`, `POST /api/agents/swarm`, and `./workspace ai swarm`):

1. **Primary Worker Fan-Out (`2+2+2`)**: Independent slices execute in parallel across isolated quota domains (`local`, `cli`, `remote`) with isolated `promptCacheKey` sessions and `#seq` delta pointers.
2. **Parallel Self-Improvement Lane**: During `stepSwarm` and `finalizeSwarmRun`, a zero-token self-improvement audit runs in parallel with the worker pool (`buildParallelSelfImprovement`), combining:
   - Deterministic `scanWorkspaceSensors` gap and portability checks (`tracking.repository_root_missing`, `tracking.worktree_missing`, missing file/folder objectives, quota blocks),
   - Live run telemetry (`agent.model_switched` fallback transitions, token/call usage, slice completion/failure counts), and
   - Deduplicated worker/reviewer `proposals` (plus optional `--auto-propose` / `auto_propose_self_improvement` conversion of sensor/portability findings into `task_proposals`).
3. **Structured Persistence**: Every completed or failed run records `selfImprovement` on the board/checkpoint/result, syncs task registers and `work_completed`/`next_move` via `agent_task_ops`, and compacts outcomes into `ai_sessions` for subsequent agents.
4. **Portability Guarantee**: Never hardcode local machine paths, OS-specific separators, or personal cloud/Kaggle handles in source files or docs; parameterize machine/account settings via `.env` and keep workspace-local SQLite state relocatable.

### CLI & HTTP Surfaces

| Surface | Commands / Endpoints |
| --- | --- |
| **Standalone CLI** ([scripts/ai-swarm.mjs](scripts/ai-swarm.mjs)) | `./workspace ai swarm plan\|run\|board <runId>\|step <runId>\|list` |
| **HTTP Swarm API** ([apps/api/src/routes/agents.js](apps/api/src/routes/agents.js)) | `POST /api/agents/swarm/plan`, `POST /api/agents/swarm`, `GET /api/agents/runs/:id/board`, `POST /api/agents/runs/:id/step`, `POST /api/agents/runs/:id/execute` |

Key options:
- **CLI flags**: `--task ID`, `--slices "s1;s2"`, `--workers N`, `--models m1,m2`, `--opencode-models ...`, `--parent-mode deterministic|auto|ai`, `--review-rounds N`, `--complete-task`, `--no-reviewer`, `--self-improve|--no-self-improve`, `--auto-propose`, `--max-tokens N`, `--max-calls N`, `--max-steps N`, `--worktree PATH`, `--title TITLE`, `--database PATH`, `--dry-run`, `--json`.
- **HTTP body fields**: `objective`, `title`, `task_id` (`taskId`), `slices`, `worker_count` (`workerCount`), `models`, `opencode_models`, `include_reviewer`, `worktree_path`, `parent_mode` (`parentMode`), `max_review_rounds` (`maxReviewRounds`), `sync_task` (`syncTask`), `complete_task` (`completeTask`), `self_improve` (`selfImprove`), `auto_propose_self_improvement`, `execute`, `max_steps` (`maxSteps`).

### In-Process AI Parent / Sibling Hooks

1. **Parent Auto-Slicing (`parentMode`)**:
   - `deterministic` *(default)*: Zero parent model calls; slices come from `--slices`, `task.acceptance_criteria`, or `;`/newline delimiters.
   - `auto`: Calls the parent model once only when no explicit/delimited slices exist; otherwise stays deterministic (`0` parent tokens).
   - `ai`: Uses one structured parent model call (`runParentAutoSlice`) to decompose the objective into independent worker slices.
2. **Worker Question Answering**: When a worker responds with `kind: 'question'` (or a `question` field), `answerWorkerQuestions` lets the parent answer concisely via `assign` (`parentAnswer`) without exposing sibling transcripts.
3. **Reviewer Retry Loops (`maxReviewRounds`)**: When the parent-side reviewer rejects a handoff, `startRevisionRound` re-assigns targeted revision steps with reviewer feedback up to `maxReviewRounds` before failing or completing.
4. **Task & Job Synchronization**: `executeSwarm` wraps execution in `jobStore` (supporting cancellation via `AbortSignal`), and `finalizeSwarmRun` records `agent_task_ops` before transitioning the run to its terminal state.

---

## 3. Context Hydration & Register Backfill

New sessions and agents start with bounded, database-backed registers rather than dumping raw source files into prompts ([apps/api/src/localAiPrompt.js](apps/api/src/localAiPrompt.js)):

- **1-Hop File & Folder Resolution (`resolveFileAndFolderRegisters`)**: Expands `relevant_files` 1-hop across `user_files` and resolves ancestor `folders.objective` rows from SQLite without reading file bodies.
- **Pre-Run Register Backfill (`backfillTaskRegisters`)**: Hydrates and persists blank task registers (`objectives`, `requirements`, `decisions`, `relevant_files`, `important_context`) on `tasks` before dispatching agents.
- **Budgeted Prompt Context (`formatAgentContextBlock`)**: Prioritizes `Session summary` and task work-state registers (`work_completed`, `work_active`, `next_move`) ahead of planning fields and folder/file registers within `maxChars` (`1200` default).
- **Session Compaction (`recordAgentSessionExchange`)**: Compacts completed swarm/draft outcomes back into `ai_sessions` so follow-up runs inherit prior decisions.

---

## 4. Resource Gates, Quotas & Billing Rules

All single-agent and multi-agent calls share the same conservative safety gates:

- **Pre-Dispatch Reservation ([apps/api/src/modelBudget.js](apps/api/src/modelBudget.js))**: `modelBudget.reserve` claims an in-memory slot before calling a model and settles real `usage` afterward; silent zero-usage completions incur conservative estimated token penalties.
- **Provider Concurrency & Headroom ([apps/api/src/agentBus.js](apps/api/src/agentBus.js), [apps/api/src/providerQuota.js](apps/api/src/providerQuota.js))**: `assign` checks run budget, `modelBudget` headroom, and `AGENT_MAX_PARALLEL_PER_PROVIDER` (default `1`). Routes that pre-reserve in `selectDraftModel` pass `preReserved: true` to `agentBus.sendMessage` so per-minute limiters are not double-charged while run budgets and provider concurrency remain enforced.
- **Learned 429 Caps & Billing Circuit Breakers**:
  - `observe429` records `observed-requests`, `observed-429`, and `observed-cooldown` rows in `ai_quota`, tightening learned caps without overwriting configured profiles and surviving API restarts.
  - HTTP `402` / billing errors trip `observeBillingError` (`billing-cooldown`, 6h default) so paid/changed accounts fail over instead of burning retries.
- **Local Hardware Gates ([apps/api/src/workspaceSensors.js](apps/api/src/workspaceSensors.js), [apps/api/src/modelScheduler.js](apps/api/src/modelScheduler.js))**: Local HTTP models (`local-0.5b`, `local-1.5b`) are gated by live adaptive CPU load average, `MemAvailable` / free RAM thresholds (`1024` / `1792` MiB), disk busy percent (`<= 30%`), GPU VRAM/temperature, and swap activity.

---

## 5. Codebase & Tracking Conventions

- **Leading File Header Registers**: Tracked source files and scripts carry 6 leading comment lines (`//` in JS, `#` in Python/shell):
  `Objective:`, `Requirements:`, `Decisions:`, `Relevant Files:`, `Important Context:`, and informational `Work State:`.
- **Resync After Edits**: `./workspace install` installs a `post-commit` hook that runs `./workspace files scan`. Manually run `./workspace files scan && ./workspace files check` after changing headers.
- **Task Worktree Isolation**: Create task worktrees with `./workspace task worktree create <id>` so agent runs execute outside the main checkout (`<repo>-worktrees/task-<id>-<slug>`).
- **Required Verification Before Finishing**:
  - Focused API tests: `node --test apps/api/test/<file>.test.js`
  - Full CI-equivalent gate: `CI=true ./workspace self-check` (runs ESLint, Vitest, Node API tests, Python `unittest`, Vite production build, all 5 domain scans + checks, and `ai doctor --strict --offline`).

See [docs/agent-protocol.md](docs/agent-protocol.md) for the low-level message matrix, states, and database schema details.

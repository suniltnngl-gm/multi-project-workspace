# Task API & Tracking Domains

Both the Node/Express API (`apps/api`, default `http://127.0.0.1:3001`) and the Python analytics satellite (`apps/python`, default `http://127.0.0.1:3002`) share one SQLite database at `apps/api/data/workspace.sqlite` (override with `DATABASE_PATH`, anchored to the workspace root when relative). Both services bind to `127.0.0.1` by default.

---

## Tasks, Activity & Worktrees

- `GET /api/tasks` — list tasks; supports `project`, `status`, `priority`, `task_type`, and `search` filters.
- `GET /api/tasks/:id` — return one task with its newest-first activity timeline (`activity_limit`, default `50`, max `200`) and linked AI runs (`ai_limit`, default `20`, max `100`, matched by task link or `origin_job_id`).
- `GET /api/projects` — list project names used by tasks.
- `POST /api/tasks` — create a task with `title`, `project`, `task_type` (`feature`, `bug`, `chore`, `test`, `docs`), `priority` (`low`, `medium`, `high`, `urgent`), `status` (`todo`, `in_progress`, `blocked`, `done`), `description`, `acceptance_criteria`, planning registers (`objectives`, `requirements`, `decisions`, `relevant_files`, `important_context`), and work state (`work_completed`, `work_active`, `work_blocked`, `next_move`). Optional `source_job_id` links the drafting AI job (`404` if unknown, `409` if already linked).
- `PATCH /api/tasks/:id` — update any task field (`completed` maps to `done`/`todo`); field-level changes are appended to `task_events`.
- `DELETE /api/tasks/:id` — delete a task (unlinks `ai_jobs` rather than deleting run history).
- `POST /api/tasks/:id/worktree` — create an isolated sibling Git worktree (`<repo>-worktrees/task-<id>-<slug>`, branch `task/<id>-<slug>`, overridable via `WORKSPACE_TASK_WORKTREE_ROOT`), record `worktree_linked`, and register it in `git_worktrees`. Stale links self-heal on re-create; live duplicates return `409`.
- `DELETE /api/tasks/:id/worktree` — remove the linked worktree and record `worktree_unlinked` (`?force=1` removes dirty worktrees).

CLI equivalents:

```sh
./workspace task worktree <id>
./workspace task worktree create <id> [--branch NAME] [--name NAME]
./workspace task worktree remove <id> [--force]
```

---

## Tracking Domains & Multi-Repo Scoping

The workspace maintains seven tracking domains in SQLite:

1. **Tasks** — workflow, planning registers, work state, proposals, and activity timeline.
2. **Repositories** — registered workspace roots that scope files, folders, and worktrees (primary root `id = 1` auto-adopts when a workspace checkout moves).
3. **User files** — `objective`, `requirements`, `decisions`, `relevant_files`, and `important_context` synced from file leading headers.
4. **Folders** — folder-level objectives.
5. **Git worktrees** — repository root, worktree path, branch, `HEAD` commit, and remote URL.
6. **Tools** — availability and versions for required (`node`, `npm`, `uv`, `python`, `git`) and optional (`colab`, `kaggle`, `opencode`, `agy`) CLI tools.
7. **Environments** — OS, release, architecture, `cwd`, and runtime versions.

### Endpoints

- **Repositories**: `GET /api/repositories`, `GET /api/repositories/:id`, `POST /api/repositories` (`root_path`, optional `name`; nested or overlapping roots return `409`).
- **User files**: `GET /api/files` (`search`, `repository`), `POST /api/files/scan` (optional `root`), `POST /api/files`, `PATCH /api/files/:id`, `DELETE /api/files/:id`.
- **Folders**: `GET /api/folders`, `POST /api/folders/scan` (optional `root`), `POST /api/folders`, `PATCH /api/folders/:id`, `DELETE /api/folders/:id`.
- **Git worktrees**: `GET /api/git-worktrees`, `POST /api/git-worktrees/scan`.
- **Verification runner**: `GET /api/verify` (allowlisted local checks and timeouts), `POST /api/verify` (`{ "checks": ["lint", "api-tests"] }` executes bounded subprocesses and returns structured pass/fail/timeout results).
- **Health**: `GET /health`.

### File Header Sync Behavior

Tracked files can include leading comment lines (`# Objective:`, `# Requirements:`, `# Decisions:`, `# Relevant Files:`, `# Important Context:`, using `//` in JS). `./workspace files scan` and the board's **Scan user files** action parse this header block:

- Content-hash scoped: unchanged files are skipped.
- Sync writes only changed header fields (`synced` event in `GET /api/files/:id`); manual edits record `updated` events.
- Missing header lines preserve existing DB values instead of erasing them; disappeared files are marked `missing_at` (`missing` / `restored` events) and only pruned via `DELETE /api/files/:id`.
- `./workspace install` installs a `post-commit` hook that runs `./workspace files scan` automatically after commits (existing user-authored hooks are preserved).

---

## AI Endpoints, Sessions, Prompts & Agents

- **Sessions**: `GET /api/ai/sessions`, `POST /api/ai/sessions`, `GET /api/ai/sessions/:id`, `POST /api/ai/sessions/:id/messages`, `POST /api/ai/sessions/:id/compact`, `DELETE /api/ai/sessions/:id`.
- **Prompt templates**: `GET /api/prompt-templates`, `POST /api/prompt-templates`, `GET /api/prompt-templates/:id`, `PATCH /api/prompt-templates/:id`, `DELETE /api/prompt-templates/:id` (renders `{{variable}}` placeholders).
- **Models & status**: `GET /api/models`, `GET /api/models/providers`, `GET /api/models/opencode` (`?refresh=1`), `GET /api/local-ai/status`.
- **Multi-agent drafting & completions**:
  - `POST /api/local-ai/refine-task` — multi-agent draft of `description` + `acceptance_criteria` with `task_id` / `session_id` context hydration and returned `jobId` + `agentRunId` (Pass `jobId` as `source_job_id` on `POST /api/tasks`).
  - `POST /api/local-ai/jobs`, `GET /api/local-ai/jobs`, `GET /api/local-ai/jobs/:id`, `DELETE /api/local-ai/jobs/:id` (`202` cancel requested, `409` already terminal).
  - `POST /api/ai/complete` — direct multi-agent chat (`prompt`/`messages`, `system`, `model`, `max_tokens`, `prompt_template_id`, `variables`, `session_id`, `task_id`, plus multi-agent/context flags); executes inside the task's live worktree when present.
  - `POST /api/ai/improve` — generates workspace improvement suggestions stored as **task proposals** (`originAgentRunId` stamped; require human approval before becoming tasks).
- **Agent control plane & swarm**: See [docs/agent-protocol.md](agent-protocol.md) and [../AGENTS.md](../AGENTS.md).
- **Workspace sensors**: See [docs/sensors.md](sensors.md).

---

## Python Analytics Satellite

- `GET /health` — satellite and SQLite health check.
- `GET /summary` — total, open, and completed task counts from SQLite.

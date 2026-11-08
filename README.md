# Multi-project workspace

This workspace contains a Vite frontend, an Express/Node.js API, a Python analytics satellite, and shared utilities. Both backend services read the same SQLite task store at `apps/api/data/workspace.sqlite` by default; the database is created automatically by the Node API and ignored by Git.

## Run locally

```sh
./workspace install
./workspace dev
```

The web app is available at http://localhost:5173, the Node API at http://localhost:3001, and the Python satellite at http://localhost:3002. The Vite dev server proxies `/api` to Node and `/satellite` to Python.

Useful commands:

- `./workspace dev` — start all services
- `./workspace web`, `./workspace node`, `./workspace python` — start one service
- `./workspace install` — install npm dependencies and sync the uv-managed Python environment
- `./workspace python-add <package>` — add a tracked Python dependency with uv
- `./workspace python-pip install <package>` — use uv's pip-compatible interface in the workspace environment
- `./workspace test` / `./workspace build` — run checks or build
- `npm run dev:web` / `npm run dev:api` / `npm run dev:python` — run one workspace directly
- `npm run build` — build the frontend
- `npm test` — run backend tests
- `npm run start:api` — start the API without the Vite dev server

Python is managed by [uv](https://docs.astral.sh/uv/), with its version pinned in `apps/python/.python-version` and its project metadata in `apps/python/pyproject.toml`. Commands use an activated `VIRTUAL_ENV` when present; otherwise, they use `apps/python/.venv` by default (configurable with `UV_PROJECT_ENVIRONMENT`). Add persistent project dependencies with `./workspace python-add <package>` so `pyproject.toml` and `uv.lock` stay in sync. For pip-compatible operations, use `./workspace python-pip ...`; it calls `uv pip` against that environment, never standalone pip. The Python service currently uses only the standard library, so no third-party packages are required.

Set `DATABASE_PATH` to use a different SQLite file. Set `PORT` for the Node API or `PYTHON_PORT` for the Python satellite. Set `UV` to select a uv executable if it is not on `PATH`.

## Task API

- `GET /api/tasks` — list tasks; supports `project`, `status`, `priority`, `task_type`, and `search` filters
- `GET /api/projects` — list project names used by tasks
- `POST /api/tasks` — create tasks with title, project, type (`feature`, `bug`, `chore`, `test`, `docs`), priority (`low`, `medium`, `high`, `urgent`), status (`todo`, `in_progress`, `blocked`, `done`), description, and acceptance criteria
- `PATCH /api/tasks/:id` — update any of those task fields; `completed` remains supported for older clients and maps to `done`/`todo`
- `DELETE /api/tasks/:id` — delete a task
- `GET /health` — API health

The web board supports adding, editing, filtering, searching, reprioritizing, moving tasks through the development workflow, and deleting tasks. Existing SQLite task databases are migrated on startup; old completed tasks become `done`, and other existing tasks retain their content with sensible defaults.

## Local task assistant

The board's **Draft brief with local AI** action asks the local llama.cpp model to refine a task description and acceptance criteria. The result is only placed into the form for review; it is never saved automatically. Start the model separately:

```sh
./workspace local-ai 0.5b
# Or, after installing the 1.5B model:
./workspace local-ai 1.5b
```

The 0.5B and 1.5B Q4_K_M models can both be stored locally, but the launcher starts only one model server at a time. Stop the running server with Ctrl+C before switching models. Set `LOCAL_AI_CONTEXT` or `LOCAL_AI_THREADS` to change the defaults (`1024` context tokens and `2` threads).

The [Colab free-tier notebook](./notebooks/colab-qwen-coder-free-tier.ipynb) adds Qwen2.5-Coder 3B as a third backend beside the local 0.5B and 1.5B models. It requires no GCP project or billing account; Colab may require a Google account, and free GPU availability/session quotas vary. Open the notebook in VS Code, choose **Select Kernel → Colab → Auto Connect**, and sign in when prompted. Select a T4 GPU if Colab offers runtime choices. Approve the notebook's Drive mount when prompted. The model snapshot is stored in `MyDrive/colab-models` so later runtimes can reuse it; allow about 6 GB of Drive storage. Runtime packages, the live model server, API key, and tunnel remain temporary and must be started again after reconnecting. Run the remaining cells through the authenticated endpoint and tunnel setup. Copy the printed `export LOCAL_AI_URL=...` line into a local terminal, then enter the printed bearer key at the hidden prompt and start `./workspace dev-colab`. The board uses the same resource gate, prompt router, output validation, and unsaved-draft flow for all three model choices. To switch back to local inference, stop the workspace and use `./workspace dev` alongside `./workspace local-ai 0.5b` or `1.5b`.

The Colab integration uses a temporary public Cloudflare quick tunnel protected by a random bearer key. Task text sent to the 3B backend leaves the local machine and passes through Cloudflare to the Colab runtime; do not send secrets or sensitive work items. The Colab endpoint serializes inference and caps prompt/output sizes. Treat the displayed key as a password, do not commit it, and clear the notebook output before sharing. The tunnel and model stop when the Colab runtime disconnects.

The API starts generation only when all monitored resources are within their limits: the system's 1-minute load average is below an adaptive CPU threshold, available memory is at least `1024` MiB, and physical-disk busy time is at most `30%`. The CPU threshold starts at the configured maximum (`1.0` by default), drops by `0.1` after 10 seconds of sustained overload, and recovers by `0.05` after 30 seconds below the threshold with `0.15` load-average hysteresis. It stays between `LOCAL_AI_MIN_LOAD` (`0.5`) and `LOCAL_AI_MAX_LOAD` (`1.0`). Adaptation is observed at most once every five seconds. While any limit is exceeded, the board reports the specific resource and retries every five seconds. Memory and disk limits are configurable with `LOCAL_AI_MIN_AVAILABLE_MEMORY_MB` and `LOCAL_AI_MAX_DISK_BUSY_PERCENT`; the server URL is configurable with `LOCAL_AI_URL`. Memory is read from Linux `MemAvailable`, and physical-disk busy time is averaged over a minimum five-second `/proc/diskstats` sampling window; intermediate checks reuse the latest disk measurement while still refreshing CPU and memory. If resource monitoring is unavailable, generation is refused rather than started without a safety check.

Inference is one-at-a-time with a 120-second per-turn timeout and a 15-second post-turn cooldown (`LOCAL_AI_TURN_COOLDOWN_MS`): overlapping requests are refused and the board retries after five seconds, avoiding parallel or back-to-back CPU bursts. The prompt router sends short task requests through a compact prompt with a 180-token output cap, and detailed requests through a constraint-preserving prompt with a 300-token cap. Inputs are split into labeled task fields and bounded to 2,200 characters so long notes cannot consume the model context; they are trimmed, not sent as multiple model calls. The router selects prompt style and output budget only—the llama-server loads one selected model at launch and is not hot-switched between 0.5B and 1.5B. Model use remains on-demand rather than scheduled by work-shift hours. If resources become busy after generation starts, the current request is allowed to finish; later generations wait until resources are within limits. The model endpoint is localhost-only by default and is not exposed through the browser.

## Python satellite

- `GET /health` — satellite and database health
- `GET /summary` — total, open, and completed task counts from SQLite

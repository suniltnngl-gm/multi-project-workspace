# Multi-project workspace

This workspace contains a Vite frontend, an Express/Node.js API, a Python analytics satellite, and shared utilities. Both backend services read the same SQLite task store at `apps/api/data/workspace.sqlite` by default; the database is created automatically by the Node API and ignored by Git.

## Run locally

```sh
./workspace install
./workspace dev
```

The web app is available at http://localhost:5173, the Node API at http://localhost:3001, and the Python satellite at http://localhost:3002. The Vite dev server proxies `/api` to Node and `/satellite` to Python.

For portable configuration, copy `.env.example` to `.env` and set machine-specific values there. The Node and Python services load the workspace-root `.env` automatically, and the `./workspace` launcher passes those settings to child processes. Values already set in the shell take precedence. Keep `.env` private; it is ignored by Git.

Install scripts are disabled in `.npmrc` so `npm install` works without a C++ toolchain: `better-sqlite3` ships platform-specific prebuilt binaries. If a future dependency needs its install script, run `npm install --ignore-scripts=false` for that installation.

Useful commands:

- `./workspace dev` — start all services
- `./workspace web`, `./workspace node`, `./workspace python` — start one service
- `./workspace install` — install npm dependencies and sync the uv-managed Python environment
- `./workspace python-add <package>` — add a tracked Python dependency with uv
- `./workspace python-pip install <package>` — use uv's pip-compatible interface in the workspace environment
- `./workspace test` / `./workspace lint` / `./workspace build` — run tests, lint the frontend, or build
- `npm run dev:web` / `npm run dev:api` / `npm run dev:python` — run one workspace directly
- `npm run build` — build the frontend
- `npm test` — run frontend and backend tests
- `npm run lint` — lint the frontend

The frontend uses Vitest with jsdom for DOM-level tests and ESLint for static checks; both are configured inside `apps/web`.
- `npm run start:api` — start the API without the Vite dev server

Python is managed by [uv](https://docs.astral.sh/uv/), with its version pinned in `apps/python/.python-version` and its project metadata in `apps/python/pyproject.toml`. Commands use an activated `VIRTUAL_ENV` when present; otherwise, they use `apps/python/.venv` by default (configurable with `UV_PROJECT_ENVIRONMENT`). Add persistent project dependencies with `./workspace python-add <package>` so `pyproject.toml` and `uv.lock` stay in sync. For pip-compatible operations, use `./workspace python-pip ...`; it calls `uv pip` against that environment, never standalone pip. The Python service uses `python-dotenv` to load the workspace-root `.env` file.

Set `DATABASE_PATH` to use a different SQLite file. Set `PORT` for the Node API or `PYTHON_PORT` for the Python satellite. Both backend services bind to `127.0.0.1` by default; set `HOST` to override the bind address. The Vite dev server and preview also bind to `127.0.0.1`, so the unauthenticated task API is not exposed through the proxy on the local network. Set `UV` to select a uv executable if it is not on `PATH`.

## Task API

- `GET /api/tasks` — list tasks; supports `project`, `status`, `priority`, `task_type`, and `search` filters
- `GET /api/projects` — list project names used by tasks
- `POST /api/tasks` — create tasks with title, project, type (`feature`, `bug`, `chore`, `test`, `docs`), priority (`low`, `medium`, `high`, `urgent`), status (`todo`, `in_progress`, `blocked`, `done`), description, and acceptance criteria
- `PATCH /api/tasks/:id` — update any of those task fields; `completed` remains supported for older clients and maps to `done`/`todo`
- `DELETE /api/tasks/:id` — delete a task
- `GET /health` — API health

The web board supports adding, editing, filtering, searching, reprioritizing, moving tasks through the development workflow, and deleting tasks. Existing SQLite task databases are migrated on startup; old completed tasks become `done`, and other existing tasks retain their content with sensible defaults.

## Local task assistant

The board's **Draft brief with local AI** action asks a local llama.cpp model to refine a task description and acceptance criteria. The result is only placed into the form for review; it is never saved automatically. Start the local models separately:

```sh
./workspace local-ai        # start every installed model within memory limits
./workspace local-ai 0.5b   # start only the 0.5B model on :8080
./workspace local-ai 1.5b   # start only the 1.5B model on :8081
```

The workspace tracks four models in one registry: the two local Qwen2.5-Coder models (0.5B and 1.5B) and the two web notebooks (Colab 3B and Kaggle 3B). `GET /api/models` returns the registry, and `GET /api/local-ai/status` reports each model's live state. The 0.5B and 1.5B Q4_K_M servers can run at the same time; the launcher starts each only when its model file exists and enough free memory remains for its configured threshold. Set `LOCAL_AI_CONTEXT` or `LOCAL_AI_THREADS` to change the defaults (`1024` context tokens and `2` threads), and use `LOCAL_AI_0_5B_PORT` / `LOCAL_AI_1_5B_PORT` if the defaults conflict.

Colab 3B calls the installed `colab` CLI (Linux or macOS, authenticated) using a reusable session (`COLAB_AI_SESSION`, default `workspace-qwen`). On the first request it checks `colab status`, creates a GPU session with `colab new --gpu T4` when needed, and bootstraps `scripts/colab_model_server.py` once inside the runtime; later requests reuse that session through `colab exec`. Kaggle 3B calls the existing batch runner `scripts/kaggle_run.py` through the `kaggle` CLI, so every request is a finite private notebook submission, not a low-latency endpoint. Its default timeout is one hour (`KAGGLE_AI_TIMEOUT_MS`), and polls default to 30 seconds (`KAGGLE_AI_POLL_INTERVAL_SECONDS`). Both CLIs use their own configured credentials; the API never reads or writes those tokens.

Setting `COLAB_AI_URL` or `KAGGLE_AI_URL` to an OpenAI-compatible endpoint (for example a user-managed tunnel) skips the CLI backend and uses HTTP instead. Optional `COLAB_AI_API_KEY` and `KAGGLE_AI_API_KEY` bearer tokens are supported. Because CLI-backed remote models can spend quota, they are excluded from automatic selection by default; set `COLAB_AI_AUTO_SELECT=true` or `KAGGLE_AI_AUTO_SELECT=true` to include them, or pass `model` explicitly. A URL-configured remote model is auto-selected unless its `*_AI_AUTO_SELECT` is false. Securing any tunnel and endpoint is your responsibility.

The [Colab notebook](./notebooks/colab-qwen-coder-free-tier.ipynb) runs Qwen2.5-Coder 3B for interactive inference inside the notebook. Use **Select Kernel → Colab → Auto Connect**, mount Drive to reuse the model snapshot (`MyDrive/colab-models`, about 6 GB), and run inference only when needed. To reduce GPU startup time, prepare the model snapshot and dependencies on CPU first, then switch to GPU for model loading and inference. The notebook caches Hugging Face files and pip downloads on Drive, but installs packages into each fresh runtime and reuses Colab's PyTorch; it deliberately does not persist an installed virtualenv because compiled packages may not be compatible across runtimes. Model loading uses PyTorch SDPA when supported. Free-tier GPU quotas and availability are dynamic and not published as fixed hour or cooldown schedules. The free-tier notebook does not expose a network endpoint or connect to the workspace task board; this avoids relying on a public tunnel/web service on a free managed runtime. The separate CLI backend above uses its own headless Colab session and a loopback-only server inside that runtime; this interactive notebook is unchanged. For use inside the workspace UI, use one of the local models, the CLI backend, or a compute environment whose terms permit an externally reachable inference service. The final notebook cell releases model memory and asks Colab to unassign the runtime; if unassignment fails, disconnect/delete the runtime manually. Drive model files remain persistent.

An observed T4 run of Qwen2.5-Coder-3B-Instruct in 4-bit mode generated the same 72-token response in 10.85 s (6.64 tokens/s) without a warm-up and 4.35 s (16.56 tokens/s) after a one-token CUDA warm-up. Both runs reported 2,028 MiB peak allocated and 3,014 MiB peak reserved VRAM on a 14.6 GiB T4. These are individual measurements from this prompt and runtime, not a performance guarantee or a multi-run average.

For an optional Kaggle fallback, use the [Kaggle notebook](./notebooks/kaggle-qwen-coder.ipynb). To avoid local multi-gigabyte downloads or the web UI's remote-URL importer, first run the [CPU-only dataset preparation notebook](./notebooks/kaggle-prepare-qwen-dataset.ipynb) with Internet enabled and save its output as a private Kaggle Dataset. The inference notebook uses KaggleHub to fetch that dataset by handle; inside Kaggle, the resource is integrated with the notebook's input/cache. The CLI metadata also declares this dataset for batch submissions. Select one GPU; the inference notebook pins this 4-bit model to GPU 0 rather than requesting multi-GPU placement. Kaggle accelerator availability, quotas, session limits, and storage policies can change, so the notebook makes no fixed weekly-hours claim. Stop the interactive inference session from Kaggle's UI when finished; clearing Python objects alone does not stop GPU usage.

For an explicit one-shot batch run using the Kaggle CLI, install and configure the CLI using Kaggle's official instructions, then provide a task JSON with non-empty string fields `title`, `project`, `task_type`, `description`, and `acceptance_criteria`:

```sh
python scripts/kaggle_run.py --task-json /path/to/task.json
```

The runner makes a temporary notebook copy with that task, pushes the private GPU kernel, polls until completion (up to one hour by default), downloads `response.json`, validates it, and saves it to `kaggle-output/response.json`. The task is embedded in the pushed private notebook version and sent to Kaggle; do not submit confidential prompts or data. Use `--output`, `--timeout`, and `--poll-interval` to override defaults. This is a finite notebook submission, not a live inference API; every run consumes Kaggle resources and may incur model-load/setup time. Run one submission at a time and check Kaggle's current rules and quotas before use. The runner never reads or writes your Kaggle API token; the Kaggle CLI uses its own configured credentials.

The API starts generation only when all monitored resources are within their limits: the system's 1-minute load average is below an adaptive CPU threshold, available memory is at least the selected model's threshold (`1024` MiB for 0.5B, `1792` MiB for 1.5B by default; remote models need no local model memory), and physical-disk busy time is at most `30%`. The CPU threshold starts at the configured maximum (`1.0` by default), drops by `0.1` after 10 seconds of sustained overload, and recovers by `0.05` after 30 seconds below the threshold with `0.15` load-average hysteresis. It stays between `LOCAL_AI_MIN_LOAD` (`0.5`) and `LOCAL_AI_MAX_LOAD` (`1.0`). Adaptation is observed at most once every five seconds. While any limit is exceeded, the board reports the specific resource and retries every five seconds. Memory and disk limits are configurable with `LOCAL_AI_MIN_AVAILABLE_MEMORY_MB`, `LOCAL_AI_1_5B_MIN_AVAILABLE_MEMORY_MB`, and `LOCAL_AI_MAX_DISK_BUSY_PERCENT`; endpoints are configurable with `LOCAL_AI_URL` (0.5B), `LOCAL_AI_1_5B_URL` (1.5B), `COLAB_AI_URL`, and `KAGGLE_AI_URL`. Memory is read from Linux `MemAvailable`, and physical-disk busy time is averaged over a minimum five-second `/proc/diskstats` sampling window; intermediate checks reuse the latest disk measurement while still refreshing CPU and memory. If resource monitoring is unavailable, generation is refused rather than started without a safety check.

Each request is handled by the highest-priority live model that is healthy and within its resource limits (1.5B before 0.5B by default), falling back to other models when one is unavailable or memory-constrained. Automatic selection considers the local models plus remote models that are explicitly enabled for it; CLI-backed Colab and Kaggle models are only chosen when requested by id, while URL-configured remote models join the pool after the local models by default. Because remote models do not use this machine's CPU, memory, or disk, only the shared cooldown and per-model in-flight limit apply to them. Pass `model` in the refine request (for example `local-0.5b`, `colab-3b`, or `kaggle-3b`) to target a specific callable model. Each model processes one request at a time, so the two local servers plus any configured remote endpoints can run concurrently, but generation starts only after the shared 15-second post-turn cooldown (`LOCAL_AI_TURN_COOLDOWN_MS`). Local and HTTP requests use a 120-second per-turn timeout (`LOCAL_AI_TIMEOUT_MS` for local models); Colab and Kaggle have longer defaults (`COLAB_AI_TIMEOUT_MS` and `KAGGLE_AI_TIMEOUT_MS`) because they include CLI startup and batch polling. The prompt router sends short task requests through a compact prompt with a 180-token output cap, and detailed requests through a constraint-preserving prompt with a 300-token cap. Inputs are split into labeled task fields and bounded to 2,200 characters so long notes cannot consume the model context; they are trimmed, not sent as multiple model calls. The router selects prompt style and output budget only. If resources become busy after generation starts, the current request is allowed to finish; later generations wait until resources are within limits. Local endpoints are loopback-only by default and are not exposed through the browser.

## Python satellite

- `GET /health` — satellite and database health
- `GET /summary` — total, open, and completed task counts from SQLite

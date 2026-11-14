# Multi-project workspace

[![CI](https://github.com/suniltnngl-gm/multi-project-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/suniltnngl-gm/multi-project-workspace/actions/workflows/ci.yml)

A local-first Node/Vite/Python monorepo that unifies Git-tracked task, file, and worktree state in a relocatable SQLite database with a resource- and quota-gated multi-agent AI control plane.

## Services & Architecture

| Service | Directory | Default Address | Role |
| --- | --- | --- | --- |
| **Web Board** | `apps/web` | `http://127.0.0.1:5173` | Vite frontend; proxies `/api` and `/satellite` |
| **Node API & Control Plane** | `apps/api` | `http://127.0.0.1:3001` | Express API, SQLite stores, resource scheduler, `agentBus`, and `swarmRunner` |
| **Python Satellite** | `apps/python` | `http://127.0.0.1:3002` | `uv`-managed analytics satellite reading the same SQLite database |
| **SQLite Store** | `apps/api/data/workspace.sqlite` | Local file | Shared relocatable state for tasks, files, folders, worktrees, quotas, and agent runs |

All services bind to `127.0.0.1` by default.

---

## Quick Start

**Prerequisites:** Node.js 22+ (`.nvmrc`), [uv](https://docs.astral.sh/uv/), and Git. Linux (including WSL) is the primary target; macOS and native Windows are best-effort (`./workspace` on POSIX, `.\workspace.cmd` on Windows).

```sh
git clone https://github.com/suniltnngl-gm/multi-project-workspace.git
cd multi-project-workspace
./workspace install
cp .env.example .env   # configure optional model/backend settings
./workspace dev
```

<details>
<summary>Portability notes & environment configuration</summary>

- **Single launcher:** `./workspace` and `.\workspace.cmd` wrap `scripts/workspace-cli.mjs` in Node with no external `bash`/`curl`/`lsof` dependencies.
- **Relocatable SQLite:** Relative `DATABASE_PATH` values anchor to the workspace root, and moving a workspace-local checkout automatically adopts the primary repository row (`id = 1`), worktrees, `tasks.worktree_path`, and environment `cwd` paths.
- **Parameterized backends:** Local model directories, Kaggle kernel/dataset slugs (`KAGGLE_AI_KERNEL_ID`, `KAGGLE_AI_DATASET_HANDLE`), server ports, and `WORKSPACE_TMP_DIR` are all overridable via `.env` without editing tracked files.
- **Portable scratch & dependencies:** `.npmrc` keeps `npm install` toolchain-free; Python versions and packages are locked via `apps/python/.python-version` and `uv.lock`; temporary scratch files respect `WORKSPACE_TMP_DIR`.
- Keep `.env`, SQLite files, and downloaded GGUF models out of Git.

</details>

---

## Common CLI Commands

| Category | Command | Purpose |
| --- | --- | --- |
| **Lifecycle** | `./workspace install \| dev \| status \| stop` | Install deps & `post-commit` hook, run services, inspect status |
| **Single service** | `./workspace web \| node \| python` | Run one service individually |
| **Quality & CI** | `./workspace lint \| test \| build \| check` | Run ESLint, Vitest, Node API tests, Python `unittest`, or Vite build |
| **Self-check** | `./workspace self-check \| maintain` | Scan tracking domains, run lint/test/build/checks, and run `ai doctor --strict` |
| **Tracking** | `./workspace <domain> scan\|list\|check` | Inspect `files`, `folders`, `git-context`, `tools`, `environment`, `repos`, `mcp` |
| **Tasks** | `./workspace task worktree [create\|remove] <id>` | Isolate task branches in sibling Git worktrees |
| **Sensors** | `./workspace sensors scan\|cycle\|list\|promote <id>` | Deterministic gap detection and atomic improvement cycles (`0` tokens) |
| **Multi-Agent Swarm** | `./workspace ai swarm [plan\|run\|board\|step\|list]` | Plan and run low-quota `2+2+2` agent swarms |
| **AI Backends** | `./workspace local-ai \| ai doctor \| ai ask \| ai improve` | Manage local models, run diagnostics, ask chat prompts, or review proposals |

---

## Core Capabilities

- **Structured Task & Workspace Tracking**: Tasks track planning registers (`objectives`, `requirements`, `decisions`, `relevant_files`, `important_context`), work state, activity trails, AI job provenance, and sibling Git worktrees alongside file headers, folders, tools, and environments.
- **Parallel Swarm & Self-Improvement Strategy**: Star-topology `agentBus` (`parent` + up to `6` workers + parent-side `reviewer`) with zero-token routing, `2+2+2` cross-pool diversity, 1-hop context hydration, pre-run register backfill, and a default-on **parallel self-improvement lane** that audits portability/sensor gaps and run telemetry alongside worker slices.
- **Resource & Quota Safety**: Live adaptive CPU, RAM, disk, GPU, and swap gating for local models plus persistent SQLite quota ledgers, 3-pool Antigravity (`agy@gemini`, `agy@claude-gpt`, `agy@gemini-4-argon`) weekly quota pacing, pre-dispatch reservations, `observe429` learned cooldowns, and `402` billing circuit breakers.
- **Deterministic Sensors**: Snapshot-based detectors catch workspace gaps without calling models or spending quota.

---

## Documentation Index

| Document | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Multi-agent architecture, swarm CLI/API, parent/sibling hooks, context hydration, register backfill, quota/resource rules, and contributor conventions |
| [docs/agent-protocol.md](docs/agent-protocol.md) | Star-topology message matrix, leases, checkpoints, task-ops, script resolver, artifacts, and provider dispatch rules |
| [docs/api-and-tracking.md](docs/api-and-tracking.md) | Complete HTTP API reference (Tasks, Worktrees, Tracking domains, Verify, AI routes, Python satellite) |
| [docs/ai-backends-and-quotas.md](docs/ai-backends-and-quotas.md) | Local `llama-server` resource gates, OpenCode/AGY CLIs, serverless slots, Colab/Kaggle notebooks, `AI_QUOTA_PROFILES`, and `ai doctor` |
| [docs/sensors.md](docs/sensors.md) | Deterministic gap detectors, improvement cycles, findings lifecycle, and thresholds |

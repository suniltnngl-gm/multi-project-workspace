# AI Backends, Quotas & Remote Boundaries

The workspace manages local GGUF models (`llama-server`), headless CLI providers (`opencode`, `agy`), cloud notebooks (Colab 3B, Kaggle 3B), and generic OpenAI-compatible serverless slots behind one registry, resource monitor, and persistent quota ledger.

---

## Model Registry & Starting Local Models

```sh
./workspace local-ai        # start installed 0.5B and 1.5B models within memory limits
./workspace local-ai 0.5b   # start only Qwen2.5-Coder 0.5B (default :8080)
./workspace local-ai 1.5b   # start only Qwen2.5-Coder 1.5B (default :8081)
```

Defaults & overrides:
- Models load from `LOCAL_AI_MODEL_DIR` (`~/.local/share/llama.cpp/models` by default) via `llama-server` on `PATH` (or `LLAMA_SERVER`).
- Default context/threads: `LOCAL_AI_CONTEXT=1024`, `LOCAL_AI_THREADS=2`.
- Default endpoints/ports: `LOCAL_AI_URL` / `LOCAL_AI_0_5B_PORT`, `LOCAL_AI_1_5B_URL` / `LOCAL_AI_1_5B_PORT`.
- Endpoints bind to loopback (`127.0.0.1`) by default.

---

## Local Hardware Resource Gates & Scheduling

Local generation starts only when all monitored host resources are within limits:

1. **Adaptive CPU load threshold**: Starts at `LOCAL_AI_MAX_LOAD` (`1.0`), steps down by `0.1` after 10s of sustained overload, recovers by `0.05` after 30s below threshold (`0.15` hysteresis), clamped to `[LOCAL_AI_MIN_LOAD=0.5, LOCAL_AI_MAX_LOAD=1.0]`.
2. **Available RAM**: `LOCAL_AI_MIN_AVAILABLE_MEMORY_MB` (`1024` MiB for `local-0.5b`, `1792` MiB for `local-1.5b` via `LOCAL_AI_1_5B_MIN_AVAILABLE_MEMORY_MB`), read from Linux `MemAvailable` or OS free memory on macOS/Windows.
3. **Physical disk activity**: At most `LOCAL_AI_MAX_DISK_BUSY_PERCENT` (`30%`) averaged over a minimum 5s `/proc/diskstats` window on Linux.
4. **Post-turn cooldown & timeout**: Shared `LOCAL_AI_TURN_COOLDOWN_MS` (`15000` ms) and `LOCAL_AI_TIMEOUT_MS` (`120000` ms). Generation is refused rather than started unguarded if resource monitoring fails.

Among ready candidates, automatic selection prefers healthy models with fewer failures, lower billing rank, higher headroom, and explicit priority.

---

## CLI & Serverless Backends

### OpenCode & Antigravity Headless CLIs

- **`opencode` / `agy`**: Set `OPENCODE_AI_MODEL` (e.g. `opencode/beam-free` or `console-openrouter/openrouter/free`) and `OPENCODE_AI_AUTO_SELECT=false` to avoid unintended spend. Prompt cache keys isolate `(effectiveCliModel, agent)` across swaps.
- **Antigravity (`agy`) 3 Weekly Quota Pools**: Antigravity splits weekly capacity across three shared weekly pools (`agyQuotaPoolForScope`):
  1. **`agy@gemini`** — Gemini 3.x / 2.5 Flash & Pro / Hydrogen models (`AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK`, `AGY_AI_GEMINI_MAX_TOKENS_PER_WEEK`).
  2. **`agy@claude-gpt`** — Claude Sonnet/Opus and GPT/O-series models (`AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK`, `AGY_AI_CLAUDE_GPT_MAX_TOKENS_PER_WEEK`).
  3. **`agy@gemini-4-argon`** — Gemini 4 Argon reasoning models (`AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK`, `AGY_AI_ARGON_MAX_TOKENS_PER_WEEK`).
  Models inside the same pool share one persisted weekly bucket and `429` cooldown, while parallel swarm workers can run across all 3 AGY pools (`agy:gemini`, `agy:claude-gpt`, `agy:gemini-4-argon`) concurrently without domain collisions (`AGY_AI_MODELS` / `--agy-models`).
- **Model rotation (`scripts/rotate-model.mjs`)**: Supports `--backend opencode` (rotates across the 4+1 OpenCode providers) and `--backend agy` (rotates across the 3 AGY weekly pools in round-robin order, or pin one via `--pool gemini|claude-gpt|gemini-4-argon`).
- **Discovery cache**: `GET /api/models/opencode` (`?refresh=1`) runs `opencode models` with a TTL cache (`OPENCODE_AI_DISCOVERY_TIMEOUT_MS=15000`, `OPENCODE_AI_DISCOVERY_TTL_MS=600000`) and persists the last healthy roster to `apps/api/data/opencode-roster-cache.json` (override with `OPENCODE_AI_ROSTER_CACHE_FILE`) for offline resilience.

### Serverless Slots (`SERVERLESS_AI_SLOTS` / `SERVERLESS_AI_URL`)

- Configure one slot via `SERVERLESS_AI_URL`, `SERVERLESS_AI_MODEL`, `SERVERLESS_AI_API_KEY`, `SERVERLESS_AI_TIMEOUT_MS`, `SERVERLESS_AI_MAX_REQUESTS_PER_DAY`, `SERVERLESS_AI_AUTO_SELECT`, `SERVERLESS_AI_SUPPORTS_JSON_MODE`, `SERVERLESS_AI_CHAT_PATH` (`/v1/chat/completions`), and `SERVERLESS_AI_HEALTH_PATH` (`/v1/models`).
- Configure multiple independent slots via `SERVERLESS_AI_SLOTS` (JSON array with `id`, `url`, `apiModel`, `apiKeyEnv`, `limits`, `billing`, `priority`, `autoSelect`, `supportsJsonMode`, etc.). HTTP `429` responses preserve upstream `Retry-After` delays.

---

## Quota Profiles, Weekly Pacing & Fallback

- **Daily & Weekly caps**: Set `COLAB_AI_MAX_REQUESTS_PER_DAY`, `KAGGLE_AI_MAX_REQUESTS_PER_DAY`, `OPENCODE_AI_MAX_REQUESTS_PER_DAY`, `AGY_AI_MAX_REQUESTS_PER_WEEK`, and per-pool weekly limits `AGY_AI_GEMINI_MAX_REQUESTS_PER_WEEK`, `AGY_AI_CLAUDE_GPT_MAX_REQUESTS_PER_WEEK`, `AGY_AI_ARGON_MAX_REQUESTS_PER_WEEK` (persisted in SQLite `ai_quota`).
- **Cross-Window Weekly Pacing & Tiering**:
  - `modelBudget` tracks elapsed week fraction vs. consumed weekly fraction (`targetAllowance = min(1, max(0.05, elapsedFraction) + 0.15)`), surfacing `pacedHeadroom` and `pacing.aheadOfPace` so weekly pools that burn ahead of schedule automatically yield to renewable daily/hourly pools rather than exhausting early in the week.
  - `providerQuota` classifies routine renewable/daily/flash pools (`local`, `opencode`, `colab`, `kaggle`, `agy@gemini`) as Tier 0 workhorses and high-reasoning scarce weekly pools (`agy@claude-gpt`, `agy@gemini-4-argon`) as Tier 1 — assigning routine swarm worker slices to Tier 0 first while prioritizing Tier 1 for parent-side `reviewer` verification (or complex slices when explicitly requested via `--agy-models` / `--models`).
- **Rich profiles (`AI_QUOTA_PROFILES`)**: JSON object keyed by model id mapping to limiter arrays (`unit`: `requests | tokens | compute_seconds`, `limit`, `window`: `second | minute | hour | session | day | week | month | none`, `reset`: `rolling | fixed | pool`, optional `timezone`, `windowMs` / `hours`).
- **Billing categories**: `free`, `payg`, `subscription` (`AI_BILLING_CATEGORIES` or per-backend `*_AI_BILLING`). Ordering metadata only — never bypasses quotas. HTTP `402` trips a `billing-cooldown` circuit breaker (6h default).
- **Observation & Reservations**: Pre-dispatch `modelBudget.reserve` prevents concurrent over-spend; `observe429` records `observed-requests`, `observed-429`, and `observed-cooldown` rows across restarts; silent zero-usage responses incur conservative token estimates.
- **Fallback chain (`AI_FALLBACK_CHAIN`)**: `>`-separated fallback order (e.g. `opencode>agy>colab-3b>local-1.5b>local-0.5b`) triggered only on `429`, `503`, `504`, or `gpu_unavailable` (set `AI_FALLBACK_ALLOW_SESSIONS=true` to allow failover on session-bound calls).

---

## Colab & Kaggle Backends

### Colab 3B

- Uses reusable session `COLAB_AI_SESSION` (`workspace-qwen`), checking `colab status` before bootstrapping `scripts/colab_model_server.py`.
- `COLAB_AI_REQUIRE_GPU=true` fails fast (`503`, `code: "gpu_unavailable"`) on CPU runtimes; `COLAB_AI_GPUS` (default `T4`) controls capacity fallback order.
- Set `COLAB_AI_AUDIT_DIR` (`0600` JSON audit files) to log CLI requests/responses. Release idle GPU sessions afterward:

```sh
./workspace colab status
./workspace colab stop [session]
```

- An interactive notebook lives at [../notebooks/colab-qwen-coder-free-tier.ipynb](../notebooks/colab-qwen-coder-free-tier.ipynb) with optional Drive checkpointing ([../scripts/colab_checkpoint.py](../scripts/colab_checkpoint.py)) and Kaggle dataset publishing ([../scripts/colab_publish_kaggle.py](../scripts/colab_publish_kaggle.py)).

### Kaggle 3B Batch Runner

- Explicit finite private kernel submission via [../scripts/kaggle_run.py](../scripts/kaggle_run.py) (`KAGGLE_AI_TIMEOUT_MS`, `KAGGLE_AI_POLL_INTERVAL_SECONDS=30`, manifests in `KAGGLE_AI_MANIFEST_DIR`).
- Override `KAGGLE_AI_KERNEL_ID` (`--kernel-id`) and `KAGGLE_AI_DATASET_HANDLE` (`--dataset-handle`) via `.env` or CLI flags so any account can submit its own Kaggle kernel and private model dataset without modifying tracked files.
- Notebook templates live at [../notebooks/kaggle-qwen-coder.ipynb](../notebooks/kaggle-qwen-coder.ipynb) and [../notebooks/kaggle-prepare-qwen-dataset.ipynb](../notebooks/kaggle-prepare-qwen-dataset.ipynb).
- Cleanup is best-effort (`KAGGLE_AI_CANCEL_FALLBACK=delete` deletes the private kernel if queued cancellation is unsupported).

### Remote Execution Boundaries

- **Interactive Colab is human-driven.** Do not add unattended polling daemons or Drive/Kaggle Dataset request-response mailboxes.
- **Automated remote work is finite Kaggle batch** or an explicitly compliant endpoint (`COLAB_AI_URL` / paid plan / Enterprise / self-managed host).

---

## Diagnostics (`./workspace ai doctor`)

Run `./workspace ai doctor` before debugging AI issues:
- `--strict`: exit non-zero when errors are found.
- `--json`: machine-readable output.
- `--offline` / `--no-probe`: skip endpoint and CLI probes while validating Node, SQLite writability, quota profiles, serverless slots, and safety flags.

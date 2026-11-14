# Operational Invariants & Swarm Playbooks

## 1. Mandatory Task-Board Gate
- Before starting any implementation, audit, or commit, create and mark a task `in_progress` on the workspace board (`POST /api/tasks` or `createDatabase().createTask(...)` in `apps/api/src/database.js`).
- On completion, attach the commit SHA and verification summary and mark the task `done`.

## 2. Resource-Gated Local Lanes (`llama.cpp`)
- `local-0.5b` and `local-1.5b` are `resourceGated: true` on-demand `llama-server` (`llama.cpp`) endpoints—**not** background Ollama daemons.
- Never treat their idle offline state (`[info] ... resource-gated (on-demand, not running)` in `./workspace ai doctor`) as a broken setup or install Ollama.
- Use `./workspace local-ai [all|0.5b|1.5b]` only when explicitly starting local inference within host memory/CPU/disk gates.

## 3. Quota & TPM Guardrails
- Keep `AGY Gemini 4 Argon` (`agy@gemini-4-argon`) in `[CONSERVE]` mode; harvest renewable 5-hour `AGY` windows first.
- Respect the `8,500`-token `opencode-cli` overhead buffer (`opencodeOverheadTokens`) against `<= 8,000`-TPM Groq Free-tier models.
- Preview multi-slice swarm runs with `--dry-run` before live execution.

## 4. Swarm Execution & Verification
- Use `--isolate-worktrees --merge-worktrees --reviewer-model <non-local>` (e.g. `agy@claude-sonnet-5-5-medium`) for parallel code-modifying slices.
- Run `CI=true ./workspace self-check` (ESLint `no-undef` across `apps/web`, `apps/api/src`, and `scripts`, plus Vitest, Node API tests, Python tests, Vite build, file tracking, and offline `ai doctor`) and confirm exit `0` before pushing to `origin/master`.

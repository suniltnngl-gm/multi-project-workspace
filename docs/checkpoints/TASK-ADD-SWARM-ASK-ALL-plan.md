# TASK-ADD-SWARM-ASK-ALL (`MPW` Task `#177`) — Implementation Plan

- **Task:** `task-add-swarm-ask-all` (queue) / MPW Task `#177` — Zero-LLM cross-session fan-out query CLI
- **Plan Version:** `swarm-plan-v1` (draft, not yet reviewed)
- **Date:** `2026-11-23`
- **Pre-State Anchors:**
  - `MPW` branch `master`, `HEAD` = `1906c26bbdff73b667d394c6927b316d9f991dca`
  - Pre-existing dirty (treat as read-only, do not touch): `apps/api/src/toolchain/dispatch/cli-commands.js`, `scripts/swarm-overnight.mjs`, `scripts/swarm-queue-run.mjs`
- **Scope:** `multi-project-workspace` only. No `curl-ai-bridge`, no DB/SQLite mutation, no network in default mode.
- **Budget:** `$0.00` default (`--mode grep`). `--mode llm` is explicitly opt-in, capped, and quota-gated.

## 1. Problem

`swarm ask --session <id> "<question>"` already supports cheap zero-LLM grep over **one** session (handoff card + AGY transcript). Operators rarely know the session ID that contains a decision, so cross-session recall currently means:

1. `swarm wakeup` (canonical state only), then
2. guessing session IDs from `swarm status` / `retired-sessions.json` / `~/.gemini/antigravity-cli/brain`, then
3. running `swarm ask` N times.

`swarm ask-all` collapses that into one bounded command: **discover all known sessions, grep them all, aggregate hits with per-session attribution, and never fan out LLM calls silently.**

## 2. CLI Contract

```
swarm ask-all "<question>" [options]

  --mode <grep|llm>            Query mode (default: grep, $0 zero-LLM)
  --source <list>              Comma list: registry,handoff,agy (default: all three)
  --max-sessions <n>           Max sessions scanned (default: 40)
  --max-matches <n>            Max matches per session (default: 3)
  --max-total <n>              Max aggregated matches printed/returned (default: 40)
  --max-transcript-bytes <n>   Skip transcripts larger than n bytes (default: 4194304)
  --session <id>               Restrict to explicit IDs (repeatable / comma list)
  --exclude <id>               Exclude session IDs (repeatable / comma list)
  --since <iso|duration>       Only sessions updated within window (e.g. 7d, 24h)
  --handoff-dir <dir>          Override handoff directory
  --timeout <sec>              Scan/fan-out wall-clock budget (default: 20)
  --deep                       Include oversize transcripts (overrides byte guard)
  --cli <agy>                  LLM backend for --mode llm
  --pool <pool>                Quota pool for --mode llm (default: agy-gemini)
  --max-llm-sessions <n>       Hard cap for LLM fan-out (default: 1, max: 3)
  --dry-run                    Resolve discovery + LLM plan without scanning/calling
  --json                       Machine-readable output
  -h, --help
```

Exit codes: `0` success (including zero matches), `1` usage/IO error, `2` quota blocked (`--mode llm`).

### Defaults that matter

- **grep is the default and is always $0.** No `spawnSync` unless `--mode llm`.
- **LLM fan-out defaults to 1 call.** `--max-llm-sessions` is clamped to `3`; the CLI refuses `--mode llm --max-llm-sessions >3`.
- **Oversize skip, not OOM.** The 14MB retired `e4748928…` transcript is skipped by default (its ≤30-line handoff card is still searched). `--deep` opts in.
- **`--since` parsing** accepts `7d`, `24h`, `90m`, or ISO-8601 and filters on `updatedAt`/mtime.

## 3. Session Discovery (new library API)

Add to `apps/api/src/toolchain/dispatch/session-handoff.js` (keeps the existing grep/ask/retire primitives intact):

```js
export function listKnownSessions({
  stateRoot, handoffDir, homeDir,
  sources = ['registry', 'handoff', 'agy'],
  sinceMs = null,
  sessionIds = null, excludeIds = [],
  maxTranscriptBytes = 4 * 1024 * 1024,
  nowMs = Date.now()
} = {})
// -> { sessions: SessionInfo[], skipped: [{sessionId, reason, bytes?}] }

// SessionInfo = {
//   sessionId, cli, quotaPool, role, status, updatedAt, updatedAtMs,
//   sources: ['registry'|'handoff'|'agy'],
//   transcriptPath, transcriptBytes, handoffFile, retired, retiredReason
// }
```

Sources:

1. **registry** — `$SWARM_STATE_ROOT/sessions/swarm-sessions.json` (`sessions[]`, fields `sessionId`, `cli`, `quotaPool`, `role`, `status`, `updatedAt`).
2. **handoff** — `handoffs/*.md` (session ID = filename) plus `handoffs/retired-sessions.json` metadata.
3. **agy** — `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, mtime from the transcript.

Rules:

- Deduplicate by `sessionId`; merge source tags; registry metadata wins over filename inference.
- Sort `updatedAtMs` descending (newest first) before applying `--max-sessions`.
- Missing/unreadable sources are fail-soft (`skipped` entries), never fatal.
- No secret values are read or printed; all snippets pass through `redactSecrets()`.

Add an optional `maxBytes` guard to `grepSessionTranscript` (backward compatible; default `Infinity`):

```js
grepSessionTranscript({ ..., maxBytes = Infinity })
// -> adds { skipped: true, reason: 'transcript_oversize', bytes } instead of reading the file
```

Add the fan-out aggregate:

```js
export function askAllSessions({
  query, handoffDir, stateRoot, homeDir, sources,
  maxSessions = 40, maxMatchesPerSession = 3, maxTotal = 40,
  maxTranscriptBytes = 4 * 1024 * 1024,
  sessionIds = null, excludeIds = [], sinceMs = null,
  maxScanMs = 20000, now = () => Date.now()
} = {})
// -> { ok, mode: 'grep', query, terms, scanned, totalMatches, truncated,
//      sessions: [{ sessionId, cli, quotaPool, updatedAt, matchCount, matches }],
//      skipped: [...] }
```

Fan-out loop is deterministic and pure (inject `now`/`maxScanMs`), stops early when `maxTotal` is reached or the wall-clock budget expires, and marks `truncated: true`.

## 4. Files (exact allowlist)

| Action | Path |
| --- | --- |
| ADD | `scripts/swarm-ask-all.mjs` |
| MODIFY | `apps/api/src/toolchain/dispatch/session-handoff.js` (add `listKnownSessions`, `askAllSessions`, `maxBytes` guard) |
| MODIFY | `entry/swarm` (usage line + `ask-all)` dispatch to `scripts/swarm-ask-all.mjs`) |
| MODIFY (optional, 1 line) | `scripts/swarm-ask.mjs` — correct `recordPoolCall(stateDir, { quotaPool: pool, ... })` so existing `--mode llm` calls hit the 5h ledger |
| ADD | `apps/api/test/swarm-ask-all.test.js` |
| ADD/MODIFY | `docs/checkpoints/TASK-ADD-SWARM-ASK-ALL-plan.md` (this file) |

Explicitly **out of scope**: the 3 pre-existing dirty files, `apps/api/data/workspace.sqlite`, `capability-manifest.js` / `CLI_COMMAND_SPECS` (provider CLIs, not swarm subcommands), queue runner behavior.

Optional follow-up (not in this allowlist): add one README row for `swarm ask-all`, and a `swarm-ask` parser fix (`--pool <v>` / `--state-dir <v>` are missing from `valueFlags`, so the value leaks into the question string).

## 5. `scripts/swarm-ask-all.mjs` Behavior

1. Parse flags with the same `flag()/has()` helper style as `swarm-ask.mjs`; reject unknown `--mode`.
2. **grep mode (default):** call `askAllSessions()`; print a header
   `swarm ask-all [grep]: query=… scanned=… withMatches=… matches=… skipped=…`
   then, per session, `session=<id> cli=<cli> pool=<pool> updated=<iso> matches=<n>` and indented snippets `[handoff|transcript:line] …`.
3. **llm mode:** discovery + grep first (free), rank sessions by match count then recency, take at most `--max-llm-sessions`, and for **each** candidate:
   - `checkPoolFiveHourAdmission(stateDir, pool)` → stop and report `blocked` when exhausted;
   - `buildReadOnlyAskCommand()` (READ-ONLY wrapper, >60KB warning);
   - `recordPoolCall(stateDir, { quotaPool: pool, taskId: 'swarm-ask-all', status: 'ok' })` immediately before `spawnSync` (note the real signature — see §6 pre-existing bug);
   - bounded timeout = `--timeout`; accumulate stdout/stderr per session.
4. `--dry-run` prints the resolved session list, planned LLM calls, quota state, and commands without scanning or executing.
5. `--json` emits the aggregate object (plus `llm` results array in llm mode).
6. Never throw on a single bad transcript; collect `skipped`.

## 6. Safety & Quota Invariants

- Default path is **zero-LLM, zero-network, read-only**.
- LLM fan-out is capped at 3 calls, default 1, **and** gated by the existing 5h ledger (`checkPoolFiveHourAdmission` / `recordPoolCall`), matching the `swarm ask` hardening in `1906c26`.
- Oversize transcripts are skipped with an explicit reason; `--deep` is the only way to include them.
- All output is redacted via `redactSecrets()`; no session content is written to disk.
- Kill-switch is irrelevant for grep, but **llm mode must respect `STOP_SWARM`**: refuse with exit `2` when `overnight/STOP_SWARM` exists.
- No mutations to queue, registry, SQLite, or handoff cards.

**Pre-existing bug found during planning (fix in the same PR only if the reviewer allows one-line scope):** `scripts/swarm-ask.mjs:107` calls `recordPoolCall(stateDir, pool, {...})`, but the real signature is `recordPoolCall(stateDir, { quotaPool, taskId, status, nowMs })`. Today `swarm ask --mode llm` therefore logs `quotaPool: 'unknown'`, so its calls are invisible to the pool's 5h ledger. `ask-all` must use the correct object form; the one-line `swarm-ask.mjs` correction prevents the same under-counting.

## 7. Test Matrix (`apps/api/test/swarm-ask-all.test.js`)

1. **Discovery merge/dedupe** — registry + handoff + fake AGY brain dir for the same ID → one session, multiple sources, registry metadata preserved.
2. **Sort + cap** — 3 sessions with descending mtimes and `maxSessions: 2` scans the 2 newest.
3. **Oversize skip** — transcript above `maxTranscriptBytes` returns `skipped: 'transcript_oversize'`; `--deep`-equivalent (`maxTranscriptBytes: Infinity`) finds the hit.
4. **Aggregation** — hits from handoff and transcript across 2 sessions; `maxTotal` truncates and sets `truncated: true`.
5. **Redaction** — a `sk-…`/`Bearer …` snippet is emitted as `[REDACTED]`.
6. **Since/exclude filters** — excluded ID never scanned; stale session filtered by `sinceMs`.
7. **LLM cap** — a fake `spawnSync`/`recordPoolCall` seam (or CLI dry-run) asserts `max-llm-sessions` defaults to 1 and is clamped at 3.
8. **CLI usage** — missing question exits `1`; `--help` exits `0`.

## 8. Verification (must pass before build is accepted)

```bash
node --check scripts/swarm-ask-all.mjs
node --test apps/api/test/swarm-ask-all.test.js apps/api/test/session-handoff.test.js
npx eslint apps/api/src scripts
git diff --check
swarm ask-all --help
swarm ask-all "60KB" --json | head -40          # real local smoke, $0
swarm ask-all "60KB" --mode llm --dry-run --json # proves cap + quota, no call
CI=true ./workspace self-check                   # exit 0
```

Acceptance: all tests green, `swarm ask-all` works with no `--session`, LLM mode is impossible to run unbounded, and no pre-existing dirty file is modified.

## 9. Build Sequence

1. Add `maxBytes` guard + `listKnownSessions` + `askAllSessions` to `session-handoff.js`.
2. Add `apps/api/test/swarm-ask-all.test.js`; run targeted tests.
3. Add `scripts/swarm-ask-all.mjs`; run `--help`, `--dry-run`, real grep smoke.
4. Wire `entry/swarm` (`ask-all)` + usage line).
5. Run full verification (`self-check`).
6. Review gate → attach SHA + verification notes to MPW Task `#177`; mirror to queue task `task-add-swarm-ask-all` plan job.

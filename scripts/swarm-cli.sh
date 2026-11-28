#!/usr/bin/env bash
set -euo pipefail

MPW_DIR="${MPW_DIR:-$HOME/Code/multi-project-workspace}"
# Resolve this script's own physical directory through symlinks (e.g. ~/.local/bin/swarm -> entry/swarm -> scripts/swarm-cli.sh).
SWARM_CLI_SOURCE="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SWARM_CLI_DIR="$(CDPATH= cd -- "$(dirname -- "$SWARM_CLI_SOURCE")" && pwd -P)"
# SWARM-PORTABLE-001: one env contract for every state path. SWARM_STATE_DIR wins so a
# clone/container/CI runner never writes into the developer's real state tree.
STATE_ROOT="${SWARM_STATE_DIR:-${SWARM_STATE_ROOT:-$HOME/.local/state/curl-ai-bridge}}"
export MPW_DIR
export SWARM_STATE_DIR="$STATE_ROOT"
OVERNIGHT_DIR="$STATE_ROOT/overnight"
STOP_FILE="$OVERNIGHT_DIR/STOP_SWARM"

usage() {
  cat <<'EOF'
Usage: swarm <command> [args...]

Commands:
  local [args...]      Local llama.cpp CLI (0.5b / 1.5b GGUF)
  remote [args...]     Remote GPU/TPU/AI-Models CLI (Colab / Kaggle 4 pools)
  direct [args...]     Lightweight tool-calling CLI (<30MB RAM: cloudflare|vercel)
  pack [args...]       Zero-LLM local context packer
  brief [args...]      One-call <=4KB executive brief (status + handoff + history grep)
  discover [args...]   Discover/Create prioritized tasks & multi-option cases
  case-solve [args...] Auto-resolve open cases (pauses on unrecoverable options)
  review [args...]     Deterministic + $0 sibling diff review & test gate
  queue [args...]      Run 1 bounded queue tick (5h window cap enforced)
  run [args...]        Run Plan -> Build -> Review -> Publish cycle
  overnight [args...]  Unattended overnight supervisor (kill-switch + circuit breaker)
  relay [args...]      Graceful multi-sibling relay (discover|fix, no hard close)
  lessons [args...]    Sync advisory lesson register (protected single-file backup)
  compact [args...]    Compact JSONL session history (protected single-file backup)
  handoff [args...]    Save/read <=30-line Session Handoff Card (zero-LLM)
  retire [args...]     Retire a session (save handoff card + record in retired-sessions.json)
  ask [args...]        Query an old session (default: $0 grep; optional READ-ONLY llm)
  undo <file>          Undo ONLY the last edit to <file> via protectedWriteFile backup
  prune-backups        Prune old .backups after git stage/commit/push (keeps 1 passing backup)
  checkpoint [args...] Protect passing diff across all 3 layers (per-file backup + git commit + GitHub push)
  notify [args...]     Send Ubuntu desktop/log alert or --check-remote (Kaggle/Colab/GitHub)
  stop                 Arm graceful kill-switch (STOP_SWARM)
  resume               Clear kill-switch (STOP_SWARM)
  measure [args]       Measure phase: decision-outcome ledger + relay telemetry aggregation
  workflow [args]      Reusable workflow registry: list / run declarative workflows
  status               Show registry, queue, cases, and kill-switch status
  doctor               Check guardrails: kill-switch, 5h ledger, overnight report, git cleanliness
  wakeup [since_sha]   Emit portable zero-LLM wakeup brief after a short/long break
  capabilities         Emit canonical D5 capability-manifest/v1.0 JSON
  help, -h, --help     Show this help
EOF
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  local)        exec node "$MPW_DIR/scripts/local-llama-cli.mjs" "$@" ;;
  remote)       exec node "$MPW_DIR/scripts/remote-gpu-cli.mjs" "$@" ;;
  direct)       exec node "$MPW_DIR/scripts/swarm-direct.mjs" "$@" ;;
  pack)         exec node "$MPW_DIR/scripts/swarm-context-pack.mjs" "$@" ;;
  brief)        exec node "$MPW_DIR/scripts/swarm-brief.mjs" "$@" ;;
  discover)     exec node "$MPW_DIR/scripts/swarm-discover.mjs" "$@" ;;
  case-solve)   exec node "$MPW_DIR/scripts/swarm-case-solve.mjs" "$@" ;;
  review)       exec node "$MPW_DIR/scripts/swarm-review.mjs" "$@" ;;
  queue)        exec node "$MPW_DIR/scripts/swarm-queue-run.mjs" "$@" ;;
  run)       exec node "$MPW_DIR/scripts/swarm-run.mjs" "$@" ;;
  overnight) exec node "$MPW_DIR/scripts/swarm-overnight.mjs" "$@" ;;
  relay)        exec node "$MPW_DIR/scripts/swarm-relay.mjs" "$@" ;;
  lessons)      exec node "$MPW_DIR/scripts/swarm-lesson-sync.mjs" "$@" ;;
  workflow)     exec node "$MPW_DIR/scripts/swarm-workflow.mjs" "$@" ;;
  compact)      exec node "$MPW_DIR/scripts/swarm-compact.mjs" "$@" ;;
  handoff)      exec node "$MPW_DIR/scripts/swarm-handoff.mjs" "$@" ;;
  retire)       exec node "$MPW_DIR/scripts/swarm-handoff.mjs" --retire "$@" ;;
  ask)          exec node "$MPW_DIR/scripts/swarm-ask.mjs" "$@" ;;
  undo)
    TARGET="${1:-}"
    if [ -z "$TARGET" ]; then echo "Usage: swarm undo <file>" >&2; exit 1; fi
    exec node --input-type=module -e '
      import { resolve } from "node:path";
      import { undoLastEdit } from "'"$MPW_DIR"'/apps/api/src/toolchain/dispatch/mutation-guard.js";
      const res = undoLastEdit(resolve(process.argv[1]));
      console.log(JSON.stringify(res, null, 2));
    ' "$TARGET"
    ;;
  prune-backups)
    exec node --input-type=module -e '
      import { execFileSync } from "node:child_process";
      import { existsSync, readdirSync } from "node:fs";
      import { join, resolve } from "node:path";
      import { pruneBackupsAfterGitCheckpoint } from "'"$MPW_DIR"'/apps/api/src/toolchain/dispatch/mutation-guard.js";
      const mpw = "'"$MPW_DIR"'";
      const stateRoot = "'"$STATE_ROOT"'";
      let committed = [];
      try {
        const out = execFileSync("git", ["-C", mpw, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { encoding: "utf8" }).trim();
        committed = out.split(/\r?\n/).filter(Boolean).map(p => resolve(mpw, p));
      } catch {}
      const stateDirs = ["sessions", "lessons", "handoffs", "reports", "relay", "queue/cases", "queue/active"]
        .map(sub => join(stateRoot, sub, ".backups"))
        .filter(d => existsSync(d));
      const res = pruneBackupsAfterGitCheckpoint({ committedPaths: committed, stateBackupDirs: stateDirs, keepRepoBackups: 1, keepStateBackups: 1 });
      console.log(JSON.stringify(res, null, 2));
    '
    ;;
  checkpoint)
    exec node --input-type=module -e '
      import { existsSync } from "node:fs";
      import { join } from "node:path";
      import { checkpointPassingDiff } from "'"$MPW_DIR"'/apps/api/src/toolchain/dispatch/mutation-guard.js";
      import { checkpointAllowed } from "'"$MPW_DIR"'/scripts/swarm-window-policy.mjs";
      const __policy = checkpointAllowed(process.env);
      if (!__policy.ok) {
        const __job = process.env.SWARM_WINDOW_JOB || "(unset)";
        process.stderr.write(`swarm: ${__policy.reason} (SWARM_WINDOW_JOB=${__job})\n`);
        process.exit(2);
      }
      const argv = process.argv.slice(1);
      const flag = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };
      const msg = flag("-m", flag("--message", "chore(checkpoint): passing diff checkpoint"));
      const taskId = flag("--task", null);
      const category = flag("--category", "self-improvement");
      const sibling = flag("--sibling", null);
      const quotaPool = flag("--pool", null);
      const push = argv.includes("--push");
      const valueFlags = new Set(["-m", "--message", "--task", "--category", "--sibling", "--pool"]);
      const files = [];
      for (let i = 0; i < argv.length; i++) {
        if (valueFlags.has(argv[i])) { i++; continue; }
        if (argv[i].startsWith("--")) continue;
        files.push(argv[i]);
      }
      const stateRoot = "'"$STATE_ROOT"'";
      const stateDirs = ["sessions", "lessons", "handoffs", "reports", "relay", "queue/cases", "queue/active"]
        .map(sub => join(stateRoot, sub, ".backups"))
        .filter(d => existsSync(d));
      const __gatePath = process.env.SWARM_GATE_VERDICT_PATH || null;
      const res = checkpointPassingDiff({
        repoDir: "'"$MPW_DIR"'",
        files,
        message: msg,
        taskId,
        category,
        sibling,
        quotaPool,
        backupRoot: join(stateRoot, "repo-checkpoints"),
        stateBackupDirs: stateDirs,
        push,
        gate: __gatePath
          ? { verdictPath: __gatePath, windowId: process.env.SWARM_WINDOW_ID || null }
          : null
      });
      console.log(JSON.stringify(res, null, 2));
    ' -- "$@"
    ;;
  notify)       exec node "$MPW_DIR/scripts/swarm-notify.mjs" "$@" ;;
  capabilities) exec node "$MPW_DIR/scripts/swarm-capabilities.mjs" "$@" ;;
  stop)
    mkdir -p "$OVERNIGHT_DIR"
    printf 'stopped_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STOP_FILE"
    echo "swarm: kill-switch armed ($STOP_FILE)"
    ;;
  resume)
    rm -f "$STOP_FILE"
    echo "swarm: kill-switch cleared"
    ;;
  health)
    exec node "$MPW_DIR/scripts/swarm-health.mjs" "$@" ;;
  measure)      exec node "$MPW_DIR/scripts/swarm-measure.mjs" "$@" ;;
  status)
    if [ "${1:-}" = "--json" ]; then
      # SWARM-HEALTH-001: machine-readable rollup (read-only).
      exec node "$MPW_DIR/scripts/swarm-health.mjs" --json
    fi
    node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      import { resolveStateRoot } from "'"$SWARM_CLI_DIR"'/swarm-state-paths.mjs";
      const root = resolveStateRoot();
      const reg = JSON.parse(fs.readFileSync(path.join(root, "sessions/swarm-sessions.json"), "utf8"));
      const pools = new Set(reg.sessions.map(s => s.quotaPool)).size;
      const idle = reg.sessions.filter(s => s.status === "idle" || s.status === "active").length;
      const qDir = path.join(root, "queue/active");
      const cDir = path.join(root, "queue/cases");
      const qCount = fs.existsSync(qDir) ? fs.readdirSync(qDir).filter(f => f.endsWith(".json")).length : 0;
      // Cases live in the sqlite registry; fall back to the legacy loose-file count.
      let cCount = fs.existsSync(cDir) ? fs.readdirSync(cDir).filter(f => f.endsWith(".json")).length : 0;
      const casesDb = path.join(cDir, "cases.sqlite");
      if (fs.existsSync(casesDb)) {
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(casesDb, { readOnly: true });
          cCount = db.prepare("select count(*) n from case_registry_records where json_extract(payload_json, ?) = ?").get("$.state", "open_case").n;
          db.close();
        } catch { /* keep legacy count */ }
      }
      const stop = fs.existsSync(path.join(root, "overnight/STOP_SWARM"));
      console.log(`swarm: sessions=${reg.sessions.length} pools=${pools} live=${idle} queue=${qCount} cases=${cCount} killSwitch=${stop ? "ARMED" : "clear"}`);
    '
    ;;
  doctor)
    "$0" status
    # entry/swarm is unversioned and must stay byte-identical to the repo copy.
    node "$MPW_DIR/scripts/swarm-entry-drift.mjs" || true
    # Resolve the script path before any cd: callers may invoke `swarm` from any cwd.
    SWARM_CLI_SOURCE="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
    SWARM_CLI_DIR=$(CDPATH= cd -- "$(dirname -- "$SWARM_CLI_SOURCE")" && pwd -P)
    node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      import { resolveStateRoot } from "'"$SWARM_CLI_DIR"'/swarm-state-paths.mjs";
      const root = resolveStateRoot();
      const ov = path.join(root, "overnight");
      const stop = fs.existsSync(path.join(ov, "STOP_SWARM"));
      const lp = path.join(ov, "pool-calls-5h.jsonl");
      const cutoff = Date.now() - 5 * 3600 * 1000;
      const counts = {};
      if (fs.existsSync(lp)) {
        for (const l of fs.readFileSync(lp, "utf8").trim().split(/\r?\n/).filter(Boolean)) {
          try { const r = JSON.parse(l); if (r.atMs >= cutoff) counts[r.quotaPool] = (counts[r.quotaPool] || 0) + 1; } catch {}
        }
      }
      const rp = path.join(ov, "overnight-report.json");
      const rep = fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, "utf8")) : null;
      console.log(`guardrails: killSwitch=${stop ? "ARMED" : "clear"} calls5h=${JSON.stringify(counts)} lastOvernight=${rep ? `${rep.stopReason}(ticks=${rep.ticksExecuted},fail=${rep.consecutiveFailures})` : "none"}`);
      const cpLedger = path.join(root, "repo-checkpoints/checkpoint-ledger.jsonl");
      if (fs.existsSync(cpLedger)) {
        const lines = fs.readFileSync(cpLedger, "utf8").trim().split(/\r?\n/).filter(Boolean);
        let files = 0, saved = 0, pushed = 0;
        for (const l of lines) { try { const r = JSON.parse(l); files += (r.filesCount||0); saved += (r.estimatedQuotaTurnsSaved||0); if (r.pushed) pushed++; } catch {} }
        console.log(`checkpoints: total=${lines.length} pushed=${pushed} filesProtected=${files} quotaTurnsSaved=${saved}`);
      }
    '
    # Relay quota admission ($0): same budget math as `swarm relay quota-status`,
    # so the doctor cannot drift from what the relay will actually admit.
    (cd "$SWARM_CLI_DIR/.." && node scripts/swarm-doctor-quota.mjs) || echo "relay_quota: unavailable (quota store unreadable)"
    timeout 5 git -C "$MPW_DIR" fetch --quiet origin 2>/dev/null || true
    AHEAD_BEHIND=$(git -C "$MPW_DIR" rev-list --left-right --count HEAD...@{u} 2>/dev/null || echo "0 0")
    AHEAD=$(echo "$AHEAD_BEHIND" | awk '{print $1}')
    BEHIND=$(echo "$AHEAD_BEHIND" | awk '{print $2}')
    echo "mpw_head=$(git -C "$MPW_DIR" rev-parse --short HEAD) dirty=$(git -C "$MPW_DIR" diff --name-only | wc -l) ahead=$AHEAD behind=$BEHIND"
    ;;
  wakeup)
    SINCE_SHA="${1:-HEAD~5}"
    echo "=== SWARM WAKEUP BRIEF ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
    "$0" status
    echo "=== GIT DELTA ($SINCE_SHA..HEAD) ==="
    git -C "$MPW_DIR" log --oneline -n 10 "$SINCE_SHA..HEAD" 2>/dev/null || git -C "$MPW_DIR" log --oneline -n 5
    echo "=== TOP QUEUE & CASES ==="
    node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      import { resolveStateRoot } from "'"$SWARM_CLI_DIR"'/swarm-state-paths.mjs";
      const root = resolveStateRoot();
      const list = (sub) => {
        const d = path.join(root, sub);
        if (!fs.existsSync(d)) return [];
        return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
      };
      const q = list("queue/active").filter(t => t.state !== "done").slice(0, 5);
      let c = list("queue/cases").filter(x => x.state === "open_case").slice(0, 5);
      // SOLVE-005: cases live in the sqlite registry — read open cases + measure summary from it.
      const casesDb = path.join(root, "queue/cases/cases.sqlite");
      if (fs.existsSync(casesDb)) {
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(casesDb, { readOnly: true });
          const rows = db.prepare("select case_id, payload_json from case_registry_records order by updated_at desc").all();
          const open = rows.map(r => JSON.parse(r.payload_json)).filter(x => x.state === "open_case");
          c = open.slice(0, 5);
          console.log("open_cases_total:", open.length);
          db.close();
        } catch { /* fall back to legacy loose files */ }
      }
      console.log("active_tasks:", q.map(t => `${t.taskId}(${t.priority || "P2"},${t.state})`).join(", ") || "none");
      console.log("open_cases:", c.map(x => `${x.id}(${(x.options||[]).length} opts)`).join(", ") || "none");
      // SOLVE-005: measure-phase summary (decision outcomes + failed-evidence reopens).
      const ledger = path.join(root, "queue/measurements/decision-outcomes.jsonl");
      if (fs.existsSync(ledger)) {
        const rows = fs.readFileSync(ledger, "utf8").split("\\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
        const reopens = rows.filter(r => r.decision === "reopen").length;
        const withEvidence = rows.filter(r => typeof r.evidenceScore === "number");
        const avg = withEvidence.length ? Math.round(withEvidence.reduce((s, r) => s + r.evidenceScore, 0) / withEvidence.length) : null;
        console.log("measure: decisions=" + rows.length, "reopens=" + reopens, avg !== null ? "avg_evidence=" + avg : "");
      }
      const lp = path.join(root, "lessons/lesson-register.json");
      if (fs.existsSync(lp)) {
        const l = JSON.parse(fs.readFileSync(lp, "utf8")).lessons || {};
        const keys = Array.isArray(l) ? l.map(x => x.id) : Object.keys(l);
        console.log("lessons_total:", keys.length, "latest:", keys.slice(-3).join(", "));
      }
      // Metadata-only freshness check across sibling CLI locations (read-only, no secrets, mergeNativeArtifacts=false)
      const home = process.env.HOME;
      const dirs = {
        hermes: path.join(home, ".hermes/findings"),
        opencode: path.join(home, ".config/opencode"),
        colab: path.join(home, ".config/colab-cli"),
        local_llama: path.join(home, ".local/state/local-llama-cli/sessions"),
        remote_gpu: path.join(home, ".local/state/remote-gpu-cli/output"),
        ai_catalog: path.join(home, "Code/AI/opencode-consol"),
        reports: path.join(root, "reports")
      };
      const metaPath = path.join(root, "notifications/wakeup-meta.json");
      const prev = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
      const curr = {}, changed = [];
      for (const [k, d] of Object.entries(dirs)) {
        if (!fs.existsSync(d)) continue;
        const mtimeMs = Math.round(fs.statSync(d).mtimeMs);
        curr[k] = mtimeMs;
        if (prev[k] !== mtimeMs) changed.push(`${k}(${new Date(mtimeMs).toISOString().slice(11,19)}Z)`);
      }
      fs.mkdirSync(path.dirname(metaPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(metaPath, JSON.stringify(curr, null, 2) + "\n", { mode: 0o600 });
      console.log("cli_meta_changed:", changed.length ? changed.join(", ") : "none");
      // Latest Session Handoff Card (zero-LLM cross-session continuity)
      const hDir = path.join(root, "handoffs");
      if (fs.existsSync(hDir)) {
        let latestH = null;
        for (const f of fs.readdirSync(hDir).filter(x => x.endsWith(".md"))) {
          const st = fs.statSync(path.join(hDir, f));
          if (!latestH || st.mtimeMs > latestH.mtimeMs) latestH = { f, mtimeMs: st.mtimeMs };
        }
        if (latestH) {
          const hText = fs.readFileSync(path.join(hDir, latestH.f), "utf8");
          const shaMatch = hText.match(/^- head_sha:\s*(\S+)/m);
          const hSha = shaMatch ? shaMatch[1] : null;
          let headSha = null;
          try { headSha = require("child_process").execFileSync("git", ["-C", process.env.MPW_DIR || path.join(home, "Code/multi-project-workspace"), "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
          const staleNote = hSha && headSha && hSha !== headSha ? ` [handoff_stale: ${hSha} != HEAD ${headSha}]` : "";
          console.log(`latest_handoff: ${latestH.f} (${new Date(latestH.mtimeMs).toISOString().slice(0,19)}Z)${staleNote} -> run "swarm handoff --read"`);
        }
      }
      // Active AGY session bloat check (protects weekly quota: warn at >=60KB or >=20 lines)
      const brainDir = path.join(home, ".gemini/antigravity-cli/brain");
      if (fs.existsSync(brainDir)) {
        let newest = null;
        for (const id of fs.readdirSync(brainDir)) {
          const tp = path.join(brainDir, id, ".system_generated/logs/transcript.jsonl");
          if (!fs.existsSync(tp)) continue;
          const st = fs.statSync(tp);
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { id, tp, bytes: st.size, mtimeMs: st.mtimeMs };
        }
        if (newest) {
          const lines = fs.readFileSync(newest.tp, "utf8").split(/\r?\n/).filter(Boolean).length;
          const kb = Math.round(newest.bytes / 1024);
          if (newest.bytes >= 60000 || lines >= 20) {
            console.log(`agy_session_warn: ${newest.id.slice(0, 8)} (${kb}KB, ${lines} lines) -> run /compact or /new to protect weekly quota`);
          } else {
            console.log(`agy_session_ok: ${newest.id.slice(0, 8)} (${kb}KB, ${lines} lines)`);
          }
        }
      }
    '
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "swarm: unknown command '$cmd' (run 'swarm --help')" >&2
    exit 1
    ;;
esac

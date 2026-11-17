#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
fail(){ printf 'swarm-entry: %s\n' "$*" >&2; exit 2; }
D=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || fail 'cannot resolve script directory'
R=$(CDPATH= cd -- "$D/.." && pwd -P) || fail 'cannot resolve workspace root'
[ -f "$R/package.json" ] && [ -f "$R/workspace.manifest.json" ] && [ -f "$R/scripts/ai-swarm.mjs" ] || fail 'workspace root preflight failed'
N=$(command -v node 2>/dev/null || true); [ -n "$N" ] || fail 'Node.js >=22 required'
V=$("$N" --version); M=${V#v}; M=${M%%.*}; case "$M" in ''|*[!0-9]*) fail 'invalid Node version';; esac
[ "$M" -ge 22 ] || fail "Node.js >=22 required; found $V"
cd "$R" || fail 'cannot enter workspace'
MODE=${1:-status}; [ "$#" -eq 0 ] || shift
# PET lineage is metadata-only; no discovery roots are enabled implicitly.
export PET_EXECUTION_ID=${PET_EXECUTION_ID:-"swarm-${BASHPID}-$(date +%s)"}
export PET_TASK_ID=${PET_TASK_ID:-${TASK_ID:-}}
case "$MODE" in
 status) printf 'Swarm entry ready\nRoot: %s\nNode: %s\nOffline-safe; live inference disabled\n' "$R" "$V";;
 pet) exec "$N" "$R/scripts/pet.mjs" "$@";;
 plan) exec "$N" "$R/scripts/ai-swarm.mjs" plan --local-only --no-reviewer --no-self-improve "$@";;
 dry-run) exec "$N" "$R/scripts/ai-swarm.mjs" run --dry-run --local-only --no-reviewer --no-self-improve "$@";;
 list) exec "$N" "$R/scripts/ai-swarm.mjs" list --json "$@";;
 context) exec "$N" "$R/scripts/swarm-context.mjs" "$@";;
 prompt) exec "$N" "$R/scripts/swarm-prompt.mjs" "$@";;
 session) exec "$N" "$R/scripts/swarm-session.mjs" "$@";;
 resume) exec "$N" "$R/scripts/swarm-session.mjs" resume "$@";;
 run|step|merge|deploy) fail "live/mutating mode '$MODE' disabled";;
 *) fail "unknown mode '$MODE'";;
esac

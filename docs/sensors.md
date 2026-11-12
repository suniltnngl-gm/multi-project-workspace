# Workspace sensors

Sensors are the deterministic half of workspace improvement. They read one
snapshot of persisted state, return findings, and never call a model or a
provider. Model-generated improvement drafts remain task proposals behind the
existing approve/reject gate; sensor findings are stored separately.

## Running scans

```sh
./workspace sensors scan                    # detect, persist, and audit one scan
./workspace sensors cycle                   # atomic scan plus optional promotions
./workspace sensors cycle --auto-promote high --project quality --task-type chore
./workspace sensors suggestions             # evidence-backed sensor ideas
./workspace sensors list                    # open and acknowledged findings
./workspace sensors list --state dismissed  # one lifecycle state
./workspace sensors list --severity high --sensor task.blocked_without_reason
./workspace sensors show <id>               # finding plus event trail
./workspace sensors runs                    # scan history
./workspace sensors catalog                 # detector registry and candidate ideas
./workspace sensors ack <id> --note "known"
./workspace sensors dismiss <id> --note "intentional"
./workspace sensors resolve <id>
./workspace sensors reopen <id>
./workspace sensors promote <id> --priority high --project quality
```

Add `--json` to any command for machine-readable output. The CLI imports the
same registry, store, and cycle runner as the API, so the two surfaces cannot
drift. Scans and cycles work without the API running.

The HTTP equivalents are `POST /api/sensors/scan`, `POST /api/sensors/cycles`,
`GET /api/sensors/catalog`, `GET /api/sensors/suggestions`,
`GET /api/sensors/summary`, `GET /api/sensors/runs`, `GET /api/sensors/runs/:id`,
`GET /api/sensors/findings`, `GET /api/sensors/findings/:id`, the `ack`,
`dismiss`, `resolve`, and `reopen` transitions under
`/api/sensors/findings/:id/`, and `POST /api/sensors/findings/:id/promote`.
Reads are token-free for the local board; the API stays loopback-only.

## Improvement cycles

A cycle is the unit of atomic improvement. It detects, persists findings, and
optionally promotes matching findings into tasks in one SQLite transaction. If
detection succeeds but persistence or promotion fails, the transaction rolls
back the run and every write it made, then a separate failed audit run records
the error. Detector failures are recorded on the run but do not discard the
findings produced by healthy detectors.

`POST /api/sensors/cycles` and `./workspace sensors cycle` accept:

- `auto_promote`: `off`, `high`, `medium`, or `all`. `high` promotes high
  findings, `medium` promotes high and medium, and `all` promotes every
  severity. The default is `off`.
- `project`: project name for created tasks; defaults to `workspace`.
- `task_type`: `feature`, `bug`, `chore`, `test`, or `docs`; defaults to `chore`.

`POST /api/sensors/scan` is the same cycle path with `auto_promote: off`.
Auto-promotion uses the ordinary promotion rules: only `open` findings are
promoted, the finding becomes `acknowledged`, and a `promoted` event is
recorded. Each run stores its `trigger_kind` (`manual`, `api`, `cli`, or
`scheduled`) and its `promoted` count.

Periodic cycles are opt-in. Set `SENSOR_CYCLE_INTERVAL_MS` to a value of at
least `1000` (or leave it at `0` to disable scheduling). The scheduler uses
recursive timeouts and unrefs its timer, skips a tick when the previous cycle
is still running, and stops with the API. `SENSOR_CYCLE_RUN_ON_START` runs one
cycle when the API starts, and `SENSOR_CYCLE_AUTO_PROMOTE` supplies the default
policy for scheduled cycles.

## Sensor suggestions

The meta detector `meta.sensor_suggestion` can propose new detectors. It reads
a fixed `SENSOR_IDEAS` catalog, and an idea becomes a finding only when the
current snapshot proves the coverage gap. For example, two blocked tasks in the
same project suggest a project-blocker cluster detector, and a tracked folder
that is missing on disk suggests a folder-existence detector.

Each suggestion is a normal finding with stable key `idea:<id>`, severity from
the idea, and `details.suggestedSensor` plus the evidence that triggered it.
`GET /api/sensors/suggestions` and `./workspace sensors suggestions` list the
active suggestions; both also return the full idea catalog. Suggestions are
deterministic findings, not model output, so reviewing them costs no quota.
Promoting a suggestion creates a task through the same gate as any other
finding.


## Lifecycle

- `open`: detected and actionable.
- `acknowledged`: someone has seen it; a rescan keeps it current.
- `dismissed`: intentionally muted; rescans never reopen it.
- `resolved`: gone or fixed. A rescan reopens it only if it is detected again.

A scan resolves only `open` and `acknowledged` findings that disappear. A
`resolved` finding that reappears is reopened; a `dismissed` finding stays
muted even while the condition persists. Every change is recorded in
`sensor_finding_events`, and every scan is recorded in `sensor_runs` with its
detected, created, updated, resolved, reopened, unchanged, and promoted counts
plus its trigger kind.

Promotion is valid only from `open`. It creates a task whose priority maps from
severity (`high` → `high`, `medium` → `medium`, `low` → `low`) and whose type
defaults to `chore`; the finding becomes `acknowledged` and records a
`promoted` event.

## Finding keys

Keys are stable for the same entity, so a rescan updates the existing row and
increments `occurrences` instead of adding a duplicate. Task findings key by
task id, provider findings key by provider quota domain, tracking findings key
by repository or row id, and aggregated findings key by domain plus repository.
Keys are unique in `sensor_findings`.

## Detectors

Task detectors:

- `task.blocked_without_reason`: blocked task with an empty `work_blocked`.
- `task.missing_next_move`: blocked or in-progress task with no `next_move`.
- `task.stale_in_progress`: in-progress task unchanged for
  `SENSOR_STALE_TASK_HOURS`.
- `task.duplicate_active_title`: two or more unfinished tasks with the same
  normalized title.

Agent detectors:

- `agent_run.stale`: non-terminal run unchanged for `SENSOR_STALE_RUN_HOURS`.
- `agent_run.budget_exhausted`: non-terminal run with no tokens, calls, or time
  left.

Quota detectors:

- `provider.quota_blocked`: every model in a provider quota domain is exhausted
  or cooling down, including the earliest retry delay.
- `model.usage_without_profile`: a model has observed requests but no configured
  quota profile.

Tracking detectors:

- `tool.unavailable`: a tracked workflow tool cannot be resolved.
- `mcp.server_error`: a discovered MCP server reports a status error.
- `tracking.file_missing`: tracked files are missing on disk.
- `tracking.files_without_objective`: tracked files have no objective.
- `tracking.folders_without_objective`: tracked folders have no objective.
- `tracking.repository_root_missing`: a registered repository root is gone.
- `tracking.worktree_missing`: a tracked Git worktree path is gone.
- `tracking.script_unverified`: a registered script has never been verified.
- `tracking.empty_domain`: an expected tracking domain has no rows.

Meta detector:

- `meta.sensor_suggestion`: the snapshot proves a coverage gap described by a
  candidate detector in `SENSOR_IDEAS`. The finding carries the proposed sensor
  and its evidence.

Aggregated detectors carry `count` and a bounded `sample` (at most
`SENSOR_SAMPLE_LIMIT` rows) so the queue stays actionable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENSOR_STALE_TASK_HOURS` | `72` | Age at which an in-progress task becomes stale. |
| `SENSOR_STALE_RUN_HOURS` | `24` | Age at which a non-terminal run becomes stale. |
| `SENSOR_STALE_METADATA_HOURS` | `720` | Age at which tracked metadata is considered stale. |
| `SENSOR_SAMPLE_LIMIT` | `10` | Maximum sample rows in an aggregated finding. |
| `SENSOR_CYCLE_INTERVAL_MS` | `0` | Periodic cycle interval; `0` disables scheduling, otherwise at least `1000`. |
| `SENSOR_CYCLE_AUTO_PROMOTE` | `off` | Default promotion policy for scheduled cycles: `off`, `high`, `medium`, or `all`. |
| `SENSOR_CYCLE_RUN_ON_START` | `false` | Run one cycle when the API starts. |
| `SENSOR_CYCLE_PROJECT` | `workspace` | Project for tasks created by scheduled promotions. |
| `SENSOR_CYCLE_TASK_TYPE` | `chore` | Task type for tasks created by scheduled promotions. |

Thresholds only decide when a condition becomes a finding. No vendor quota
table is embedded in source, and sensor scans never probe a backend, so a
detected condition cannot cause quota burn.

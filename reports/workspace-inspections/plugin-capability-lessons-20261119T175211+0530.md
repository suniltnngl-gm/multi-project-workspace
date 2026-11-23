# cURL AI Bridge — Plugin Capability Lessons

- Run timestamp: 2026-11-19T17:52:11+05:30
- Runtime: ChatGPT tool-enabled automation runtime; current tool registry enumerated from `ALL_TOOLS`
- Scope: bounded read-only capability discovery, project-scoped evidence reads, Git pre-state inspection, and one exclusive-create Markdown report
- Authority: ChatGPT remains the sole project manager/planner; plugin providers, agents, tasks and model outputs are subordinate evidence sources, not authorities
- No implementation, provider invocation, worker dispatch, external data mutation, Git mutation, OAuth/connect flow or permission elevation was performed

## 1. Runtime catalog and coverage

### Native ChatGPT skills

- `skills__list` succeeded and returned **0 skill roots**.
- `skills__read` was exposed, but no valid skill URI was returned; it was therefore not called with a guessed URI.
- This means no installed ChatGPT skill entry points were available to inspect in this run. It does not prove that no plugin-specific documentation exists elsewhere.

### Provider/platform skill registries

- Hatchable `mcp__Hatchable__list_skills` returned **57 platform skill guides**.
- Eleven unique guides were read with `mcp__Hatchable__read_skill`: `ai/build-an-agent-with-tools`, `ai/inspect-llm-call-history`, `ai/use-a-provider-directly`, `api/access`, `api/stream-a-response`, `background/defer-with-scheduler`, `data/query-with-pagination`, `integrations/connect-an-external-api`, `integrations/verify-a-webhook`, `mcp/expose-an-mcp-tool`, and `meta/platform-constraints`.
- Linear `mcp__Linear__list_agent_skills` succeeded and returned `agentSkills=[]`, `hasNextPage=false`.
- Hatchable's 57 guides are its own platform documentation registry, not 57 installed ChatGPT plugins.

### Exposed action surface

- **945 actions across 21 namespaces** were enumerated from the runtime registry.
- Namespace counts: Automations=7; Dropbox=39; files=11; GitHub=89; Gmail=20; Google_Calendar=10; Hatchable=34; Linear=93; Neon=141; Plugin_Creator=9; Plugin_Management=4; Remote_Desktop_Commander=30; Render=48; Replit=8; skills=2; Supabase=36; Todoist=49; Trello=15; user_settings=2; Vercel=260; Webflow=38.
- The complete action-name manifest is included in Appendix A. The selected read-action descriptions below are taken from the current registry; descriptions are limited to their first paragraph where long.
- The action count is the same as the immediately preceding checkpoint's reported count. No full prior action manifest was available for a reliable action-by-action delta, so no claim is made that every action is unchanged.

## 2. Catalog, exposure and connection states

These are deliberately separate dimensions:
1. Catalog/skill presence.
2. Action exposure in this runtime.
3. Account connection/authentication and successful resource-scoped read.

A permission setting or visible action is not proof of provider authentication. `READ-TESTED` means only that the named bounded read in this run succeeded; it does not imply write permission.

| Namespace/provider | Catalog evidence | Exposed actions | Current status | Connection/read evidence and limit |
|---|---|---:|---|---|
| Native ChatGPT skills | 0 roots | 2 | UNAVAILABLE-IN-RUN for skill roots | Listing succeeded empty; no guessed skill URI read |
| Hatchable | 57 platform guides | 34 | READ-TESTED | Platform skill list + 11 guide reads succeeded; project-specific account/resource access NOT RECONCILED |
| GitHub | No native skill root | 89 | READ-TESTED | Exact repository metadata and Issue #19 read succeeded |
| Dropbox | No native skill root | 39 | READ-TESTED | Exact CC-006C metadata and content read succeeded |
| Linear | No native skill root; agent skill list empty | 93 | READ-TESTED | Workspace identity and exact project search succeeded; no cURL AI Bridge project result |
| Remote Desktop Commander | No native skill root | 30 | READ-TESTED | Authenticated identity, device list and constrained local Git inspection succeeded |
| Plugin Management | No native skill root | 4 | READ-TESTED | Named app permission metadata read; this is not provider OAuth or resource access |
| Vercel | No native skill root | 260 | TOOL-EXPOSED | App permission metadata found; no project-scoped Vercel read attempted |
| Render | No native skill root | 48 | TOOL-EXPOSED | App permission metadata found; no verified cURL AI Bridge service/workspace ID |
| Neon | No native skill root | 141 | TOOL-EXPOSED | App permission metadata found; no verified cURL AI Bridge project ID |
| Supabase | No native skill root | 36 | TOOL-EXPOSED | App permission metadata found; no verified cURL AI Bridge project ID |
| Trello | No native skill root | 15 | TOOL-EXPOSED | App permission metadata found; no board/card ID mapped to this project |
| Replit | No native skill root | 8 | TOOL-EXPOSED | App permission metadata found; no project/app read |
| Webflow | No native skill root | 38 | TOOL-EXPOSED | App permission metadata found; no project/site read; specialized guide not invoked because no Webflow operation was needed |
| Plugin Creator | No native skill root | 9 | TOOL-EXPOSED | App permission metadata found; no exact owned plugin ID inspected |
| Automations | No native skill root | 7 | TOOL-EXPOSED | App permission metadata found; current task definition was already supplied in the run context, so no broader automation inventory was read |
| Todoist | No native skill root | 49 | UNAVAILABLE-IN-RUN | Exact app permission lookup returned `not_installed`; no task/project read attempted |
| Gmail | No native skill root | 20 | UNAVAILABLE-IN-RUN | Exact app permission lookup returned `not_installed`; no email read attempted |
| Google Calendar | No native skill root | 10 | UNAVAILABLE-IN-RUN | Exact app permission lookup returned `not_installed`; no calendar read attempted |
| ChatGPT Files | Not a plugin skill catalog | 11 | TOOL-EXPOSED | No broad Library/personal-content search performed |
| ChatGPT user settings | Not a plugin skill catalog | 2 | TOOL-EXPOSED | Settings read not needed; setting mutation excluded |

### App permission metadata

The exact named lookups found **13** apps with app-specific setting `Use my default`, inheriting the global **Allow low-risk actions** policy: GitHub, Dropbox, Linear, Hatchable, Vercel, Render, Neon, Supabase, Trello, Replit, Webflow, Automations, and Plugin Creator.

Three exact lookups returned `not_installed`: Todoist, Gmail, and Google Calendar. Their action namespaces remain visible, but no account connection/read access is inferred.

The Remote Desktop Commander identity endpoint independently confirmed an authenticated service session and the device list showed `sunilkr-H81` online (device ID `6f9a336b-2280-4e52-bcd0-0b1b3426e948`, app version `0.3.4`). Its usage response reported **12% remote-call usage remaining**. No email, account identity details or unrelated user metadata are retained here.

## 3. Project-scoped reads and current evidence

### GitHub

- Repository: `suniltnngl-gm/curl-ai-bridge`, repository ID `1443769540`, private, default branch `main`.
- Issue #19: ID `6221727989`, open, updated `2026-11-18T11:51:30Z`.
- Issue title: “Track remaining G8/G9 work, review gates, and roadmap dependencies”.
- The issue explicitly says it is a durable tracking register and does not authorize merge, deployment, infrastructure changes or implementation of captured ideas. It retains independent-review and exact-head CI gates; G9.4–G9.7 are future candidates, not authorization.
- No PR, review, workflow dispatch, issue mutation or comment action was performed.

### Dropbox

- Exact file ID: `id:opctR6uvYWcAAAAAAAAANw`.
- Path: `/Apps/curl-ai-bridge-cloud/protocol/extensions/cc-006c-cloud-inbox-auth-v1.json`.
- Revision: `6608b2b39e65980285971`; server modified `2026-11-18T11:18:22Z`; size 1,776 bytes.
- Current record says event authority is `coordination-only`, project manager is `ChatGPT`, runtime parent is `AI_A`, and worker execution authority is `not-granted-by-storage-or-event`.
- It specifies EdDSA/Ed25519 verification, out-of-band SHA-256 public-key fingerprint pinning, required expiry, bounded keyset polling, durable non-expiring local deduplication, no remote claims, retain invalid events as cloud evidence, verify before worker handoff, no automatic inference retries and no cloud-object deletion.
- Rollout fields still say live assignment not published, live inbox poll not performed, production signing key not provisioned, remote worker dispatch not performed, schedule integration not authorized and trusted-key pin not provisioned.
- The ChatGPT/AI_A field difference is metadata drift only; no authority transfer or correction is inferred.

### Linear

- Authenticated workspace read succeeded for workspace `aidev-tools`, ID `9e912d3a-12b6-4e53-94c7-5bcb9d85d873`.
- Exact project search for “cURL AI Bridge” returned zero results.
- Agent skill listing returned an empty array with no next page.
- This is a bounded negative result, not proof of global absence across archives, aliases or other teams.

### Local Git pre-state

Both target roots were verified by comparing `git rev-parse --show-toplevel` to the expected absolute path before status inspection. Only branch/HEAD/upstream/status counts and whitespace checks were run; no source files were read.

| Repository | Branch | HEAD | Behind / ahead | Dirty entries | Diff checks |
|---|---|---|---:|---:|---|
| `/home/sunilkr/Code/curl-ai-bridge` | `test/ubuntu-self-hosted-runner-smoke` | `b90d2c2b0594ddc0ac517834b45a855aaee8e1cd` | 0 / 17 | 0 | `git diff --check` PASS; cached PASS |
| `/home/sunilkr/Code/multi-project-workspace` | `master` | `e28afe7eca1a585a58ad8d8c3628fd98322e7549` | 0 / 6 | 10 | `git diff --check` PASS; cached PASS |

The work-ledger workspace had 10 dirty entries versus 5 in the preceding checkpoint response. Names and contents were deliberately not inspected; all changes remain untouched. The cURL AI Bridge repository remained clean at the observed status boundary.

## 4. Relevant read-only action descriptions from the current registry

### GitHub
- `mcp__GitHub__get_repo` — Retrieve metadata for a GitHub repository. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url`: - `repository_full_name`: `owner/name`, such as `openai/openai`. Maps to GitHub REST `owner` and `repo` path parameters. - `repository_id`: numeric GitHub repository ID, such as `1296269`. - `repository_url`: repository URL or nested repository URL, such as a PR, issue, branch, file, REST API, GitHub Enterprise Server `/api/v3`, or GHE.com API URL. GitHub REST repository docs:...
- `mcp__GitHub__fetch_issue` — Fetch a GitHub issue. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url` to select the issue's repository.
- `mcp__GitHub__fetch_pr` — Fetch a pull request with its diff, metadata, and optionally comments.
- `mcp__GitHub__get_pr_info` — Get metadata (title, description, refs, and status) for a pull request. This action does *not* include the actual code changes. If you need the diff or per-file patches, call `fetch_pr_patch` instead (or use `get_users_recent_prs_in_repo` with ``include_diff=True`` when listing the user's own PRs).
- `mcp__GitHub__fetch_file` — Fetch file content by repository path, using the default branch when ref is omitted.
- `mcp__GitHub__fetch_commit` — Fetch a commit with its metadata, diff, and canonical URL.
- `mcp__GitHub__get_commit_combined_status` — Fetch the combined CI status and individual status checks for a commit.
- `mcp__GitHub__list_pull_request_reviews` — List review submissions on a pull request. Returns GraphQL review nodes normalized into the connector's review model. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreview
- `mcp__GitHub__list_pull_request_review_threads` — List inline review threads on a pull request, including resolved state. Returns GraphQL review thread nodes, including comment bodies and resolution metadata. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
- `mcp__GitHub__fetch_workflow_run_jobs` — Fetch jobs for a GitHub Actions workflow run. This wrapper returns the latest attempt's jobs from the first page only. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#list-jobs-for-a-workflow-run
- `mcp__GitHub__fetch_workflow_job_logs` — Fetch decoded logs for a GitHub Actions workflow job. GitHub serves this endpoint through a temporary redirect; the underlying client follows that redirect before decoding the bytes. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#download-job-logs-for-a-workflow-run-job
- `mcp__GitHub__search_issues` — Search one repository or every repository the linked account can access. Supply at most one repository selector. Empty lists mean no repository filter. A `repo:owner/name` query does not require a separate repository selector.

### Dropbox
- `mcp__Dropbox__who_am_i` — Get the connected Dropbox user's identity, team, and namespace roots
- `mcp__Dropbox__search` — Search Dropbox files and folders by name or content, with optional filters
- `mcp__Dropbox__get_file_metadata` — Get metadata, sharing details, and permissions for a Dropbox file or folder
- `mcp__Dropbox__fetch` — Fetch full text content for a Dropbox file by id or path.
- `mcp__Dropbox__list_folder` — List Dropbox folder contents; supports direct children or recursive traversal
- `mcp__Dropbox__list_file_revisions` — Tool
- `mcp__Dropbox__file_preview` — Preview Dropbox files visually with thumbnails and Open in Dropbox links
- `mcp__Dropbox__paper_read_document` — Read a Paper document. Call before addressed edits, comments, or when current content matters. Returns canonical identity, revision, sections, editable lines, receipts, and threads.

### Linear
- `mcp__Linear__whoami` — Retrieve the authenticated user, the connected workspace, and how this connection reaches Linear
- `mcp__Linear__get_workspace` — Retrieve the connected workspace's ID, name, and URL to confirm which workspace you are using
- `mcp__Linear__list_teams` — List teams in the user's Linear workspace, including their parent IDs and hierarchy names
- `mcp__Linear__list_projects` — List projects in the user's Linear workspace
- `mcp__Linear__get_project` — Retrieve details of a specific project in Linear
- `mcp__Linear__list_issues` — List issues in the user's Linear workspace, including active Triage Intelligence suggestions for issues in triage. For issues assigned to me, use "me" as the assignee. For issues created by me, use "me" as the creator. Use "null" for no assignee.
- `mcp__Linear__get_issue` — Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.
- `mcp__Linear__search` — Full-text search across Linear issues, projects, initiatives, and documents, ranked by relevance. Use this for keyword or natural-language queries (e.g. "memory leak in sync engine"). Supports "quoted phrases" for exact match, -term to exclude, and +term to require. For structured filtering by assignee, status, team, label, etc., use the list_issues or list_projects tools instead.
- `mcp__Linear__list_documents` — List or search documents in the user's Linear workspace by title and content
- `mcp__Linear__get_document` — Retrieve a Linear document by ID or slug
- `mcp__Linear__list_comments` — List comments on a Linear issue, project, initiative, document, project milestone, or project/initiative status update. Provide exactly one of `issueId`, `projectId`, `initiativeId`, `documentId`, `milestoneId`, or `statusUpdateId`. `statusUpdateType` applies only to `statusUpdateId`; omit it for every other parent. For issues, projects, and initiatives this returns both top-level discussion threads and inline description comments. Inline (anchored) comments carry a non-null `quotedText` set to the snippet of de...
- `mcp__Linear__list_cycles` — List a team's cycles with their IDs, numbers, dates, and issue and scope histories
- `mcp__Linear__list_releases` — List releases in the workspace, with optional filtering by pipeline, stage, version, and text.
- `mcp__Linear__list_agent_skills` — List Linear Agent skills available to the authenticated user.
- `mcp__Linear__get_agent_skill` — Retrieve a Linear Agent skill by ID, including its full markdown instructions.

### Remote Desktop Commander
- `mcp__Remote_Desktop_Commander__who_am_i` — Get details about the currently authenticated user, including this month's remote tool-call usage as a percentage
- `mcp__Remote_Desktop_Commander__list_devices` — List this account's Desktop Commander devices, their online/offline status, IDs for device selection, and device-management guidance
- `mcp__Remote_Desktop_Commander__list_directory` — Get a detailed listing of all files and directories in a specified path.
- `mcp__Remote_Desktop_Commander__read_file` — Read contents from files and URLs. Read PDF files and extract content as markdown and images.
- `mcp__Remote_Desktop_Commander__read_multiple_files` — Read the contents of multiple files simultaneously.
- `mcp__Remote_Desktop_Commander__get_file_info` — Retrieve detailed metadata about a file or directory including: - size - creation time - last modified time - permissions - type - lineCount (for text files) - lastLine (zero-indexed number of last line, for text files) - appendPosition (line number for appending, for text files) - sheets (for Excel files - array of {name, rowCount, colCount})
- `mcp__Remote_Desktop_Commander__get_usage_stats` — Get usage statistics for debugging and analysis.
- `mcp__Remote_Desktop_Commander__get_recent_tool_calls` — Get recent local tool call history with arguments and outputs. Returns a chronological list of recent calls loaded from the local history file.
- `mcp__Remote_Desktop_Commander__list_sessions` — List all active terminal sessions.
- `mcp__Remote_Desktop_Commander__list_processes` — List all running processes.
- `mcp__Remote_Desktop_Commander__read_process_output` — Read output from a running process with file-like pagination support.
- `mcp__Remote_Desktop_Commander__get_tool_result` — Read the status or final result of a Remote MCP tool call that returned a running call_id. Do not retry the original side-effecting tool while its status is pending or executing.

### Render, Neon and Supabase
- `mcp__Render__list_workspaces` — List the workspaces that you have access to
- `mcp__Render__get_selected_workspace` — Get the workspace stored in the session compatibility fallback. Request-scoped workspaces supplied with an explicit workspaceId are not reflected by this tool.
- `mcp__Render__list_services` — List all services in your Render account
- `mcp__Render__get_service` — Get details about a specific service
- `mcp__Render__list_deploys` — List deploys matching the provided filters. If no filters are provided, all deploys for the service are returned.
- `mcp__Render__get_deploy` — Retrieve the details of a particular deploy for a particular service.
- `mcp__Render__list_events` — List a service's event history: deploys, builds, restarts, failures, scaling, suspensions, and disk changes. Use it to find out what happened to a service and why. Failure events carry the reason a service went down, such as out-of-memory kills, non-zero exits, failed health checks, and evictions, which may not show up in logs. The first page covers the last 7 days unless startTime says otherwise. For older events, page with the cursor from the previous call. If the first page comes back empty there is no cursor...
- `mcp__Render__list_logs` — List logs matching the provided filters. Logs are paginated by start and end timestamps. There are more logs to fetch if hasMore is true in the response. Provide the nextStartTime and nextEndTime timestamps as the startTime and endTime query parameters to fetch the next page of logs. You can query for logs across multiple resources, but all resources must be in the same region and belong to the same owner.
- `mcp__Render__get_metrics` — Get performance metrics for any Render resource (services, Postgres databases, key-value stores). Supports CPU usage/limits/targets, memory usage/limits/targets, service instance counts, HTTP request counts and response time metrics, bandwidth usage metrics, database active connection counts for debugging, capacity planning, and performance optimization. Returns time-series data with timestamps and values for the specified time range. HTTP metrics support filtering by host and path for more granular analysis. Li...
- `mcp__Render__list_workflows` — Discover Workflows in the selected workspace. Returns one page and nextCursor; follow until null or an empty page.
- `mcp__Render__get_workflow` — Get a Workflow's configuration and verify it belongs to the selected workspace.
- `mcp__Render__list_workflow_runs` — List task runs with status, attempts and parent/root relationships. A page is not the entire history. The API does not support status/time filters here. Use get_workflow_run for errors and get_workflow_run_results for results.
- `mcp__Render__get_workflow_run` — Inspect a task run's status, errors and all attempts (zero-indexed), plus parent/root relationships. Errors are capped at 4 KiB each with errorTruncated flags. Inputs/results are omitted. Use get_workflow_run_results for results. Report attempts as returned; retries and timestamps alone do not prove how many attempts ran or how long they queued. Task failure is data, not a tool failure.
- `mcp__Neon__list_organizations` — Lists the organizations the user belongs to; an organization API key gets its own organization. search filters by name or id.
- `mcp__Neon__list_projects` — Lists the projects in an organization; search filters by name or id. To also find branches, computes, or snapshots, use search. Returns every page. Pass limit to cap how many. `org_id` is optional: organization API keys use their organization; personal API keys auto-select when unambiguous and otherwise return the IDs to choose from.
- `mcp__Neon__describe_project` — Gets a project's settings, owner, and usage. For branches, use list_branches.
- `mcp__Neon__list_branches` — Lists a project's branches with id (br-...), name, parent, and default flag; search finds a branch's id by name. Returns every page. Pass limit to cap how many.
- `mcp__Neon__get_branch` — Gets a branch record: name, parent, state, protection, size, and timestamps. For its databases and tables, use describe_branch.
- `mcp__Neon__get_project_consumption` — Returns per-project consumption in an organization. metrics: every name get_branch_consumption takes, plus extra_branches_month and snapshot_storage_bytes_month. Launch, Scale, Agent, Business, or Enterprise plans; others get 403. Returns every page. Pass limit to cap how many.
- `mcp__Neon__get_branch_consumption` — Returns per-branch consumption for project_ids. metrics: compute_unit_seconds, root_branch_bytes_month, child_branch_bytes_month, instant_restore_bytes_month, public_network_transfer_bytes, private_network_transfer_bytes, functions_active_capacity_microseconds, functions_waiting_capacity_microseconds, functions_invocations, functions_egress_bytes. Usage-based Launch, Scale, Agent, or Enterprise plans only. Returns every page. Pass limit to cap how many.
- `mcp__Neon__list_incidents` — Lists open Neon incidents and maintenance from neonstatus.com and the affected components and regions. Needs no credentials. Call it when Neon requests fail unexpectedly or the user asks whether Neon is down.
- `mcp__Neon__query_logs` — Returns a branch's log records. Filters combine with AND; pass logql or structured filters, not both. Pass since or start_time, not both; default last hour, max seven days. Private beta: a branch without logs returns 404 telemetry_not_enabled. Stream labels: query_loki_logs. Returns every page. Pass limit to cap how many.
- `mcp__Neon__describe_table_schema` — Returns a table's columns, indexes, constraints, and sizes. For every table, use get_database_tables.
- `mcp__Neon__get_database_tables` — Lists a database's tables and views outside the system schemas. For one table's columns, use describe_table_schema.
- `mcp__Supabase__list_organizations` — Lists all organizations that the user is a member of.
- `mcp__Supabase__get_organization` — Gets details for an organization. Includes subscription plan.
- `mcp__Supabase__list_projects` — Lists all Supabase projects for the user. Use this to help discover the project ID of the project that the user is working on.
- `mcp__Supabase__get_project` — Gets details for a Supabase project. `status` is `ACTIVE_HEALTHY` when the project is ready for database tools; other values such as `COMING_UP`, `RESTORING`, or `INACTIVE` (paused) mean database calls will fail or time out.
- `mcp__Supabase__get_cost` — Gets the cost of creating a new project or branch. Never assume organization as costs can be different for each. Always repeat the cost to the user and confirm their understanding before proceeding.
- `mcp__Supabase__list_tables` — Lists all tables in one or more schemas. By default returns a compact summary. Set verbose to true to include column details, primary keys, and foreign key constraints.
- `mcp__Supabase__list_extensions` — Lists all extensions in the database.
- `mcp__Supabase__list_migrations` — Lists all migrations in the database.
- `mcp__Supabase__query_logs` — Runs a custom read-only ClickHouse SQL query against a Supabase project's unified logs stream, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_e...
- `mcp__Supabase__get_advisors` — Gets a list of advisory notices for the Supabase project. Use this to check for security vulnerabilities, performance improvements, or health issues. Include the remediation URL as a clickable link so that the user can reference the issue themselves. It's recommended to run this tool regularly, especially after making DDL changes to the database since it will catch things like missing RLS policies.
- `mcp__Supabase__list_edge_functions` — Lists all Edge Functions in a Supabase project.
- `mcp__Supabase__get_edge_function` — Retrieves file contents for an Edge Function in a Supabase project.
- `mcp__Supabase__list_branches` — Lists all development branches of a Supabase project. This will return branch details including status which you can use to check when operations like merge/rebase/reset complete.

### Vercel
- `mcp__Vercel__get_auth_user` — Retrieves information related to the currently authenticated User.
- `mcp__Vercel__list_projects` — List the projects of the authenticated user or the selected team. Results are paginated using limit and from. Optionally filter by name search, Git repository, connected Global Config, build settings, and other listed filters.
- `mcp__Vercel__get_project` — Get a project's details by project ID or name.
- `mcp__Vercel__list_deployments` — Use this when you need deployment records or recent deployment history under the authenticated user or team. Results can be filtered by project, branch, commit, environment, state, creator, or creation time. Returns deployment data; incomplete uploads have a null URL. For a live deployment card with build status and expandable logs, use open_deployments when available.
- `mcp__Vercel__get_deployment` — Get a deployment by its ID or hostname. When withGitRepoInfo is true, the response also includes Git source details. Additional details are included when the authenticated user or team owns the deployment.
- `mcp__Vercel__get_runtime_logs` — Use this when reading application output (console.log, warnings, errors) that the functions and daemons of a project wrote at runtime, as individual log records, or when counting those records with group_by. Filter by deployment, environment, level, source, request ID, time range, or full-text query. The default window is the latest 50 minutes; for a recent window, pass since like "30m" and omit until, which is only needed for historical end times. How far back logs go depends on the runtime-log retention of the...
- `mcp__Vercel__get_runtime_errors` — Use this when investigating production errors or finding the most frequent runtime failures in a project. Returns pre-aggregated error clusters with error names, occurrence counts, affected routes, sample messages, and first/last seen times. Use get_runtime_logs for individual log entries; use deployment build logs for build failures. For recent windows, pass since like "24h" or "7d" and omit until; until is only needed for historical end times. Max 7-day range.
- `mcp__Vercel__get_project_trace` — Get the resolved OpenTelemetry trace for a project by trace ID or Vercel request ID. Pass traceId (32-character hex, as in a dashboard URL ending in /logs/traces/<traceId>) or requestId (from runtime logs or the x-vercel-id header). Traces are only kept for the team plan's trace retention: 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise. Internal Vercel runtime spans are removed and their children reparented; span durations are in milliseconds. Error spans include the type and stack trace of their first exce...
- `mcp__Vercel__list_teams` — Get a paginated list of all the Teams the authenticated User is a member of.
- `mcp__Vercel__get_team` — Get information for the Team specified by the `teamId` parameter.
- `mcp__Vercel__list_vercel_ci_invocations` — List Vercel CI invocations for a team. Optionally filter by repository provider, repository, branch, commit snapshot, author, status, conclusion, source, or creation time. Paginated with limit (default 20, max 100) and cursor.
- `mcp__Vercel__get_vercel_ci_invocation` — Get one attempt of a Vercel CI invocation, identified by invocationId and attempt.
- `mcp__Vercel__get_vercel_ci_invocation_logs` — Get log lines for a Vercel CI invocation attempt, optionally filtered by log level.
- `mcp__Vercel__list_sessions` — List sandbox sessions in a project, optionally filtered by sandbox name. Sorted by creation time; paginated with limit (default 20, max 50) and an opaque cursor.
- `mcp__Vercel__get_session` — Retrieves detailed information about a specific session, including its current status, resource configuration, and exposed routes.
- `mcp__Vercel__get_session_command_logs` — Get the stdout, stderr, and error output entries of a command in a session. The tool reads the log stream until it ends before returning, and very large logs are sampled (first and last entries).

### Trello, Todoist, Gmail and Google Calendar
- `mcp__Trello__trelloReadCard` — Fetch a Trello card's full details, or list cards across a board or list to surface open work items. Use this tool when you know the specific board, list, or card you want to inspect. For keyword-based discovery across all boards/cards, use trelloSearch instead. Actions: - "get": fetch a single card by id or card URL (cardIdOrUrl required). Returns core card fields, labels (up to 25; truncation signalled via labelsHasMore), checklists (up to 25; truncation signalled via checklistsHasMore, each with up to 25 chec...
- `mcp__Trello__trelloReadBoard` — Read Trello boards. Supports listing boards the authenticated user is a member of, listing all boards a user can access within a specific workspace (regardless of membership), fetching a single board by ARI or URL, listing labels on a board, listing a board's custom field definitions, and listing a board's action/history.
- `mcp__Trello__trelloReadChecklist` — Read Trello checklists (and their check items) attached to a card. Supported actions: "list_by_card" — list checklists on a card (cardId required); cursor/limit page the checklists. "get" — fetch a single checklist by id (checklistId required). In both actions each checklist is returned with its complete `items` list embedded.
- `mcp__Trello__trelloReadInbox` — Triage and review the authenticated user's Trello Inbox — the personal quick-capture board where new cards and notifications land. Use this specifically for the user's Inbox board. For cards on other boards or lists, use trelloReadCard instead. Actions: "get" — return the Inbox board details (id, objectId, lastActivityAt). No additional arguments are needed. "list_cards" — list cards in the Inbox with optional filtering and pagination. Each card includes labels and up to 25 checklists (truncation signalled via c...
- `mcp__Trello__trelloReadList` — Read Trello lists. Supported actions: "list_by_board" — list the open lists on a board (id, name, position, objectId) with cursor-based pagination (limit defaults to 25, max 50); "get" — return a single list by id, including up to 25 nested cards (id, name). - "list_activity" — page through open cards currently in a list and return each card's recent activity. Only the cards are paginated (cursor/limit, defaults to 25 cards, max 50); each card returns its 25 most recent activity entries. Use trelloReadCard to ge...
- `mcp__Trello__trelloReadMember` — Get a Trello member's profile. Call action="get_me" FIRST before any due-date query (e.g. "cards due today", "overdue cards") to get prefs.timezone (e.g. "America/Los_Angeles") so due dates can be interpreted in the user's local time rather than UTC. Also use action="get_me" to look up the current user's username, fullName, email, or avatarUrl. Supported actions: "get_me" — returns the authenticated user's Trello member profile (id, username, fullName, email, avatarUrl, url, prefs) via the Trello GraphQL API. "g...
- `mcp__Trello__trelloReadPlanner` — Read Trello Planner information for the authenticated user. Supported actions: "get" — returns the current member's planner (id, primaryAccountId, primaryCalendarId, primaryCalendar details); "list_events" — lists calendar events for a given planner calendar in a time window (plannerCalendarId, providerAccountId, start, end required; limit defaults to 25, max 50; cursor-based pagination supported); "get_event" — returns a single calendar event by provider event id (eventId, providerAccountId, plannerCalendarId r...
- `mcp__Trello__trelloReadWorkspace` — Read Trello workspaces (organizations) the current user has access to. Supported actions: "list" — list workspaces visible to the authenticated user (cursor-based pagination, limit defaults to 25, max 100); "get" — fetch detailed data for a single workspace by id (typically used after "list" to drill into a workspace).
- `mcp__Trello__trelloSearch` — Discover Trello boards or cards by keyword across all workspaces. Use this when the user wants to find something by name or content but does not know which board it is on. If the user already knows the board or list they want to browse, use trelloReadCard (list_by_board or list_by_list) instead — it is faster and returns richer grouped results. Supported actions: "search_boards" — search for boards by name, always include each board's `url` verbatim in the response; "search_cards" — search for cards by name/cont...
- `mcp__Todoist__To_Do_List___Calendar__find_tasks` — Find active tasks by text, project/section/parent, responsible user, labels, raw filter, or saved filter (filterIdOrName). Without filters, list a page. Default scope: unassigned + mine; responsibleUserFiltering="all" includes others.
- `mcp__Todoist__To_Do_List___Calendar__find_projects` — List or search by name the projects the user has joined. By default only active projects are returned; use archivedStatus ('archived' or 'all') to include archived projects. When searching or when archivedStatus is 'all', all matching projects are returned (pagination is ignored). Otherwise projects are returned with pagination. Workspace projects the user hasn't joined are left out unless includeUnjoined is set, or a search matches no joined project.
- `mcp__Todoist__To_Do_List___Calendar__fetch_object` — Fetch a single task, project, comment, or section by its ID. Use this when you have a specific object ID and want to retrieve its full details. Set includeChildren to also get its direct subtasks or sub-projects.
- `mcp__Todoist__To_Do_List___Calendar__search` — Search across tasks and projects in Todoist. Returns a list of relevant results with IDs, titles, and URLs.
- `mcp__Todoist__To_Do_List___Calendar__find_activity` — Retrieve activity logs to monitor and audit changes in Todoist. Shows events from all users by default (use initiatorId to filter by specific user). To answer what someone completed in a period, including recurring task occurrences, use objectType "task", eventType "completed", and dateFrom/dateTo. For a first-person question ("what did I get done"), also set initiatorId to the current user from user-info, or the answer includes collaborators' completions. Track task completions, updates, deletions, project chan...
- `mcp__Todoist__To_Do_List___Calendar__get_project_health` — Get a comprehensive health assessment for a project including completion progress, health status (EXCELLENT, ON_TRACK, AT_RISK, CRITICAL), and optional detailed context with project metrics and task-level data. Use includeContext=true for that full detail.
- `mcp__Gmail__get_thread` — Retrieves a specific email thread from the authenticated user's Gmail account, including a list of its messages.
- `mcp__Gmail__get_message` — Retrieves a specific email message from the authenticated user's Gmail account by its unique message ID.
- `mcp__Gmail__search_threads` — Lists email threads from the authenticated user's Gmail account.
- `mcp__Gmail__list_drafts` — Lists draft emails from the authenticated user's Gmail account.
- `mcp__Gmail__list_labels` — Lists all labels available in the authenticated user's Gmail account. Use this tool to discover the `id` of a label before calling `label_thread`, `unlabel_thread`, `label_message`, or `unlabel_message`. Note: the system labels, `DRAFT` and `SENT`, cannot be set on messages and are read only.
- `mcp__Gmail__get_profile` — Resolve account identity with the fresh Google access token.
- `mcp__Google_Calendar__list_events` — Returns events on the given calendar matching all specified constraints. Time constraints should not be specified unless requested by the user. For open-ended keyword or topic-based searches on the primary calendar, the search_events tool must be used instead.
- `mcp__Google_Calendar__get_event` — Returns a single event on the given calendar.
- `mcp__Google_Calendar__list_calendars` — Returns the calendars this user has access to (their calendar list). Use this tool to resolve calendar identifying data (for example, 'my family calendar') into its corresponding `calendar_id` (email identifier)
- `mcp__Google_Calendar__search_events` — Searches events on the user's primary calendar using semantic search.
- `mcp__Google_Calendar__get_profile` — Resolve account identity using the existing Google userinfo implementation.

### Replit, Webflow, Plugin Creator and Automations
- `mcp__Replit__list_apps` — List Replit Apps the user can edit, most recently updated first; `query` optionally filters by matching app titles, surfacing the best matches for the query first. Use this when the user wants to browse or pick from their apps, or when you need a replId but resolve_app_by_name returned found=false because the user gave an approximate name — present the returned titles and let the user choose, then pass the chosen replId to update_app_using_prompt or ask_question. This is a search/list, not the exact resolver: pr...
- `mcp__Replit__resolve_app_by_name` — Look up by exact name a Replit App the user can edit and return its replId (UUID) and URL. Use this when the user refers to an app by name (e.g. "update my Todo App", "what does my Recipe Tracker do?") and you don't already have a replId from create_app_from_prompt earlier in this conversation. Pass the result's replId into update_app_using_prompt or ask_question to act on the app. Matching is case-insensitive but exact: this is a name resolver, not a search. If the user gives you an approximate or partial name ...
- `mcp__Replit__search_apps` — Search Replit Apps the user can edit (owned or shared with them). query is a BM25-style keyword search over app titles, best matches first; updatedAfter/updatedBefore bound the last-updated time; these combine. Prefer the default recency ordering: only set updatedAfter/updatedBefore when the user explicitly asks to filter by time, since date bounds exclude apps that would otherwise be listed. url resolves a Replit App URL directly to that app and ignores the other filters. With no filters, this returns the user'...
- `mcp__Replit__get_publish_status` — Check the publish status of the user's Replit App: whether it has ever been published, the current status of its most recent publish, and the public URL it serves. found=false means the app has never been published; call publish_app to publish it for the first time. When found, 'success' means it is live at the returned url, 'failed' means the last publish did not go through, 'suspended' means the published app is paused and not serving, and anything else means a publish or lifecycle operation is still in progre...
- `mcp__Webflow__get_asset_preview` — Get an image preview of a site asset by its asset ID. Fetches the asset's metadata, downloads the smallest available image variant (or the original file when no variants exist), and returns the image content. Works with any image content type (e.g. JPG, PNG, GIF, WEBP); non-image files and files larger than 2 MB return an error instead of an image. Returns a 404 error if the asset does not exist or has been deleted.
- `mcp__Webflow__get_more_tools` — Check for additional tools whenever your task might benefit from specialized capabilities - even if existing tools could work as a fallback.
- `mcp__Webflow__webflow_home` — Opens the Webflow home view: the most recently published sites this account can reach (up to 48), with Designer and live links. Use it when the user opens the Webflow app or asks for an overview of their sites. To list every site, find a site id, or get site details for other tools, use data_sites_tool instead.
- `mcp__Webflow__webflow_guide_tool` — Provides essential guidelines and best practices for effectively using the Webflow tools. Call this tool to understand recommended workflows and important considerations before performing actions. ALWAYS CALL THIS TOOL FIRST BEFORE CALLING ANY OTHER TOOLS. ALWAYS CALL THIS TOOL FIRST BEFORE CALLING ANY OTHER TOOLS.
- `mcp__Plugin_Creator__list_owned_personal_plugins` — List eligible private personal plugins with USER scope created by the current user. Requires a personal account without an active workspace. Excludes all WORKSPACE plugins, including private and migrated ones. Absence is not an access denial. When the exact plugin ID is known, use get_plugin_metadata for metadata or get_plugin_files to inspect files. Follow next_cursor to continue personal-plugin discovery.
- `mcp__Plugin_Creator__get_plugin_metadata` — Get metadata for an editable plugin by its exact backend ID, without downloading its archive. Handles owned private personal plugins and eligible workspace plugins without requiring prior knowledge of their scope. Workspace access requires the plugin creator, an owner or admin of the active workspace, or a plugin editor. Returns the stored scope and current release ID. Use get_plugin_files when you need files; it also returns this metadata.
- `mcp__Plugin_Creator__get_plugin_files` — Get metadata and list files from an editable plugin's current release by its exact backend ID. Handles owned private personal plugins and eligible workspace plugins without a separate scope lookup. Workspace access requires the plugin creator, an owner or admin of the active workspace, or a plugin editor. First call without read_paths to list available files; pass the returned next_offset as offset to continue listing as needed. Then use read_paths with exact paths from the returned files list to read selected U...
- `mcp__Plugin_Creator__list_plugin_releases` — List attached releases of an eligible owned personal plugin or workspace plugin using the same editing permissions as get_owned_plugin_archive. Returns release IDs, versions, creation times, and current-release markers. Results are in newest attachment order, not version or publication order, and can include unpublished releases. Follow next_cursor even when a page has no releases. Pass a returned release_id to get_owned_plugin_archive to download that version.
- `mcp__Plugin_Creator__get_plugin_sharing` — Read the complete plugin sharing audience and discoverability before or after sharing.
- `mcp__Plugin_Creator__get_owned_plugin_archive` — Get a short-lived download URL for the complete archive of an eligible owned personal plugin or workspace plugin, including shared ones. Omit release_id for the current release, or pass a release ID from list_plugin_releases to retrieve a stored historical release. The returned release describes the downloaded version; plugin describes the current plugin. Retrieving a release does not restore or publish it. Use get_plugin_files first for simple text edits; use this archive when the requested edit needs binary, l...
- `mcp__Automations__get` — Read one task's saved instructions and context version by automation ID.
- `mcp__Automations__list_event_sources` — List connected apps with supported automation events. Call this before discover_webhook_schema, then pass the chosen source's connector_id as connector_type. Call again after connecting or disconnecting an app.
- `mcp__Automations__peek` — Privately look up task automations without displaying the list to the user.

### Hatchable and ChatGPT core
- `mcp__Hatchable__get_project` — Get project details including slug, status, deployed functions, and the database schema (tables, columns, types).
- `mcp__Hatchable__list_agent_tasks` — Read the agent tasks the project's owner has filed — plain-English asks like "make the header say X" or "the contact form is broken", written in the console and waiting for you.
- `mcp__Hatchable__read_file` — Read the content of a project file.
- `mcp__Hatchable__grep` — Regex content search across a project's files. Postgres-backed, scoped to one project, with glob filtering.
- `mcp__Hatchable__list_files` — List all files in a project with their paths, sizes, and hashes.
- `mcp__Hatchable__get_schema` — Return the database schema for the project's PostgreSQL database: tables, columns (with types), and indexes.
- `mcp__Hatchable__view_logs` — View function execution logs with rich filtering. Each entry includes status_code, duration_ms, log_output (captured console.log), error (if any), and a derived `level` field (error/warning/info).
- `mcp__Hatchable__list_deployments` — List deployments for a project in reverse-chronological order. Each entry includes version, status, deployed_at, description, and summary counts (files, functions).
- `mcp__Hatchable__list_functions` — List every deployed API function for a project: route, method, runtime tier, type ('scheduled' if the function has at least one active scheduled task, else 'api'), and 24-hour invocation and error counts.
- `mcp__Hatchable__get_deployment` — Detail view of one deployment by version number — returns the full file manifest (paths, hashes, sizes) and function list captured when that version shipped. Use it with list_deployments to audit or compare what changed between versions.
- `mcp__Hatchable__list_cron_jobs` — List a project's scheduled tasks: every recurring task, every one-shot still to fire, and the 20 most recent one-shots that already fired (older fired one-shots are counted in completed_one_shots, not listed). A task points at a function and carries a cron expression (recurring) or a one-shot fire_at, plus an optional payload delivered as the request body. Tasks are either 'declared' (written into source via export const schedule or hatchable.toml, reconciled on deploy) or 'armed' (inserted by the SDK scheduler....
- `mcp__Hatchable__list_pending_uploads` — Show multipart uploads currently staged for this project that haven't yet been committed. Use this to recover from a disconnect — find the upload_id and resume from the next chunk_index. Uploads expire 10 minutes after the last chunk was added.
- `mcp__Hatchable__search_projects` — Search the public Hatchable project directory — other people's projects that you can view or fork. Use this to find existing apps to fork-and-modify as a starting point.
- `mcp__Hatchable__list_skills` — List the registry of platform skills — discrete how-to guides for one specific task each (e.g. 'gate-an-endpoint', 'add-a-cron-job', 'add-rag-search'). Each entry is a name, one-line purpose, and category. Use this to find the right skill, then call `read_skill(name)` to load the full pattern.
- `mcp__Hatchable__read_skill` — Load the full markdown body of one skill: when to use it, the canonical code shape, common pitfalls, and how to verify it works. Skills are the platform's primary agent-facing reference — every pattern an agent might need is one of these.
- `files__list` — List ChatGPT conversation files or browse the user's file library. Supports metadata filters for file types and dates, including the special file type 'folder' for folder-only library listings. Returns file and folder metadata only; use recursive=true for recent files across the whole library, and use files.search for ranked content retrieval. Use the Library surface for prior or persistent files, including files from previous conversations. Common Library call: {"surface":"library","recursive":true,"limit":20}....
- `files__search` — Default first choice for broad content questions or when the relevant location is unknown; this is ranked semantic search. Use one top-level search_query array with q strings only; each item may contain q and optional search_title_only. Keep scope, filters, intent, and top_k at the top level. Do not copy legacy file_search.msearch fields such as queries, source_filter, or file_type_filter; do not use web-search fields such as recency, response_length, q2, or q3, and use at most 5 query items. Extra query items a...
- `files__read` — Read a known file or range, or expand a relevant search/find result; do not use as the first step for broad retrieval. Pass one read item per independent file/range, at most 5 items per call. Extra items are skipped with a warning; submit them in separate calls. Supports full-file text windows, context around a visible files.search/list/find/read result, and specific page text/images via mode='pages' with include_images=true. A PDF or document that contains screenshots, scans, figures, or photos is still a PDF o...
- `files__find` — Find literal or regex text matches within a known ChatGPT conversation or file-library file. Use a ref/id visible in the conversation or returned by a prior Files result; do not invent a turnNfileM ref. Use only when you know an exact term, phrase, or heading; batch up to five likely exact variants as separate find items, or use a concise regex. The request has one top-level find array; put max_matches on each item, never at the top level, and do not send top-level response_length. Use files.search instead for b...
- `skills__list` — List available skills and their descriptions.
- `skills__read` — Read an available skill's complete instructions or a supporting file. For listed reference files, append the exact relative path to the skill root URI and read it with this tool. PDF, DOC, DOCX, XLS, XLSX, PPT, and PPTX files bundled under skills://plugins/ return extracted text; PDF text includes source page labels and spreadsheet output may be partial. Other binary formats and binary files outside installed plugin skills are not supported. Only read skill files under skill roots available in this conversation....
- `user_settings__get_user_settings` — Return the user's current settings along with descriptions and allowed values. Always call this FIRST to get the set of options available before asking for clarifying information (if needed) and before changing any settings.

## 5. Permission boundary and excluded actions

The global ChatGPT permission setting is **Allow low-risk actions**. This is a host approval policy, not a grant of provider OAuth scopes, resource roles or permission to mutate project records.

The following classes were not invoked:

- GitHub: create/update/delete files, branches, refs, issues or PRs; comments/reviews/reactions/labels; merge; resolve review threads; rerun CI jobs.
- Dropbox: upload/create/delete/move/copy/restore; shared links/permissions; Paper edits/comments; signature requests or reminders.
- Linear: save/update/delete issues, projects, documents, comments, labels, releases, milestones, status updates, customer records or review findings; share/unshare; merge diffs; mark notifications.
- Remote Desktop Commander: write/edit/move files, create directories, change config, shut down devices, kill processes, or run arbitrary commands. The only process command was a fixed, read-only Git/status/path check.
- Hatchable: project creation/update, file writes/patch/delete, SQL, functions, deployment, uploads, task updates or feedback.
- Render: resource creation/update, deploy/cron/workflow execution or cancellation, environment-variable changes, workspace switching.
- Neon: SQL/transactions, migrations, branch/project changes, role/credential/auth changes, endpoint/snapshot/storage/function mutations.
- Supabase: SQL/migrations, project lifecycle, branch changes, Edge Function deployment, notebook execution or feedback writes.
- Vercel: deployments, project/env/domain/config changes, session commands, sandboxes, keys, flags, routing, firewall and billing mutations.
- Trello: all `trelloWrite*` actions.
- Todoist: add/update/delete/complete/reschedule tasks; project, comment, reminder, label, filter or assignment changes.
- Gmail: create/update drafts, send/reply/forward, label changes or deletion.
- Google Calendar: create/update/delete/respond to events.
- Replit: create/update/publish apps.
- Webflow: designer/CMS/site mutation tools; no Webflow workflow was started.
- Plugin Creator: create/update/share plugins.
- Automations: create/update/run-now operations.
- Plugin Management: uninstall and permission updates.
- ChatGPT Files/user settings: library mutation/share/materialization and settings mutation.

No elevation, confirmation, OAuth/Connect/Reconnect, permission-mode switch or operator wait was attempted.

## 6. Reusable lessons with provenance

### 6.1 Discovery and adapter abstraction

- **FACT —** The runtime's tool registry is a separate discovery plane from `skills__list`; the former exposed 945 actions while the latter returned zero skill roots. Evidence: current `ALL_TOOLS` enumeration and `skills__list`.
- **PROPOSAL —** Model connector discovery as separate `catalog_entry`, `tool_exposed`, `app_permission`, `authenticated_identity`, `resource_read_tested` and `write_tested` fields. Do not collapse these into a Boolean `connected`.
- **PROPOSAL —** Keep a provider-neutral adapter contract with `discover()`, `describe_action()`, `classify_risk()`, `read()`, and separately gated `write()`. Each adapter must expose provider-native pagination and error semantics rather than flattening them away.

### 6.2 Permission classification and fail-closed behavior

- **FACT —** Plugin Management describes the default `review_important_actions` setting as automatically approving low-risk actions while potentially denying sensitive operations. Exact named app lookups found this default and `Use my default` overrides for 13 apps.
- **FACT —** Hatchable's `api/access` guide says route access is explicitly declared and edge-enforced; missing declarations fail deploy validation for framework_v=1 projects.
- **INFERENCE —** Host low-risk approval, provider OAuth scope, project role and application-level policy are four separate enforcement layers.
- **PROPOSAL —** Require an operation-level capability manifest. Generic shell/process, SQL, deploy, file-write, comment, share and permission tools default to denied unless the operation is an explicitly authorized report write.
- **PROPOSAL —** A denied or confirmation-gated operation should return `NEEDS_OPERATOR` without attempting alternate permission modes or bypasses.

### 6.3 Authentication versus exposure

- **FACT —** Todoist, Gmail and Google Calendar action namespaces were exposed while their exact app-permission lookups returned `not_installed`.
- **FACT —** GitHub, Dropbox and Linear each completed a bounded project-relevant read; this is stronger connection evidence than permission metadata alone.
- **PROPOSAL —** Store `tool_exposed` and `authenticated_read_verified` independently, with timestamp, account/workspace scope and resource selector.
- **UNKNOWN —** No OAuth token scope, credential lifetime, or provider-wide account entitlement was inspected for this run.

### 6.4 Stable IDs, scope, pagination and provenance

- **FACT —** GitHub actions accept repository full name, numeric repository ID or repository URL selectors; the issue read was pinned to one repository and issue number.
- **FACT —** Dropbox metadata/fetch accepts exact Dropbox file IDs or canonical paths; its search uses opaque cursors and `fetch` has a 5 MiB maximum with an error on extraction failure rather than partial-success content.
- **FACT —** Hatchable's pagination guide recommends keyset cursors, a unique tie-breaker for non-unique ordering, and `LIMIT N+1`; it explicitly says cursors are not authorization.
- **FACT —** Linear's exact project search returned no result; a negative bounded query must not be promoted into a global absence claim.
- **PROPOSAL —** Persist provider ID, parent/resource ID, exact query/filter, cursor, page count, timestamp, revision/etag where available, and result completeness. Preserve opaque cursors exactly.
- **PROPOSAL —** For mutable datasets, prefer keyset or provider-native snapshot pagination and test duplicate/skip behavior under concurrent inserts.

### 6.5 Multi-instance/session/configuration sharing

- **FACT —** Hatchable documents project-scoped MCP OAuth audience values; a token for one project is rejected by another project's endpoint. It documents one-hour access JWTs, a fixed 30-day refresh-token window, and immediate revocation.
- **FACT —** Hatchable's API integration guide documents project-configured provider credentials, encrypted storage, automatic OAuth refresh and a `SetupRequired` failure before connection.
- **UNKNOWN —** No evidence in this run establishes whether OpenCode, Copilot, Hermes, AGY or any other CLI shares credentials, config directories, session files or model context across multiple instances.
- **PROPOSAL —** Default CLI sessions to isolated namespaces. Shared sessions, config roots, cache roots or credentials require explicit adapter-specific declarations and tests.

### 6.6 Model catalogue, invocation and quota contracts

- **FACT —** Hatchable's agent guide distinguishes function-style tools (`description`, JSON Schema `inputSchema`, optional `execute`) from provider-native tools passed through in provider-specific shapes.
- **FACT —** The guide says `ai.generateText` with `execute` and `maxSteps` runs the tool loop; omitting `execute` returns planned tool calls for caller-controlled execution. Each loop step incurs another model invocation.
- **FACT —** The same guide says `ai.streamText` streams a single model round, does not execute tool functions and ignores `maxSteps`.
- **FACT —** Hatchable's AI ledger records provider/model, tokens, cost, duration, purpose and user ID; `null` cost means unpriced, and `cost_is_complete=false` means the displayed cost is only a floor. Rollups cache for approximately 60 seconds.
- **FACT —** The direct-provider guide recommends typed chat/embedding APIs for ordinary calls and `ai.fetch` for provider-specific endpoints not covered by typed shims; provider pinning is required where an endpoint is provider-specific.
- **PROPOSAL —** In cURL AI Bridge, keep exact model IDs, aliases, catalogue source, provider-native feature requirements, token usage, price completeness and entitlement/quota state as separate fields. Unknown/unpriced is never free.
- **UNKNOWN —** No CLI catalogue, model alias resolution, quota, billing entitlement or prompt-cache behavior was queried or tested in this run.

### 6.7 Retry, timeout, cancellation and terminal state

- **FACT —** Hatchable's scheduler guide distinguishes persisted/cancellable `scheduler.at` jobs from `scheduler.now` fire-and-forget work, which cannot be cancelled after dispatch.
- **FACT —** The guide documents at most two concurrent deferred one-shot runs per project; excess fires are skipped with `last_error`. One-shot jobs receive about 310 seconds, recurring cron jobs about 65 seconds, and longer work must be chunked.
- **FACT —** Remote Desktop Commander says a running call returns a PID and should be inspected with result/output retrieval; do not retry the original side-effecting action while pending/executing.
- **FACT —** Hatchable's streaming guide says a closed/slow reader can interrupt writes and clients must handle terminal error events; its scheduler guide says streaming is not a substitute for background work.
- **PROPOSAL —** Represent `queued`, `running`, `awaiting_result`, `succeeded`, `failed`, `cancelled`, `timed_out`, `skipped` and `unknown` separately. Retrying must require idempotency evidence or an explicit safe retry policy.
- **UNKNOWN —** No cross-CLI cancellation or terminal-state behavior was tested.

### 6.8 Security and webhook provenance

- **FACT —** Hatchable's webhook guide verifies the exact `req.rawBody`, performs constant-time HMAC comparison, and supports timestamp replay windows.
- **PROPOSAL —** Reuse the security pattern for inbound cURL AI Bridge events: authenticate exact canonical bytes, bind event ID and expiry, reject replay, verify trust pin before worker handoff, and preserve invalid input as evidence rather than deleting it.
- **EVIDENCE —** Hatchable `integrations/verify-a-webhook`; Dropbox CC-006C revision `6608b2b39e65980285971`.

### 6.9 Cross-provider portability and fallback

- **FACT —** Hatchable's guide says function-style tools can be normalized through JSON Schema, while provider-native tools are provider-specific and not portable.
- **INFERENCE —** A common CLI adapter can normalize invocation lifecycle and structured tool schemas, but it cannot erase provider-native capability differences.
- **PROPOSAL —** Maintain a capability matrix per provider/model, with explicit unsupported states and adapter-specific validation. If no project ID or authenticated read exists, report `NOT_RECONCILED` rather than broadening searches.

### 6.10 Regression-test candidates

- **PROPOSAL — Catalog/auth:** empty skill catalog + exposed tools; exposed namespace + not-installed app; permission metadata without authenticated identity; successful read scoped to one project.
- **PROPOSAL — Permission:** mixed read/write namespace classification; generic shell command denylist; no OAuth/reconnect or elevation fallback; write tool cannot be selected by a read-only planner.
- **PROPOSAL — Scope/pagination:** wrong parent ID rejected; exact resource ID preserved; opaque cursor round-trip; keyset tie-breaker stable; concurrent inserts cause no duplicate/skip; cursor cannot bypass authorization.
- **PROPOSAL — Model/tool loop:** function tool schema normalization; provider-native tool rejected on incompatible backend; `maxSteps` ceiling; tool-call plan without execute; streamed tool-call request does not accidentally execute; per-step usage and cost accounting.
- **PROPOSAL — Session/config:** two CLI instances with separate roots do not share history/credentials by default; explicit shared-session opt-in; provider-specific config discovery; concurrent writer fencing.
- **PROPOSAL — Quota/terminal:** unknown quota blocks dispatch; unpriced cost is not free; pending process is polled instead of reissued; cancellation is distinct from timeout; inference success does not imply task synchronization/completion.
- **PROPOSAL — Event security:** altered raw byte fails HMAC; stale timestamp fails replay window; duplicate event ID is idempotently claimed; unpinned key cannot activate worker execution.

## 7. Documentation conflicts and unresolved evidence

1. **MCP access-tier conflict:** `api/access` states `access: 'user'` is not valid in `mcp/*.js`; `mcp/expose-an-mcp-tool` documents `user | member | admin` in the MCP example and explains user-mode grants. This remains unresolved. Do not rely on `user` mode for MCP until the platform's authoritative contract is clarified.
2. **Streaming conflict:** `meta/platform-constraints` says responses are fully buffered and `res.write`/SSE/EventSource are unavailable; `api/stream-a-response` documents Response streams, SSE and `res.write`, while also saying the front currently buffers delivery. This remains unresolved. Do not infer progressive delivery or implement streaming assumptions from either document alone.
3. **CLI session sharing:** not reconciled; no CLI-specific session or config reads.
4. **Linear project mapping:** exact project search returned no results; mapping remains unresolved.
5. **Provider quota and rate limits:** unknown for GitHub, Linear, Dropbox, Vercel, Render, Neon, Supabase, Trello, Replit and other untested provider accounts. No account-wide usage sweep was performed.
6. **Tool coverage:** action names were fully enumerated from the current registry; read-action descriptions were selected for relevant families. No claim is made that every action was tested or that every provider's full documentation was inspected.
7. **Remote Desktop Commander budget:** 12% remote-call usage remained at identity check. Additional workspace inspection was intentionally avoided after the bounded Git check.

## 8. Operations performed and deliberately not attempted

### Performed
- Native ChatGPT skill catalog listing.
- Hatchable platform skill catalog listing and 11 unique skill reads.
- Linear agent-skill listing.
- Current tool namespace/action enumeration.
- Exact app permission metadata reads for 16 named app targets.
- GitHub repository metadata and Issue #19 reads.
- Dropbox exact-file metadata and content read.
- Linear authenticated workspace identity and exact project search.
- Remote Desktop Commander identity/device reads and a fixed read-only Git/path/status command.
- One exclusive-create report write, followed by byte/hash verification.

### Not attempted
- No model inference, provider call, CLI prompt, worker dispatch, swarm execution, quota consumption or paid fallback.
- No account/OAuth/credential/token/secret inspection.
- No app installation, connect/disconnect, permission change, or elevation.
- No project/task/issue/PR/comment/message/email/calendar mutation.
- No deployment, infrastructure change, database write, migration or schema change.
- No Git stage/commit/push/merge/rebase/reset/clean/stash/fetch.
- No source/config/environment file read; no dirty/untracked file modification.
- No broad personal-content, inbox, calendar, workspace or account enumeration.

## 9. Report artifact and verification

- Target directory verified to exist: `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections`.
- New file: `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections/plugin-capability-lessons-20261119T175211+0530.md`.
- Creation method: exclusive file creation (`open(..., "xb")`); existing files are not overwritten.
- Post-write verification: file reopened, byte-for-byte equality checked, size, line count and SHA-256 computed.
- This report is evidence of this bounded checkpoint only; it is not an authorization or proof of complete plugin coverage.

## Appendix A — Complete action-name manifest

### Automations (7)

`mcp__Automations__create`, `mcp__Automations__get`, `mcp__Automations__list_event_sources`, `mcp__Automations__notify_parent`, `mcp__Automations__peek`, `mcp__Automations__run_now`, `mcp__Automations__update`

### Dropbox (39)

`mcp__Dropbox__check_job_status`, `mcp__Dropbox__check_upload_file_status`, `mcp__Dropbox__copy`, `mcp__Dropbox__create_file_request`, `mcp__Dropbox__create_folder`, `mcp__Dropbox__create_shared_link`, `mcp__Dropbox__delete`, `mcp__Dropbox__download_link`, `mcp__Dropbox__fetch`, `mcp__Dropbox__file_preview`, `mcp__Dropbox__get_file_metadata`, `mcp__Dropbox__get_file_request`, `mcp__Dropbox__get_shared_link_metadata`, `mcp__Dropbox__list_file_requests`, `mcp__Dropbox__list_file_revisions`, `mcp__Dropbox__list_folder`, `mcp__Dropbox__list_restore_events`, `mcp__Dropbox__list_shared_links`, `mcp__Dropbox__move`, `mcp__Dropbox__paper_apply_markdown`, `mcp__Dropbox__paper_comment`, `mcp__Dropbox__paper_create_document`, `mcp__Dropbox__paper_edit_content`, `mcp__Dropbox__paper_edit_table`, `mcp__Dropbox__paper_get_doc_history`, `mcp__Dropbox__paper_insert`, `mcp__Dropbox__paper_insert_image`, `mcp__Dropbox__paper_list_recent_docs`, `mcp__Dropbox__paper_read_document`, `mcp__Dropbox__restore_file_revision`, `mcp__Dropbox__restore_folder`, `mcp__Dropbox__search`, `mcp__Dropbox__sign_cancel_signature_request`, `mcp__Dropbox__sign_create_signature_request_draft`, `mcp__Dropbox__sign_download_signature_request`, `mcp__Dropbox__sign_list_signature_requests`, `mcp__Dropbox__sign_send_signature_request_reminders`, `mcp__Dropbox__upload_file`, `mcp__Dropbox__who_am_i`

### files (11)

`files__create_reference_image`, `files__delete_reference_image`, `files__find`, `files__list`, `files__list_reference_images`, `files__manage_library`, `files__materialize`, `files__read`, `files__search`, `files__share`, `files__update_reference_image`

### GitHub (89)

`mcp__GitHub__add_comment_to_issue`, `mcp__GitHub__add_issue_assignees`, `mcp__GitHub__add_issue_labels`, `mcp__GitHub__add_reaction_to_issue_comment`, `mcp__GitHub__add_reaction_to_pr`, `mcp__GitHub__add_reaction_to_pr_review_comment`, `mcp__GitHub__add_review_to_pr`, `mcp__GitHub__compare_commits`, `mcp__GitHub__convert_pull_request_to_draft`, `mcp__GitHub__create_blob`, `mcp__GitHub__create_branch`, `mcp__GitHub__create_commit`, `mcp__GitHub__create_file`, `mcp__GitHub__create_issue`, `mcp__GitHub__create_pull_request`, `mcp__GitHub__create_tree`, `mcp__GitHub__delete_file`, `mcp__GitHub__dismiss_pull_request_review`, `mcp__GitHub__download_user_content`, `mcp__GitHub__download_workflow_artifact`, `mcp__GitHub__enable_auto_merge`, `mcp__GitHub__fetch`, `mcp__GitHub__fetch_blob`, `mcp__GitHub__fetch_commit`, `mcp__GitHub__fetch_commit_workflow_runs`, `mcp__GitHub__fetch_file`, `mcp__GitHub__fetch_issue`, `mcp__GitHub__fetch_issue_comments`, `mcp__GitHub__fetch_pr`, `mcp__GitHub__fetch_pr_comments`, `mcp__GitHub__fetch_pr_file_patch`, `mcp__GitHub__fetch_pr_patch`, `mcp__GitHub__fetch_workflow_job_logs`, `mcp__GitHub__fetch_workflow_job_steps`, `mcp__GitHub__fetch_workflow_run_artifacts`, `mcp__GitHub__fetch_workflow_run_jobs`, `mcp__GitHub__get_commit_combined_status`, `mcp__GitHub__get_issue_comment_reactions`, `mcp__GitHub__get_pr_diff`, `mcp__GitHub__get_pr_info`, `mcp__GitHub__get_pr_reactions`, `mcp__GitHub__get_pr_review_comment_reactions`, `mcp__GitHub__get_profile`, `mcp__GitHub__get_repo`, `mcp__GitHub__get_repo_collaborator_permission`, `mcp__GitHub__get_user_login`, `mcp__GitHub__get_users_recent_prs_in_repo`, `mcp__GitHub__label_pr`, `mcp__GitHub__list_installations`, `mcp__GitHub__list_installed_accounts`, `mcp__GitHub__list_pr_changed_filenames`, `mcp__GitHub__list_pull_request_review_threads`, `mcp__GitHub__list_pull_request_reviews`, `mcp__GitHub__list_recent_issues`, `mcp__GitHub__list_repositories`, `mcp__GitHub__list_repositories_by_affiliation`, `mcp__GitHub__list_repositories_by_installation`, `mcp__GitHub__list_user_org_memberships`, `mcp__GitHub__list_user_orgs`, `mcp__GitHub__lock_issue_conversation`, `mcp__GitHub__mark_pull_request_ready_for_review`, `mcp__GitHub__merge_pull_request`, `mcp__GitHub__remove_issue_assignees`, `mcp__GitHub__remove_issue_label`, `mcp__GitHub__remove_pull_request_reviewers`, `mcp__GitHub__remove_reaction_from_issue_comment`, `mcp__GitHub__remove_reaction_from_pr`, `mcp__GitHub__remove_reaction_from_pr_review_comment`, `mcp__GitHub__reply_to_review_comment`, `mcp__GitHub__request_pull_request_reviewers`, `mcp__GitHub__rerun_failed_workflow_run_jobs`, `mcp__GitHub__rerun_workflow_job`, `mcp__GitHub__resolve_review_thread`, `mcp__GitHub__search`, `mcp__GitHub__search_branches`, `mcp__GitHub__search_commits`, `mcp__GitHub__search_installed_repositories_streaming`, `mcp__GitHub__search_installed_repositories_v2`, `mcp__GitHub__search_issues`, `mcp__GitHub__search_prs`, `mcp__GitHub__search_repositories`, `mcp__GitHub__unlock_issue_conversation`, `mcp__GitHub__unresolve_review_thread`, `mcp__GitHub__update_file`, `mcp__GitHub__update_issue`, `mcp__GitHub__update_issue_comment`, `mcp__GitHub__update_pull_request`, `mcp__GitHub__update_ref`, `mcp__GitHub__update_review_comment`

### Gmail (20)

`mcp__Gmail__apply_sensitive_message_label`, `mcp__Gmail__apply_sensitive_thread_label`, `mcp__Gmail__create_draft`, `mcp__Gmail__create_label`, `mcp__Gmail__delete_label`, `mcp__Gmail__forward`, `mcp__Gmail__get_message`, `mcp__Gmail__get_profile`, `mcp__Gmail__get_thread`, `mcp__Gmail__label_message`, `mcp__Gmail__label_thread`, `mcp__Gmail__list_drafts`, `mcp__Gmail__list_labels`, `mcp__Gmail__reply`, `mcp__Gmail__search_threads`, `mcp__Gmail__send_message`, `mcp__Gmail__unlabel_message`, `mcp__Gmail__unlabel_thread`, `mcp__Gmail__update_draft`, `mcp__Gmail__update_label`

### Google_Calendar (10)

`mcp__Google_Calendar__create_event`, `mcp__Google_Calendar__delete_event`, `mcp__Google_Calendar__get_event`, `mcp__Google_Calendar__get_profile`, `mcp__Google_Calendar__list_calendars`, `mcp__Google_Calendar__list_events`, `mcp__Google_Calendar__respond_to_event`, `mcp__Google_Calendar__search_events`, `mcp__Google_Calendar__suggest_time`, `mcp__Google_Calendar__update_event`

### Hatchable (34)

`mcp__Hatchable__create_preview_link`, `mcp__Hatchable__create_project`, `mcp__Hatchable__delete_file`, `mcp__Hatchable__deploy`, `mcp__Hatchable__dry_run_deploy`, `mcp__Hatchable__execute_sql`, `mcp__Hatchable__fork_project`, `mcp__Hatchable__get_deployment`, `mcp__Hatchable__get_project`, `mcp__Hatchable__get_schema`, `mcp__Hatchable__grep`, `mcp__Hatchable__import_file_from_url`, `mcp__Hatchable__list_agent_tasks`, `mcp__Hatchable__list_cron_jobs`, `mcp__Hatchable__list_deployments`, `mcp__Hatchable__list_files`, `mcp__Hatchable__list_functions`, `mcp__Hatchable__list_pending_uploads`, `mcp__Hatchable__list_projects`, `mcp__Hatchable__list_skills`, `mcp__Hatchable__patch_file`, `mcp__Hatchable__read_file`, `mcp__Hatchable__read_skill`, `mcp__Hatchable__run_code`, `mcp__Hatchable__run_function`, `mcp__Hatchable__search_documentation`, `mcp__Hatchable__search_projects`, `mcp__Hatchable__submit_platform_feedback`, `mcp__Hatchable__update_agent_task`, `mcp__Hatchable__update_project`, `mcp__Hatchable__upload_file`, `mcp__Hatchable__view_logs`, `mcp__Hatchable__write_file`, `mcp__Hatchable__write_files`

### Linear (93)

`mcp__Linear__create_attachment`, `mcp__Linear__create_attachment_from_upload`, `mcp__Linear__create_initiative_label`, `mcp__Linear__create_issue_label`, `mcp__Linear__delete_attachment`, `mcp__Linear__delete_comment`, `mcp__Linear__delete_customer`, `mcp__Linear__delete_customer_need`, `mcp__Linear__delete_diff_comment`, `mcp__Linear__delete_review_criterion`, `mcp__Linear__delete_status_update`, `mcp__Linear__extract_images`, `mcp__Linear__fetch`, `mcp__Linear__get_agent_context`, `mcp__Linear__get_agent_skill`, `mcp__Linear__get_attachment`, `mcp__Linear__get_diff`, `mcp__Linear__get_diff_threads`, `mcp__Linear__get_document`, `mcp__Linear__get_initiative`, `mcp__Linear__get_issue`, `mcp__Linear__get_issue_status`, `mcp__Linear__get_milestone`, `mcp__Linear__get_notifications`, `mcp__Linear__get_project`, `mcp__Linear__get_release`, `mcp__Linear__get_release_note`, `mcp__Linear__get_status_updates`, `mcp__Linear__get_team`, `mcp__Linear__get_template`, `mcp__Linear__get_triage_responsibility`, `mcp__Linear__get_user`, `mcp__Linear__get_workspace`, `mcp__Linear__list_agent_skills`, `mcp__Linear__list_comments`, `mcp__Linear__list_custom_views`, `mcp__Linear__list_customer_needs`, `mcp__Linear__list_customers`, `mcp__Linear__list_cycles`, `mcp__Linear__list_diffs`, `mcp__Linear__list_documents`, `mcp__Linear__list_initiative_labels`, `mcp__Linear__list_initiatives`, `mcp__Linear__list_issue_labels`, `mcp__Linear__list_issue_statuses`, `mcp__Linear__list_issues`, `mcp__Linear__list_milestones`, `mcp__Linear__list_project_labels`, `mcp__Linear__list_projects`, `mcp__Linear__list_release_notes`, `mcp__Linear__list_release_pipelines`, `mcp__Linear__list_releases`, `mcp__Linear__list_review_criteria`, `mcp__Linear__list_teams`, `mcp__Linear__list_templates`, `mcp__Linear__list_users`, `mcp__Linear__mark_notification`, `mcp__Linear__merge_diff`, `mcp__Linear__prepare_attachment_upload`, `mcp__Linear__prepare_file_upload`, `mcp__Linear__record_agent_learning`, `mcp__Linear__report_agent_friction`, `mcp__Linear__report_helpful_agent_context`, `mcp__Linear__resolve_diff_thread`, `mcp__Linear__restore_initiative_label`, `mcp__Linear__restore_issue_label`, `mcp__Linear__restore_project_label`, `mcp__Linear__retire_initiative_label`, `mcp__Linear__retire_issue_label`, `mcp__Linear__retire_project_label`, `mcp__Linear__save_comment`, `mcp__Linear__save_customer`, `mcp__Linear__save_customer_need`, `mcp__Linear__save_diff_comment`, `mcp__Linear__save_document`, `mcp__Linear__save_initiative`, `mcp__Linear__save_initiative_label`, `mcp__Linear__save_issue`, `mcp__Linear__save_issue_label`, `mcp__Linear__save_milestone`, `mcp__Linear__save_project`, `mcp__Linear__save_project_label`, `mcp__Linear__save_release`, `mcp__Linear__save_release_note`, `mcp__Linear__save_status_update`, `mcp__Linear__search`, `mcp__Linear__search_documentation`, `mcp__Linear__share_issue`, `mcp__Linear__submit_diff_review`, `mcp__Linear__unshare_issue`, `mcp__Linear__update_diff`, `mcp__Linear__update_diff_finding`, `mcp__Linear__whoami`

### Neon (141)

`mcp__Neon__add_auth_oauth_provider`, `mcp__Neon__add_auth_trusted_domain`, `mcp__Neon__compare_database_schema`, `mcp__Neon__complete_database_migration`, `mcp__Neon__complete_query_tuning`, `mcp__Neon__count_projects`, `mcp__Neon__create_auth_oauth_client`, `mcp__Neon__create_auth_user`, `mcp__Neon__create_branch`, `mcp__Neon__create_credential`, `mcp__Neon__create_postgres_database`, `mcp__Neon__create_postgres_endpoint`, `mcp__Neon__create_postgres_role`, `mcp__Neon__create_project`, `mcp__Neon__create_snapshot`, `mcp__Neon__create_storage_bucket`, `mcp__Neon__create_trigger`, `mcp__Neon__delete_auth_oauth_client`, `mcp__Neon__delete_auth_oauth_provider`, `mcp__Neon__delete_auth_trusted_domain`, `mcp__Neon__delete_auth_user`, `mcp__Neon__delete_branch`, `mcp__Neon__delete_data_api`, `mcp__Neon__delete_function`, `mcp__Neon__delete_functions_custom_domain`, `mcp__Neon__delete_postgres_database`, `mcp__Neon__delete_postgres_endpoint`, `mcp__Neon__delete_postgres_role`, `mcp__Neon__delete_project`, `mcp__Neon__delete_snapshot`, `mcp__Neon__delete_storage_bucket`, `mcp__Neon__delete_storage_object`, `mcp__Neon__delete_storage_objects_by_prefix`, `mcp__Neon__delete_trigger`, `mcp__Neon__deploy_function`, `mcp__Neon__describe_branch`, `mcp__Neon__describe_project`, `mcp__Neon__describe_table_schema`, `mcp__Neon__disable_auth`, `mcp__Neon__disable_realtime`, `mcp__Neon__enable_realtime`, `mcp__Neon__explain_sql_statement`, `mcp__Neon__fetch`, `mcp__Neon__finalize_branch_restore`, `mcp__Neon__get_ai_gateway`, `mcp__Neon__get_auth`, `mcp__Neon__get_auth_oauth_client`, `mcp__Neon__get_auth_oauth_server`, `mcp__Neon__get_branch`, `mcp__Neon__get_branch_consumption`, `mcp__Neon__get_connection_string`, `mcp__Neon__get_data_api`, `mcp__Neon__get_database_tables`, `mcp__Neon__get_default_branch`, `mcp__Neon__get_doc`, `mcp__Neon__get_function`, `mcp__Neon__get_neon_auth_config`, `mcp__Neon__get_operation`, `mcp__Neon__get_postgres_database`, `mcp__Neon__get_postgres_endpoint`, `mcp__Neon__get_postgres_role`, `mcp__Neon__get_project_consumption`, `mcp__Neon__get_realtime`, `mcp__Neon__get_realtime_secret`, `mcp__Neon__get_snapshot_schedule`, `mcp__Neon__get_storage`, `mcp__Neon__get_trigger`, `mcp__Neon__inspect_database`, `mcp__Neon__list_auth_oauth_clients`, `mcp__Neon__list_auth_oauth_providers`, `mcp__Neon__list_auth_trusted_domains`, `mcp__Neon__list_branch_computes`, `mcp__Neon__list_branches`, `mcp__Neon__list_credentials`, `mcp__Neon__list_functions`, `mcp__Neon__list_functions_custom_domains`, `mcp__Neon__list_incidents`, `mcp__Neon__list_log_field_values`, `mcp__Neon__list_log_fields`, `mcp__Neon__list_operations`, `mcp__Neon__list_organizations`, `mcp__Neon__list_postgres_databases`, `mcp__Neon__list_postgres_endpoints`, `mcp__Neon__list_postgres_roles`, `mcp__Neon__list_project_members`, `mcp__Neon__list_project_permissions`, `mcp__Neon__list_projects`, `mcp__Neon__list_regions`, `mcp__Neon__list_slow_queries`, `mcp__Neon__list_snapshots`, `mcp__Neon__list_storage_buckets`, `mcp__Neon__list_storage_objects`, `mcp__Neon__list_triggers`, `mcp__Neon__prepare_database_migration`, `mcp__Neon__prepare_query_tuning`, `mcp__Neon__presign_storage_object`, `mcp__Neon__provision_neon_auth`, `mcp__Neon__provision_neon_data_api`, `mcp__Neon__query_logs`, `mcp__Neon__query_loki_logs`, `mcp__Neon__recover_project`, `mcp__Neon__register_functions_custom_domain`, `mcp__Neon__reset_from_parent`, `mcp__Neon__reset_postgres_role_password`, `mcp__Neon__restart_postgres_endpoint`, `mcp__Neon__restore_snapshot`, `mcp__Neon__revoke_credential`, `mcp__Neon__rotate_auth_oauth_client_secret`, `mcp__Neon__rotate_credential`, `mcp__Neon__rotate_realtime_secret`, `mcp__Neon__run_sql`, `mcp__Neon__run_sql_transaction`, `mcp__Neon__search`, `mcp__Neon__search_docs`, `mcp__Neon__send_auth_test_email`, `mcp__Neon__send_feedback`, `mcp__Neon__set_default_branch`, `mcp__Neon__set_snapshot_schedule`, `mcp__Neon__start_postgres_endpoint`, `mcp__Neon__suspend_postgres_endpoint`, `mcp__Neon__update_auth_allow_localhost`, `mcp__Neon__update_auth_config`, `mcp__Neon__update_auth_email_and_password`, `mcp__Neon__update_auth_email_provider`, `mcp__Neon__update_auth_logs_export`, `mcp__Neon__update_auth_oauth_client`, `mcp__Neon__update_auth_oauth_provider`, `mcp__Neon__update_auth_oauth_server`, `mcp__Neon__update_auth_plugins_magic_link`, `mcp__Neon__update_auth_plugins_organization`, `mcp__Neon__update_auth_plugins_phone_number`, `mcp__Neon__update_auth_user_role`, `mcp__Neon__update_auth_webhooks`, `mcp__Neon__update_branch`, `mcp__Neon__update_data_api`, `mcp__Neon__update_function`, `mcp__Neon__update_postgres_database`, `mcp__Neon__update_postgres_endpoint`, `mcp__Neon__update_project`, `mcp__Neon__update_snapshot`, `mcp__Neon__update_trigger`

### Plugin_Creator (9)

`mcp__Plugin_Creator__create_plugin`, `mcp__Plugin_Creator__get_owned_plugin_archive`, `mcp__Plugin_Creator__get_plugin_files`, `mcp__Plugin_Creator__get_plugin_metadata`, `mcp__Plugin_Creator__get_plugin_sharing`, `mcp__Plugin_Creator__list_owned_personal_plugins`, `mcp__Plugin_Creator__list_plugin_releases`, `mcp__Plugin_Creator__share_plugin`, `mcp__Plugin_Creator__update_plugin`

### Plugin_Management (4)

`mcp__Plugin_Management__get_app_permissions`, `mcp__Plugin_Management__get_plugin_dependencies`, `mcp__Plugin_Management__uninstall_app`, `mcp__Plugin_Management__update_app_permissions`

### Remote_Desktop_Commander (30)

`mcp__Remote_Desktop_Commander__create_directory`, `mcp__Remote_Desktop_Commander__edit_block`, `mcp__Remote_Desktop_Commander__force_terminate`, `mcp__Remote_Desktop_Commander__get_config`, `mcp__Remote_Desktop_Commander__get_file_info`, `mcp__Remote_Desktop_Commander__get_more_search_results`, `mcp__Remote_Desktop_Commander__get_recent_tool_calls`, `mcp__Remote_Desktop_Commander__get_tool_result`, `mcp__Remote_Desktop_Commander__get_usage_stats`, `mcp__Remote_Desktop_Commander__interact_with_process`, `mcp__Remote_Desktop_Commander__kill_process`, `mcp__Remote_Desktop_Commander__list_devices`, `mcp__Remote_Desktop_Commander__list_directory`, `mcp__Remote_Desktop_Commander__list_processes`, `mcp__Remote_Desktop_Commander__list_remote_tool_calls`, `mcp__Remote_Desktop_Commander__list_searches`, `mcp__Remote_Desktop_Commander__list_sessions`, `mcp__Remote_Desktop_Commander__move_file`, `mcp__Remote_Desktop_Commander__read_file`, `mcp__Remote_Desktop_Commander__read_multiple_files`, `mcp__Remote_Desktop_Commander__read_process_output`, `mcp__Remote_Desktop_Commander__review_device_call`, `mcp__Remote_Desktop_Commander__set_config_value`, `mcp__Remote_Desktop_Commander__shutdown`, `mcp__Remote_Desktop_Commander__start_process`, `mcp__Remote_Desktop_Commander__start_search`, `mcp__Remote_Desktop_Commander__stop_search`, `mcp__Remote_Desktop_Commander__who_am_i`, `mcp__Remote_Desktop_Commander__write_file`, `mcp__Remote_Desktop_Commander__write_pdf`

### Render (48)

`mcp__Render__approve_blueprint`, `mcp__Render__cancel_cron_job_run`, `mcp__Render__cancel_flow_run`, `mcp__Render__create_blueprint`, `mcp__Render__create_cron_job`, `mcp__Render__create_key_value`, `mcp__Render__create_postgres`, `mcp__Render__create_static_site`, `mcp__Render__create_web_service`, `mcp__Render__create_workflow`, `mcp__Render__create_workflow_version`, `mcp__Render__get_blueprint`, `mcp__Render__get_deploy`, `mcp__Render__get_flow`, `mcp__Render__get_flow_run`, `mcp__Render__get_flow_run_results`, `mcp__Render__get_flow_run_step`, `mcp__Render__get_key_value`, `mcp__Render__get_metrics`, `mcp__Render__get_postgres`, `mcp__Render__get_selected_workspace`, `mcp__Render__get_service`, `mcp__Render__get_workflow`, `mcp__Render__get_workflow_run`, `mcp__Render__get_workflow_run_results`, `mcp__Render__get_workflow_task`, `mcp__Render__get_workflow_version`, `mcp__Render__list_deploys`, `mcp__Render__list_events`, `mcp__Render__list_flow_run_steps`, `mcp__Render__list_flow_runs`, `mcp__Render__list_key_value`, `mcp__Render__list_log_label_values`, `mcp__Render__list_logs`, `mcp__Render__list_postgres_instances`, `mcp__Render__list_services`, `mcp__Render__list_workflow_runs`, `mcp__Render__list_workflow_tasks`, `mcp__Render__list_workflow_versions`, `mcp__Render__list_workflows`, `mcp__Render__list_workspaces`, `mcp__Render__plan_blueprint`, `mcp__Render__query_render_postgres`, `mcp__Render__run_cron_job`, `mcp__Render__select_workspace`, `mcp__Render__trigger_deploy`, `mcp__Render__update_blueprint`, `mcp__Render__update_environment_variables`

### Replit (8)

`mcp__Replit__ask_question`, `mcp__Replit__create_app_from_prompt`, `mcp__Replit__get_publish_status`, `mcp__Replit__list_apps`, `mcp__Replit__publish_app`, `mcp__Replit__resolve_app_by_name`, `mcp__Replit__search_apps`, `mcp__Replit__update_app_using_prompt`

### skills (2)

`skills__list`, `skills__read`

### Supabase (36)

`mcp__Supabase__apply_migration`, `mcp__Supabase__confirm_cost`, `mcp__Supabase__create_branch`, `mcp__Supabase__create_notebook`, `mcp__Supabase__create_project`, `mcp__Supabase__delete_branch`, `mcp__Supabase__delete_feedback`, `mcp__Supabase__delete_notebook`, `mcp__Supabase__deploy_edge_function`, `mcp__Supabase__execute_sql`, `mcp__Supabase__generate_typescript_types`, `mcp__Supabase__get_advisors`, `mcp__Supabase__get_cost`, `mcp__Supabase__get_edge_function`, `mcp__Supabase__get_notebook`, `mcp__Supabase__get_organization`, `mcp__Supabase__get_project`, `mcp__Supabase__get_project_url`, `mcp__Supabase__get_publishable_keys`, `mcp__Supabase__list_branches`, `mcp__Supabase__list_edge_functions`, `mcp__Supabase__list_extensions`, `mcp__Supabase__list_migrations`, `mcp__Supabase__list_notebooks`, `mcp__Supabase__list_organizations`, `mcp__Supabase__list_projects`, `mcp__Supabase__list_tables`, `mcp__Supabase__merge_branch`, `mcp__Supabase__pause_project`, `mcp__Supabase__query_logs`, `mcp__Supabase__rebase_branch`, `mcp__Supabase__reset_branch`, `mcp__Supabase__restore_project`, `mcp__Supabase__run_notebook`, `mcp__Supabase__search_docs`, `mcp__Supabase__submit_feedback`

### Todoist (49)

`mcp__Todoist__To_Do_List___Calendar__add_comments`, `mcp__Todoist__To_Do_List___Calendar__add_filters`, `mcp__Todoist__To_Do_List___Calendar__add_labels`, `mcp__Todoist__To_Do_List___Calendar__add_projects`, `mcp__Todoist__To_Do_List___Calendar__add_reminders`, `mcp__Todoist__To_Do_List___Calendar__add_sections`, `mcp__Todoist__To_Do_List___Calendar__add_tasks`, `mcp__Todoist__To_Do_List___Calendar__analyze_project_health`, `mcp__Todoist__To_Do_List___Calendar__complete_tasks`, `mcp__Todoist__To_Do_List___Calendar__delete_object`, `mcp__Todoist__To_Do_List___Calendar__export_project_template`, `mcp__Todoist__To_Do_List___Calendar__fetch`, `mcp__Todoist__To_Do_List___Calendar__fetch_object`, `mcp__Todoist__To_Do_List___Calendar__find_activity`, `mcp__Todoist__To_Do_List___Calendar__find_comments`, `mcp__Todoist__To_Do_List___Calendar__find_completed_tasks`, `mcp__Todoist__To_Do_List___Calendar__find_filters`, `mcp__Todoist__To_Do_List___Calendar__find_labels`, `mcp__Todoist__To_Do_List___Calendar__find_project_collaborators`, `mcp__Todoist__To_Do_List___Calendar__find_projects`, `mcp__Todoist__To_Do_List___Calendar__find_reminders`, `mcp__Todoist__To_Do_List___Calendar__find_sections`, `mcp__Todoist__To_Do_List___Calendar__find_tasks`, `mcp__Todoist__To_Do_List___Calendar__find_tasks_by_date`, `mcp__Todoist__To_Do_List___Calendar__get_overview`, `mcp__Todoist__To_Do_List___Calendar__get_productivity_stats`, `mcp__Todoist__To_Do_List___Calendar__get_project_activity_stats`, `mcp__Todoist__To_Do_List___Calendar__get_project_health`, `mcp__Todoist__To_Do_List___Calendar__get_user_status`, `mcp__Todoist__To_Do_List___Calendar__get_workspace_insights`, `mcp__Todoist__To_Do_List___Calendar__import_project_template`, `mcp__Todoist__To_Do_List___Calendar__list_workspaces`, `mcp__Todoist__To_Do_List___Calendar__manage_assignments`, `mcp__Todoist__To_Do_List___Calendar__project_management`, `mcp__Todoist__To_Do_List___Calendar__project_move`, `mcp__Todoist__To_Do_List___Calendar__reorder_objects`, `mcp__Todoist__To_Do_List___Calendar__reschedule_tasks`, `mcp__Todoist__To_Do_List___Calendar__search`, `mcp__Todoist__To_Do_List___Calendar__set_user_status`, `mcp__Todoist__To_Do_List___Calendar__uncomplete_tasks`, `mcp__Todoist__To_Do_List___Calendar__update_comments`, `mcp__Todoist__To_Do_List___Calendar__update_filters`, `mcp__Todoist__To_Do_List___Calendar__update_labels`, `mcp__Todoist__To_Do_List___Calendar__update_projects`, `mcp__Todoist__To_Do_List___Calendar__update_reminders`, `mcp__Todoist__To_Do_List___Calendar__update_sections`, `mcp__Todoist__To_Do_List___Calendar__update_tasks`, `mcp__Todoist__To_Do_List___Calendar__user_info`, `mcp__Todoist__To_Do_List___Calendar__view_attachment`

### Trello (15)

`mcp__Trello__trelloReadBoard`, `mcp__Trello__trelloReadCard`, `mcp__Trello__trelloReadChecklist`, `mcp__Trello__trelloReadInbox`, `mcp__Trello__trelloReadList`, `mcp__Trello__trelloReadMember`, `mcp__Trello__trelloReadPlanner`, `mcp__Trello__trelloReadWorkspace`, `mcp__Trello__trelloSearch`, `mcp__Trello__trelloWriteBoard`, `mcp__Trello__trelloWriteCard`, `mcp__Trello__trelloWriteChecklist`, `mcp__Trello__trelloWriteInbox`, `mcp__Trello__trelloWriteList`, `mcp__Trello__trelloWritePlanner`

### user_settings (2)

`user_settings__get_user_settings`, `user_settings__set_setting`

### Vercel (260)

`mcp__Vercel__accept_project_transfer_request`, `mcp__Vercel__activate_kms_signing_key`, `mcp__Vercel__add_project_domain`, `mcp__Vercel__add_route`, `mcp__Vercel__add_toolbar_reaction`, `mcp__Vercel__aggregate_events`, `mcp__Vercel__aggregate_pageviews`, `mcp__Vercel__approve_rolling_release_stage`, `mcp__Vercel__artifact_query`, `mcp__Vercel__assign_alias`, `mcp__Vercel__authorize_team_access`, `mcp__Vercel__authorize_team_sso`, `mcp__Vercel__buy_domain`, `mcp__Vercel__cancel_deployment`, `mcp__Vercel__change_toolbar_thread_resolve_status`, `mcp__Vercel__complete_rolling_release`, `mcp__Vercel__count_events`, `mcp__Vercel__count_pageviews`, `mcp__Vercel__create_deployment`, `mcp__Vercel__create_drain`, `mcp__Vercel__create_edge_config`, `mcp__Vercel__create_edge_config_token`, `mcp__Vercel__create_flag`, `mcp__Vercel__create_flags_project_connection`, `mcp__Vercel__create_git_project`, `mcp__Vercel__create_kms_issuer`, `mcp__Vercel__create_kms_issuer_policy`, `mcp__Vercel__create_kms_signing_key`, `mcp__Vercel__create_observability_query`, `mcp__Vercel__create_or_transfer_domain`, `mcp__Vercel__create_project`, `mcp__Vercel__create_project_env`, `mcp__Vercel__create_record`, `mcp__Vercel__create_sandboxes_sessions_by_session_id_snapshot_v2`, `mcp__Vercel__create_sandboxes_sessions_by_session_id_snapshot_v3`, `mcp__Vercel__create_sandboxes_v2`, `mcp__Vercel__create_sandboxes_v3`, `mcp__Vercel__create_sandboxes_v4`, `mcp__Vercel__create_sdk_key`, `mcp__Vercel__create_session_directory`, `mcp__Vercel__create_storage_stores_blob`, `mcp__Vercel__create_trace_session`, `mcp__Vercel__delete_drive`, `mcp__Vercel__delete_sandbox`, `mcp__Vercel__delete_session_snapshot`, `mcp__Vercel__edit_project_env`, `mcp__Vercel__edit_route`, `mcp__Vercel__edit_toolbar_message`, `mcp__Vercel__extend_session_timeout`, `mcp__Vercel__filter_project_envs`, `mcp__Vercel__generate_route`, `mcp__Vercel__get_access_to_vercel_url`, `mcp__Vercel__get_active_attack_status`, `mcp__Vercel__get_agent_run`, `mcp__Vercel__get_agent_run_trace`, `mcp__Vercel__get_ai_gateway_leaderboard`, `mcp__Vercel__get_ai_gateway_model`, `mcp__Vercel__get_ai_gateway_usage`, `mcp__Vercel__get_alias`, `mcp__Vercel__get_auth_user`, `mcp__Vercel__get_board_identity`, `mcp__Vercel__get_board_thread`, `mcp__Vercel__get_bulk_availability`, `mcp__Vercel__get_bulk_price`, `mcp__Vercel__get_bypass_ip`, `mcp__Vercel__get_cert_by_id`, `mcp__Vercel__get_configuration`, `mcp__Vercel__get_connector`, `mcp__Vercel__get_connector_project_connection`, `mcp__Vercel__get_contact_info_schema`, `mcp__Vercel__get_custom_environment`, `mcp__Vercel__get_deployment`, `mcp__Vercel__get_deployment_feature_flags`, `mcp__Vercel__get_deployment_file_contents`, `mcp__Vercel__get_domain`, `mcp__Vercel__get_domain_availability`, `mcp__Vercel__get_domain_config`, `mcp__Vercel__get_domain_contact_verification`, `mcp__Vercel__get_domain_order`, `mcp__Vercel__get_domain_price`, `mcp__Vercel__get_domain_project_domains`, `mcp__Vercel__get_domain_verification_record`, `mcp__Vercel__get_domains_records_by_record_id`, `mcp__Vercel__get_drain`, `mcp__Vercel__get_edge_config`, `mcp__Vercel__get_edge_config_backup`, `mcp__Vercel__get_edge_config_backups`, `mcp__Vercel__get_edge_config_item`, `mcp__Vercel__get_edge_config_items`, `mcp__Vercel__get_edge_config_token`, `mcp__Vercel__get_edge_config_tokens`, `mcp__Vercel__get_edge_configs`, `mcp__Vercel__get_firewall_config`, `mcp__Vercel__get_flag`, `mcp__Vercel__get_flag_segment`, `mcp__Vercel__get_flag_settings`, `mcp__Vercel__get_flags_project_disconnection_link`, `mcp__Vercel__get_git_deployment_context`, `mcp__Vercel__get_kms_issuer`, `mcp__Vercel__get_microfrontends_config`, `mcp__Vercel__get_microfrontends_config_for_project`, `mcp__Vercel__get_named_sandbox`, `mcp__Vercel__get_observability_configuration_projects`, `mcp__Vercel__get_observability_schema`, `mcp__Vercel__get_or_create_drive`, `mcp__Vercel__get_order`, `mcp__Vercel__get_project`, `mcp__Vercel__get_project_deletion_link`, `mcp__Vercel__get_project_domain`, `mcp__Vercel__get_project_env`, `mcp__Vercel__get_project_trace`, `mcp__Vercel__get_purchase_quote`, `mcp__Vercel__get_records`, `mcp__Vercel__get_remote_cache_status`, `mcp__Vercel__get_rolling_release`, `mcp__Vercel__get_rolling_release_billing_status`, `mcp__Vercel__get_rolling_release_config`, `mcp__Vercel__get_runtime_errors`, `mcp__Vercel__get_runtime_logs`, `mcp__Vercel__get_session`, `mcp__Vercel__get_session_command`, `mcp__Vercel__get_session_command_logs`, `mcp__Vercel__get_session_snapshot`, `mcp__Vercel__get_shared_env_var`, `mcp__Vercel__get_storage_stores_by_id`, `mcp__Vercel__get_team`, `mcp__Vercel__get_tld`, `mcp__Vercel__get_tld_price`, `mcp__Vercel__get_toolbar_thread`, `mcp__Vercel__get_vercel_ci_invocation`, `mcp__Vercel__get_vercel_ci_invocation_logs`, `mcp__Vercel__get_vercel_ci_invocation_tree`, `mcp__Vercel__get_vercel_ci_job_definition`, `mcp__Vercel__get_vercel_ci_job_run`, `mcp__Vercel__get_vercel_ci_job_run_logs`, `mcp__Vercel__get_vercel_ci_task_logs`, `mcp__Vercel__get_vercel_ci_task_run_logs`, `mcp__Vercel__get_webhooks`, `mcp__Vercel__git_namespaces`, `mcp__Vercel__invalidate_by_src_images`, `mcp__Vercel__invalidate_by_tags`, `mcp__Vercel__issue_cert`, `mcp__Vercel__kill_session_command`, `mcp__Vercel__label_board_message`, `mcp__Vercel__list_access_group_members`, `mcp__Vercel__list_access_group_projects`, `mcp__Vercel__list_access_groups`, `mcp__Vercel__list_agent_run_projects`, `mcp__Vercel__list_agent_runs`, `mcp__Vercel__list_ai_gateway_models`, `mcp__Vercel__list_aliases`, `mcp__Vercel__list_billing_charges`, `mcp__Vercel__list_board_channels`, `mcp__Vercel__list_board_threads`, `mcp__Vercel__list_bulk_redirect_versions`, `mcp__Vercel__list_bulk_redirects`, `mcp__Vercel__list_certs`, `mcp__Vercel__list_connector_project_connections`, `mcp__Vercel__list_connectors`, `mcp__Vercel__list_contract_commitments`, `mcp__Vercel__list_deployment_aliases`, `mcp__Vercel__list_deployment_events`, `mcp__Vercel__list_deployment_files`, `mcp__Vercel__list_deployments`, `mcp__Vercel__list_domains`, `mcp__Vercel__list_drains`, `mcp__Vercel__list_drives`, `mcp__Vercel__list_event_types`, `mcp__Vercel__list_feature_flag_sdk_keys`, `mcp__Vercel__list_flag_segments`, `mcp__Vercel__list_flag_versions`, `mcp__Vercel__list_flags`, `mcp__Vercel__list_flags_project_connections`, `mcp__Vercel__list_flags_v2`, `mcp__Vercel__list_integration_billing_plans`, `mcp__Vercel__list_integration_configuration_products`, `mcp__Vercel__list_integration_configurations`, `mcp__Vercel__list_kms_issuers`, `mcp__Vercel__list_named_sandboxes`, `mcp__Vercel__list_project_connector_connections`, `mcp__Vercel__list_project_custom_environments`, `mcp__Vercel__list_project_domains`, `mcp__Vercel__list_project_route_versions`, `mcp__Vercel__list_project_routes`, `mcp__Vercel__list_projects`, `mcp__Vercel__list_promote_aliases`, `mcp__Vercel__list_session_commands`, `mcp__Vercel__list_session_snapshots`, `mcp__Vercel__list_sessions`, `mcp__Vercel__list_supported_tlds`, `mcp__Vercel__list_team_flag_settings`, `mcp__Vercel__list_team_flags`, `mcp__Vercel__list_team_flags_v2`, `mcp__Vercel__list_team_members`, `mcp__Vercel__list_teams`, `mcp__Vercel__list_toolbar_threads`, `mcp__Vercel__list_user_events`, `mcp__Vercel__list_vercel_ci_invocation_attempts`, `mcp__Vercel__list_vercel_ci_invocations`, `mcp__Vercel__list_vercel_ci_job_definitions`, `mcp__Vercel__list_vercel_ci_job_runs`, `mcp__Vercel__list_vercel_ci_task_definitions`, `mcp__Vercel__list_vercel_ci_task_runs`, `mcp__Vercel__open_deployments`, `mcp__Vercel__patch_edge_config_items`, `mcp__Vercel__patch_url_protection_bypass`, `mcp__Vercel__pause_project`, `mcp__Vercel__put_firewall_config`, `mcp__Vercel__react_to_board_message`, `mcp__Vercel__read_access_group`, `mcp__Vercel__read_access_group_project`, `mcp__Vercel__read_session_file`, `mcp__Vercel__record_events`, `mcp__Vercel__replace_domain_dns_records`, `mcp__Vercel__reply_to_board_thread`, `mcp__Vercel__reply_to_toolbar_thread`, `mcp__Vercel__request_promote`, `mcp__Vercel__request_rollback`, `mcp__Vercel__rerequest_check`, `mcp__Vercel__restore_edge_config_backup`, `mcp__Vercel__restore_redirects`, `mcp__Vercel__retry_vercel_ci_invocation`, `mcp__Vercel__revoke_kms_signing_key`, `mcp__Vercel__run_session_command`, `mcp__Vercel__search_domains`, `mcp__Vercel__search_repo`, `mcp__Vercel__search_vercel_documentation`, `mcp__Vercel__stage_redirects`, `mcp__Vercel__stage_routes`, `mcp__Vercel__start_board_thread`, `mcp__Vercel__start_rolling_release`, `mcp__Vercel__stop_session`, `mcp__Vercel__submit_feedback`, `mcp__Vercel__test_drain`, `mcp__Vercel__unpause_project`, `mcp__Vercel__update_attack_challenge_mode`, `mcp__Vercel__update_bulk_redirect_version`, `mcp__Vercel__update_connector`, `mcp__Vercel__update_drain`, `mcp__Vercel__update_edge_config`, `mcp__Vercel__update_firewall_config`, `mcp__Vercel__update_flag`, `mcp__Vercel__update_flag_segment`, `mcp__Vercel__update_flag_settings`, `mcp__Vercel__update_kms_issuer`, `mcp__Vercel__update_kms_issuer_policy`, `mcp__Vercel__update_project`, `mcp__Vercel__update_project_protection_bypass`, `mcp__Vercel__update_record`, `mcp__Vercel__update_rolling_release_config`, `mcp__Vercel__update_route_versions`, `mcp__Vercel__update_sandbox`, `mcp__Vercel__update_session_network_policy`, `mcp__Vercel__upload_artifact`, `mcp__Vercel__upload_file`, `mcp__Vercel__upsert_connector_project_connection`, `mcp__Vercel__verify_project_domain`, `mcp__Vercel__wait_for_board_changes`, `mcp__Vercel__web_fetch_vercel_url`, `mcp__Vercel__write_session_files`

### Webflow (38)

`mcp__Webflow__ask_webflow_ai`, `mcp__Webflow__asset_tool`, `mcp__Webflow__data_aeo_tool`, `mcp__Webflow__data_agent_instructions_tool`, `mcp__Webflow__data_analyze_tool`, `mcp__Webflow__data_apps_tool`, `mcp__Webflow__data_assets_tool`, `mcp__Webflow__data_campaigns_tool`, `mcp__Webflow__data_cms_tool`, `mcp__Webflow__data_comments_tool`, `mcp__Webflow__data_component_builder`, `mcp__Webflow__data_component_props_tool`, `mcp__Webflow__data_component_tool`, `mcp__Webflow__data_component_variants_tool`, `mcp__Webflow__data_element_builder`, `mcp__Webflow__data_element_settings_tool`, `mcp__Webflow__data_element_tool`, `mcp__Webflow__data_enterprise_tool`, `mcp__Webflow__data_fonts_tool`, `mcp__Webflow__data_forms_tool`, `mcp__Webflow__data_interactions_tool`, `mcp__Webflow__data_localization_tool`, `mcp__Webflow__data_members_tool`, `mcp__Webflow__data_optimize_tool`, `mcp__Webflow__data_pages_tool`, `mcp__Webflow__data_scripts_tool`, `mcp__Webflow__data_sitemap_tool`, `mcp__Webflow__data_sites_tool`, `mcp__Webflow__data_style_tool`, `mcp__Webflow__data_variable_tool`, `mcp__Webflow__data_webhook_tool`, `mcp__Webflow__data_whtml_builder`, `mcp__Webflow__designer_tool`, `mcp__Webflow__element_snapshot_tool`, `mcp__Webflow__get_asset_preview`, `mcp__Webflow__get_more_tools`, `mcp__Webflow__webflow_guide_tool`, `mcp__Webflow__webflow_home`

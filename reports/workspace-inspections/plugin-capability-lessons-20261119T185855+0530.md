# cURL AI Bridge — Plugin Capability Lessons
## Scheduled discovery checkpoint 11

**Run timestamp:** 2026-11-19 18:58:55 +0530  
**Runtime:** ChatGPT tool-enabled automation; Desktop Commander device `sunilkr-H81` (`6f9a336b-2280-4e52-bcd0-0b1b3426e948`), Linux, Desktop Commander 0.3.4, Node.js 22.23.4, Python 3.14.4, default shell `/bin/bash`.  
**Scope:** bounded plugin/skill discovery, project-scoped reads, local Git pre-state, and one new report. No implementation authorization.

## 1. Executive result

- **945 tool actions / 21 namespaces** were exposed by the runtime's `ALL_TOOLS` inventory.
- Native `skills__list` returned **0 skill roots**. This is an observed empty result, not proof that no plugin documentation exists.
- Hatchable's separate platform registry returned **57 platform skills**; **11 unique guides** were read. These are Hatchable platform guides, not 57 installed ChatGPT plugins.
- Linear's `list_agent_skills` returned **0** entries.
- Thirteen named app-permission lookups returned **10 found** and **3 not_installed**. Permission metadata does not establish OAuth scopes or resource authentication.
- Project-scoped reads succeeded for GitHub, Dropbox, Linear identity/search, and the Desktop Commander device/workspace.
- No provider inference, model invocation, worker dispatch, quota consumption, plugin-connected data mutation, Git mutation, or permission/auth change occurred.

## 2. Catalog and runtime evidence

### 2.1 Skill/catalog layers

**Native ChatGPT skills:** `skills__list({})` returned an empty array (0 entries). `skills__read` is exposed but no native skill URI was available; no URI was guessed.

**Hatchable platform skill registry:** `mcp__Hatchable__list_skills({})` returned `count=57`. Eleven unique guides were read using exact registry names:

- `ai/build-an-agent-with-tools`
- `ai/inspect-llm-call-history`
- `ai/use-a-provider-directly`
- `api/access`
- `api/stream-a-response`
- `mcp/expose-an-mcp-tool`
- `integrations/verify-a-webhook`
- `integrations/connect-an-external-api`
- `data/query-with-pagination`
- `meta/platform-constraints`
- `background/defer-with-scheduler`

**Linear agent skills:** `mcp__Linear__list_agent_skills({})` returned `agentSkills=[]`, `hasNextPage=false`.

**Complete Hatchable registry (57 names):**
- `recognize-the-project-admin`
- `add-a-knowledge-base`
- `add-an-llm-endpoint`
- `add-rag-search`
- `build-an-agent-with-tools`
- `inspect-llm-call-history`
- `show-ai-spend`
- `use-a-provider-directly`
- `access`
- `add-an-api-route`
- `proxy-an-external-api`
- `scheduler`
- `stream-a-response`
- `add-google-signin`
- `build-a-login-page`
- `enable-app-auth`
- `gate-an-endpoint`
- `handle-the-anonymous-case`
- `handle-user-deletion`
- `add-a-cron-job`
- `add-a-scheduled-digest`
- `defer-with-scheduler`
- `scrape-a-page`
- `take-a-screenshot`
- `declare-configurable-fields`
- `read-config-values`
- `add-a-table`
- `one-off-backfill`
- `query-with-pagination`
- `row-access`
- `transactions`
- `write-a-safe-migration`
- `apply-house-design`
- `send-transactional-email`
- `connect-an-external-api`
- `verify-a-webhook`
- `expose-an-mcp-tool`
- `file-platform-feedback`
- `platform-constraints`
- `debug-a-failing-deploy`
- `deploy-the-project`
- `inspect-the-schema`
- `read-the-logs`
- `add-a-form-and-handle-it`
- `add-a-page`
- `add-react-and-htm-spa`
- `server-render-a-page`
- `share-design-tokens`
- `write-host-aware-urls`
- `export-project-data`
- `fork-from-canonical`
- `handle-agent-tasks`
- `set-environment-variables`
- `publish-and-subscribe`
- `accept-a-file-upload`
- `expire-files-with-tmp`
- `serve-stored-files`

### 2.2 Tool namespace counts

- `user_settings`: 2
- `Google_Calendar`: 10
- `Gmail`: 20
- `GitHub`: 89
- `Replit`: 8
- `Remote_Desktop_Commander`: 30
- `Webflow`: 38
- `Todoist`: 49
- `Plugin_Creator`: 9
- `Render`: 48
- `Supabase`: 36
- `Neon`: 141
- `Hatchable`: 34
- `Dropbox`: 39
- `Linear`: 93
- `Trello`: 15
- `Vercel`: 260
- `Automations`: 7
- `Plugin_Management`: 4
- `files`: 11
- `skills`: 2

Total: **945 actions across 21 namespaces**. Appendix A contains every exposed action name. Exposure does not establish installation, authentication, safety, or successful use.

### 2.3 App permission metadata

The named lookup `mcp__Plugin_Management__get_app_permissions` reported global **Allow low-risk actions** and app-specific **Use my default** for GitHub, Dropbox, Linear, Hatchable, Remote Desktop Commander, Render, Neon, Supabase, Vercel and Trello.

The same lookup reported **not_installed** for Todoist, Gmail and Google Calendar, although their action namespaces remain exposed. This directly demonstrates that tool exposure and app installation/connection are separate states.

No app-permission lookup was made for Replit, Webflow, Plugin Creator, Automations or other unqueried providers. Their connection state is NOT RECONCILED.

## 3. Provider status matrix

For Hatchable, READ-TESTED applies only to the documentation registry; project data access is not reconciled.

| Provider / surface | Catalog evidence | Tool exposed | Connection/read evidence | Status |
|---|---|---|---|---|
| Native ChatGPT skill registry | Empty result | `skills__list/read` | No skill URI | UNAVAILABLE-IN-RUN |
| Hatchable platform docs | 57 skills; 11 read | 34 actions | Registry and guides read; no project resource read | READ-TESTED (docs only); project NOT RECONCILED |
| GitHub | No native skill root | 89 actions | Exact repo metadata and Issue #19 fetched | READ-TESTED |
| Dropbox | No native skill root | 39 actions | Exact CC-006C metadata/content fetched | READ-TESTED |
| Linear | No native skill root; agent skills empty | 93 actions | Authenticated workspace and bounded project query | READ-TESTED |
| Remote Desktop Commander | No native skill root | 30 actions | Device, config, folder and Git reads succeeded | READ-TESTED |
| Plugin Management | No native skill root | 4 actions | Permission metadata for 13 named apps | READ-TESTED (metadata only) |
| Trello | No native skill root | 15 actions | Permission found; no resource read | TOOL-EXPOSED |
| Render | No native skill root | 48 actions | Permission found; no resource read | TOOL-EXPOSED |
| Neon | No native skill root | 141 actions | Permission found; no resource read | TOOL-EXPOSED |
| Supabase | No native skill root | 36 actions | Permission found; no resource read | TOOL-EXPOSED |
| Vercel | No native skill root | 260 actions | Permission found; no resource read | TOOL-EXPOSED |
| Replit | No native skill root | 8 actions | No permission lookup/resource read | TOOL-EXPOSED |
| Webflow | No native skill root | 38 actions | No permission lookup/resource read | TOOL-EXPOSED |
| Plugin Creator | No native skill root | 9 actions | No account/plugin read | TOOL-EXPOSED |
| Automations | No native skill root | 7 actions | No automation read | TOOL-EXPOSED |
| Todoist | No native skill root | 49 actions | Permission says `not_installed`; no task read | UNAVAILABLE-IN-RUN |
| Gmail | No native skill root | 20 actions | Permission says `not_installed`; no mail read | UNAVAILABLE-IN-RUN |
| Google Calendar | No native skill root | 10 actions | Permission says `not_installed`; no calendar read | UNAVAILABLE-IN-RUN |
| Files host tools | Not provider catalog | 11 actions | No Library/conversation content read | TOOL-EXPOSED |
| User settings | Not provider catalog | 2 actions | No settings read | TOOL-EXPOSED |

### 3.1 Selected read-oriented actions and exact registry descriptions

Descriptions below reproduce the opening description text from the current tool registry. These are candidates, not evidence of connection. Read actions may still return sensitive data and must be project-scoped.

### Google_Calendar
- `mcp__Google_Calendar__list_events` — Returns events on the given calendar matching all specified constraints. Time constraints should not be specified unless requested by the user. For open-ended keyword or topic-based searches on the primary calendar, the search_events tool must be used instead.
- `mcp__Google_Calendar__get_event` — Returns a single event on the given calendar.
- `mcp__Google_Calendar__list_calendars` — Returns the calendars this user has access to (their calendar list). Use this tool to resolve calendar identifying data (for example, 'my family calendar') into its corresponding `calendar_id` (email identifier)
- `mcp__Google_Calendar__search_events` — Searches events on the user's primary calendar using semantic search.
- `mcp__Google_Calendar__get_profile` — Resolve account identity using the existing Google userinfo implementation.

### Gmail
- `mcp__Gmail__search_threads` — Lists email threads from the authenticated user's Gmail account.
- `mcp__Gmail__get_thread` — Retrieves a specific email thread from the authenticated user's Gmail account, including a list of its messages.
- `mcp__Gmail__get_message` — Retrieves a specific email message from the authenticated user's Gmail account by its unique message ID.
- `mcp__Gmail__list_drafts` — Lists draft emails from the authenticated user's Gmail account.
- `mcp__Gmail__list_labels` — Lists all labels available in the authenticated user's Gmail account. Use this tool to discover the `id` of a label before calling `label_thread`, `unlabel_thread`, `label_message`, or `unlabel_message`. Note: the system labels, `DRAFT` and `SENT`, cannot be set on messages and are read only.
- `mcp__Gmail__get_profile` — Resolve account identity with the fresh Google access token.

### GitHub
- `mcp__GitHub__get_repo` — Retrieve metadata for a GitHub repository. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url`: - `repository_full_name`: `owner/name`, such as `openai/openai`. Maps to GitHub REST `owner` and `repo` path parameters. - `repository_id`: numeric GitHub repository ID, such as `1296269`. - `repository_url`: repository URL or nested repository URL, such as a PR, issue, branch, file, REST API, GitHub Enterprise Server `/api/v3`, or GHE.com API URL. GitHub REST repository docs: https://docs.github.com/en/rest/repos/repos#get-a-repository GitHub Enterprise Server REST docs: https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/getting-started-with-the-rest-api GHE.com API host docs: https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency#api-access
- `mcp__GitHub__fetch_issue` — Fetch a GitHub issue. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url` to select the issue's repository.
- `mcp__GitHub__fetch_pr` — Fetch a pull request with its diff, metadata, and optionally comments.
- `mcp__GitHub__get_pr_info` — Get metadata (title, description, refs, and status) for a pull request. This action does *not* include the actual code changes. If you need the diff or per-file patches, call `fetch_pr_patch` instead (or use `get_users_recent_prs_in_repo` with ``include_diff=True`` when listing the user's own PRs).
- `mcp__GitHub__fetch_file` — Fetch file content by repository path, using the default branch when ref is omitted.
- `mcp__GitHub__fetch_commit` — Fetch a commit with its metadata, diff, and canonical URL.
- `mcp__GitHub__get_commit_combined_status` — Fetch the combined CI status and individual status checks for a commit.
- `mcp__GitHub__fetch_workflow_job_logs` — Fetch decoded logs for a GitHub Actions workflow job. GitHub serves this endpoint through a temporary redirect; the underlying client follows that redirect before decoding the bytes. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#download-job-logs-for-a-workflow-run-job
- `mcp__GitHub__fetch_workflow_job_steps` — Fetch steps for a GitHub Actions workflow job. Returns only step summaries, not the full job payload. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#get-a-job-for-a-workflow-run
- `mcp__GitHub__list_pull_request_reviews` — List review submissions on a pull request. Returns GraphQL review nodes normalized into the connector's review model. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreview
- `mcp__GitHub__list_pull_request_review_threads` — List inline review threads on a pull request, including resolved state. Returns GraphQL review thread nodes, including comment bodies and resolution metadata. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
- `mcp__GitHub__search_issues` — Search one repository or every repository the linked account can access. Supply at most one repository selector. Empty lists mean no repository filter. A `repo:owner/name` query does not require a separate repository selector.
- `mcp__GitHub__search_prs` — Search GitHub pull requests globally, by organization, or optionally by repository.
- `mcp__GitHub__search` — Search GitHub files and return matching excerpts when available. Provide a plain string query, avoid GitHub query flags such as ``is:pr``. Include keywords that match file names, functions, or error messages. ``repository_name`` or ``org`` can narrow the search scope. Example: ``query="tokenizer bug" repository_name="openai/tiktoken"`` or ``query="tokenizer bug" repository_name="tiktoken" org="openai"``. Fully qualified repository names keep their explicit owner even when ``org`` is set. Code search covers the default branch. Use ``fetch_file`` for full file contents. ``topn`` is the number of results to return. No results are returned if the query is empty.
- `mcp__GitHub__list_pr_changed_filenames` — List changed filenames for a PR across all paginated file-list pages.

### Replit
- `mcp__Replit__list_apps` — List Replit Apps the user can edit, most recently updated first; `query` optionally filters by matching app titles, surfacing the best matches for the query first. Use this when the user wants to browse or pick from their apps, or when you need a replId but resolve_app_by_name returned found=false because the user gave an approximate name — present the returned titles and let the user choose, then pass the chosen replId to update_app_using_prompt or ask_question. This is a search/list, not the exact resolver: prefer resolve_app_by_name when the user already gave an exact app name. Results can include apps owned by or shared with the user.
- `mcp__Replit__resolve_app_by_name` — Look up by exact name a Replit App the user can edit and return its replId (UUID) and URL. Use this when the user refers to an app by name (e.g. "update my Todo App", "what does my Recipe Tracker do?") and you don't already have a replId from create_app_from_prompt earlier in this conversation. Pass the result's replId into update_app_using_prompt or ask_question to act on the app. Matching is case-insensitive but exact: this is a name resolver, not a search. If the user gives you an approximate or partial name and this tool returns found=false, call list_apps (optionally with the partial name as the query) and let the user pick from the results rather than guessing. Results can include apps owned by or shared with the user.
- `mcp__Replit__search_apps` — Search Replit Apps the user can edit (owned or shared with them). query is a BM25-style keyword search over app titles, best matches first; updatedAfter/updatedBefore bound the last-updated time; these combine. Prefer the default recency ordering: only set updatedAfter/updatedBefore when the user explicitly asks to filter by time, since date bounds exclude apps that would otherwise be listed. url resolves a Replit App URL directly to that app and ignores the other filters. With no filters, this returns the user's most recently updated apps. Pass a result's replId to update_app_using_prompt or ask_question to act on that app. <important>This tool is EXPERIMENTAL: prefer it for finding the user's apps, but if it errors or its results do not match what the user described, fall back to resolve_app_by_name (exact name) and list_apps (recent apps).</important>
- `mcp__Replit__get_publish_status` — Check the publish status of the user's Replit App: whether it has ever been published, the current status of its most recent publish, and the public URL it serves. found=false means the app has never been published; call publish_app to publish it for the first time. When found, 'success' means it is live at the returned url, 'failed' means the last publish did not go through, 'suspended' means the published app is paused and not serving, and anything else means a publish or lifecycle operation is still in progress. Use this to poll every 30 seconds after calling publish_app, or whenever the user asks whether their app is published or what its live URL is. Takes the same replId as publish_app.

### Remote_Desktop_Commander
- `mcp__Remote_Desktop_Commander__list_devices` — List this account's Desktop Commander devices, their online/offline status, IDs for device selection, and device-management guidance
- `mcp__Remote_Desktop_Commander__who_am_i` — Get details about the currently authenticated user, including this month's remote tool-call usage as a percentage
- `mcp__Remote_Desktop_Commander__get_config` — Get the complete server configuration as JSON. Config includes fields for: - blockedCommands (array of blocked shell commands) - defaultShell (shell to use for commands) - allowedDirectories (paths the server can access) - fileReadLineLimit (max lines for read_file, default 1000) - fileWriteLineLimit (max lines per write_file call, default 50) - telemetryEnabled (boolean for telemetry opt-in/out) - currentClient (information about the currently connected MCP client) - clientHistory (history of all clients that have connected) - version (version of the DesktopCommander) - systemInfo (operating system and environment details) This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.
- `mcp__Remote_Desktop_Commander__list_directory` — Get a detailed listing of all files and directories in a specified path.
- `mcp__Remote_Desktop_Commander__read_file` — Read contents from files and URLs. Read PDF files and extract content as markdown and images.
- `mcp__Remote_Desktop_Commander__read_multiple_files` — Read the contents of multiple files simultaneously.
- `mcp__Remote_Desktop_Commander__get_file_info` — Retrieve detailed metadata about a file or directory including: - size - creation time - last modified time - permissions - type - lineCount (for text files) - lastLine (zero-indexed number of last line, for text files) - appendPosition (line number for appending, for text files) - sheets (for Excel files - array of {name, rowCount, colCount})
- `mcp__Remote_Desktop_Commander__get_tool_result` — Read the status or final result of a Remote MCP tool call that returned a running call_id. Do not retry the original side-effecting tool while its status is pending or executing.
- `mcp__Remote_Desktop_Commander__list_remote_tool_calls` — List recent Remote MCP calls that exceeded the bounded synchronous wait and continued in the background.
- `mcp__Remote_Desktop_Commander__read_process_output` — Read output from a running process with file-like pagination support.
- `mcp__Remote_Desktop_Commander__list_sessions` — List all active terminal sessions.
- `mcp__Remote_Desktop_Commander__list_processes` — List all running processes.
- `mcp__Remote_Desktop_Commander__get_usage_stats` — Get usage statistics for debugging and analysis.
- `mcp__Remote_Desktop_Commander__get_recent_tool_calls` — Get recent local tool call history with arguments and outputs. Returns a chronological list of recent calls loaded from the local history file.

### Webflow
- `mcp__Webflow__data_agent_instructions_tool` — Data tool - Manage and generate agent instructions (rules and skills) for a site. Actions: search_instructions, read_instruction, create_instruction, update_instruction, delete_instruction, move_instruction, generate_instruction. Paths must follow 'rules/<name>.md', 'rules/<name>.mdc', or '<skill-name>/SKILL.md'. Generation is asynchronous and saves a draft: call generate_instruction to start, then call it again with task_id set to the returned taskId until it finishes and read the returned resourceUri.
- `mcp__Webflow__data_analyze_tool` — Read Webflow Analyze report data for a site, including traffic timeseries, ranked pages, ranked dimensions, ranked engagement events, and aggregate or bucketed time on page. Includes guide actions for building Analyze queries and resolving engagement event rows to page elements, component instances, and CMS context. Also includes goals (list and daily performance), scroll depth, browser window height, and page flow (pages viewed before/after an anchor page).
- `mcp__Webflow__data_sites_tool` — Data tool - Sites tool to perform actions like list sites, get site details, and publish sites
- `mcp__Webflow__data_cms_tool` — Data tool - CMS tool to manage collections, collection fields (static/option/reference), collection field groups, and collection items (list, create, update, publish, unpublish, delete)
- `mcp__Webflow__data_pages_tool` — Data tool - Pages tool to perform actions like list pages, get page metadata, update page settings, create a page, bulk update page settings, manage page branches and their staging previews (page-branch actions require Enterprise), list or create site-scope branches / Releases via list_site_branches and create_site_branch (beta MCP only), and read or write JSON-LD schema markup for pages in bulk.
- `mcp__Webflow__get_asset_preview` — Get an image preview of a site asset by its asset ID. Fetches the asset's metadata, downloads the smallest available image variant (or the original file when no variants exist), and returns the image content. Works with any image content type (e.g. JPG, PNG, GIF, WEBP); non-image files and files larger than 2 MB return an error instead of an image. Returns a 404 error if the asset does not exist or has been deleted.
- `mcp__Webflow__webflow_guide_tool` — Provides essential guidelines and best practices for effectively using the Webflow tools. Call this tool to understand recommended workflows and important considerations before performing actions. ALWAYS CALL THIS TOOL FIRST BEFORE CALLING ANY OTHER TOOLS. ALWAYS CALL THIS TOOL FIRST BEFORE CALLING ANY OTHER TOOLS.

### Todoist
- `mcp__Todoist__To_Do_List___Calendar__find_tasks` — Find active tasks by text, project/section/parent, responsible user, labels, raw filter, or saved filter (filterIdOrName). Without filters, list a page. Default scope: unassigned + mine; responsibleUserFiltering="all" includes others.
- `mcp__Todoist__To_Do_List___Calendar__find_projects` — List or search by name the projects the user has joined. By default only active projects are returned; use archivedStatus ('archived' or 'all') to include archived projects. When searching or when archivedStatus is 'all', all matching projects are returned (pagination is ignored). Otherwise projects are returned with pagination. Workspace projects the user hasn't joined are left out unless includeUnjoined is set, or a search matches no joined project.
- `mcp__Todoist__To_Do_List___Calendar__find_activity` — Retrieve activity logs to monitor and audit changes in Todoist. Shows events from all users by default (use initiatorId to filter by specific user). To answer what someone completed in a period, including recurring task occurrences, use objectType "task", eventType "completed", and dateFrom/dateTo. For a first-person question ("what did I get done"), also set initiatorId to the current user from user-info, or the answer includes collaborators' completions. Track task completions, updates, deletions, project changes, and more with flexible filtering. Activity history availability and retention depend on the user plan.
- `mcp__Todoist__To_Do_List___Calendar__get_project_health` — Get a comprehensive health assessment for a project including completion progress, health status (EXCELLENT, ON_TRACK, AT_RISK, CRITICAL), and optional detailed context with project metrics and task-level data. Use includeContext=true for that full detail.
- `mcp__Todoist__To_Do_List___Calendar__get_overview` — Get a Markdown overview. Called without a projectId, returns the account's project and section structure only — no tasks — for navigation. Pass a projectId (or "inbox" for the Inbox) to get that project's tasks grouped by section.
- `mcp__Todoist__To_Do_List___Calendar__fetch_object` — Fetch a single task, project, comment, or section by its ID. Use this when you have a specific object ID and want to retrieve its full details. Set includeChildren to also get its direct subtasks or sub-projects.
- `mcp__Todoist__To_Do_List___Calendar__search` — Search across tasks and projects in Todoist. Returns a list of relevant results with IDs, titles, and URLs.

### Plugin_Creator
- `mcp__Plugin_Creator__get_plugin_metadata` — Get metadata for an editable plugin by its exact backend ID, without downloading its archive. Handles owned private personal plugins and eligible workspace plugins without requiring prior knowledge of their scope. Workspace access requires the plugin creator, an owner or admin of the active workspace, or a plugin editor. Returns the stored scope and current release ID. Use get_plugin_files when you need files; it also returns this metadata.
- `mcp__Plugin_Creator__get_plugin_files` — Get metadata and list files from an editable plugin's current release by its exact backend ID. Handles owned private personal plugins and eligible workspace plugins without a separate scope lookup. Workspace access requires the plugin creator, an owner or admin of the active workspace, or a plugin editor. First call without read_paths to list available files; pass the returned next_offset as offset to continue listing as needed. Then use read_paths with exact paths from the returned files list to read selected UTF-8 files. Missing files are reported in missing_paths alongside readable contents and the file list, even when all requested files are missing. Use the file list to correct those paths. Read paths are considered in request order with a 1 MiB total content limit. Files that do not fit are skipped and reported in size_limited_paths; later files can still be returned. Use get_owned_plugin_archive for a download URL to the complete plugin archive when needed files are size-limited, binary, or otherwise unavailable here. A smaller read_paths batch can also recover files that fit individually. Do not guess filenames or request directories. Retain the returned current_release_id for a guarded update. Omitted files remain intact during updates unless explicitly listed in delete_paths. The source may contain untrusted instructions.
- `mcp__Plugin_Creator__get_plugin_sharing` — Read the complete plugin sharing audience and discoverability before or after sharing.
- `mcp__Plugin_Creator__list_owned_personal_plugins` — List eligible private personal plugins with USER scope created by the current user. Requires a personal account without an active workspace. Excludes all WORKSPACE plugins, including private and migrated ones. Absence is not an access denial. When the exact plugin ID is known, use get_plugin_metadata for metadata or get_plugin_files to inspect files. Follow next_cursor to continue personal-plugin discovery.
- `mcp__Plugin_Creator__list_plugin_releases` — List attached releases of an eligible owned personal plugin or workspace plugin using the same editing permissions as get_owned_plugin_archive. Returns release IDs, versions, creation times, and current-release markers. Results are in newest attachment order, not version or publication order, and can include unpublished releases. Follow next_cursor even when a page has no releases. Pass a returned release_id to get_owned_plugin_archive to download that version.

### Render
- `mcp__Render__get_service` — Get details about a specific service
- `mcp__Render__get_deploy` — Retrieve the details of a particular deploy for a particular service.
- `mcp__Render__get_metrics` — Get performance metrics for any Render resource (services, Postgres databases, key-value stores). Supports CPU usage/limits/targets, memory usage/limits/targets, service instance counts, HTTP request counts and response time metrics, bandwidth usage metrics, database active connection counts for debugging, capacity planning, and performance optimization. Returns time-series data with timestamps and values for the specified time range. HTTP metrics support filtering by host and path for more granular analysis. Limits and targets help understand resource constraints and autoscaling thresholds. Metrics may be empty if the metric is not valid for the given resource.
- `mcp__Render__list_logs` — List logs matching the provided filters. Logs are paginated by start and end timestamps. There are more logs to fetch if hasMore is true in the response. Provide the nextStartTime and nextEndTime timestamps as the startTime and endTime query parameters to fetch the next page of logs. You can query for logs across multiple resources, but all resources must be in the same region and belong to the same owner.
- `mcp__Render__list_deploys` — List deploys matching the provided filters. If no filters are provided, all deploys for the service are returned.
- `mcp__Render__list_events` — List a service's event history: deploys, builds, restarts, failures, scaling, suspensions, and disk changes. Use it to find out what happened to a service and why. Failure events carry the reason a service went down, such as out-of-memory kills, non-zero exits, failed health checks, and evictions, which may not show up in logs. The first page covers the last 7 days unless startTime says otherwise. For older events, page with the cursor from the previous call. If the first page comes back empty there is no cursor to follow, so set an earlier startTime instead. Events cover services only, not Postgres or Key Value instances.
- `mcp__Render__list_services` — List all services in your Render account
- `mcp__Render__list_workflows` — Discover Workflows in the selected workspace. Returns one page and nextCursor; follow until null or an empty page.
- `mcp__Render__list_workflow_runs` — List task runs with status, attempts and parent/root relationships. A page is not the entire history. The API does not support status/time filters here. Use get_workflow_run for errors and get_workflow_run_results for results.
- `mcp__Render__query_render_postgres` — Run a read-only SQL query against a Render-hosted Postgres database. This tool creates a new connection for each query and closes it after the query completes.

### Supabase
- `mcp__Supabase__search_docs` — Search the Supabase documentation using GraphQL. Must be a valid GraphQL query that uses only the fields, arguments and types defined in the schema below; anything else fails. Example: `{ searchDocs(query: "row level security", limit: 5) { nodes { title href content } } }` You should default to calling this even if you think you already know the answer, since the documentation is always being updated.
- `mcp__Supabase__list_organizations` — Lists all organizations that the user is a member of.
- `mcp__Supabase__get_organization` — Gets details for an organization. Includes subscription plan.
- `mcp__Supabase__list_projects` — Lists all Supabase projects for the user. Use this to help discover the project ID of the project that the user is working on.
- `mcp__Supabase__get_project` — Gets details for a Supabase project. `status` is `ACTIVE_HEALTHY` when the project is ready for database tools; other values such as `COMING_UP`, `RESTORING`, or `INACTIVE` (paused) mean database calls will fail or time out.
- `mcp__Supabase__get_cost` — Gets the cost of creating a new project or branch. Never assume organization as costs can be different for each. Always repeat the cost to the user and confirm their understanding before proceeding.
- `mcp__Supabase__list_tables` — Lists all tables in one or more schemas. By default returns a compact summary. Set verbose to true to include column details, primary keys, and foreign key constraints.
- `mcp__Supabase__list_migrations` — Lists all migrations in the database.
- `mcp__Supabase__query_logs` — Runs a custom read-only ClickHouse SQL query against a Supabase project's unified logs stream, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_end; other windows are rejected. If you pass only iso_timestamp_start, the end defaults to now, so for a past time range pass both timestamps. For a longer range, make one call per 24-hour slice. Do not poll this tool in a loop.
- `mcp__Supabase__get_advisors` — Gets a list of advisory notices for the Supabase project. Use this to check for security vulnerabilities, performance improvements, or health issues. Include the remediation URL as a clickable link so that the user can reference the issue themselves. It's recommended to run this tool regularly, especially after making DDL changes to the database since it will catch things like missing RLS policies.
- `mcp__Supabase__list_edge_functions` — Lists all Edge Functions in a Supabase project.
- `mcp__Supabase__get_edge_function` — Retrieves file contents for an Edge Function in a Supabase project.
- `mcp__Supabase__list_branches` — Lists all development branches of a Supabase project. This will return branch details including status which you can use to check when operations like merge/rebase/reset complete.

### Neon
- `mcp__Neon__search_docs` — Searches neon.com docs, API reference, PostgreSQL tutorial, guides, FAQs, changelog, and blog for ranked pages with the slug get_doc reads.
- `mcp__Neon__get_doc` — Returns one neon.com page as markdown, by the slug of a search_docs hit.
- `mcp__Neon__list_projects` — Lists the projects in an organization; search filters by name or id. To also find branches, computes, or snapshots, use search. Returns every page. Pass limit to cap how many. `org_id` is optional: organization API keys use their organization; personal API keys auto-select when unambiguous and otherwise return the IDs to choose from.
- `mcp__Neon__describe_project` — Gets a project's settings, owner, and usage. For branches, use list_branches.
- `mcp__Neon__get_project_consumption` — Returns per-project consumption in an organization. metrics: every name get_branch_consumption takes, plus extra_branches_month and snapshot_storage_bytes_month. Launch, Scale, Agent, Business, or Enterprise plans; others get 403. Returns every page. Pass limit to cap how many.
- `mcp__Neon__list_branches` — Lists a project's branches with id (br-...), name, parent, and default flag; search finds a branch's id by name. Returns every page. Pass limit to cap how many.
- `mcp__Neon__get_branch` — Gets a branch record: name, parent, state, protection, size, and timestamps. For its databases and tables, use describe_branch.
- `mcp__Neon__get_operation` — Gets one operation and its status.
- `mcp__Neon__list_incidents` — Lists open Neon incidents and maintenance from neonstatus.com and the affected components and regions. Needs no credentials. Call it when Neon requests fail unexpectedly or the user asks whether Neon is down.
- `mcp__Neon__list_slow_queries` — Lists queries from pg_stat_statements, slowest mean execution time first. For sizes, indexes, locks, cache, bloat, or replication, use inspect_database.
- `mcp__Neon__inspect_database` — Runs one read-only neon inspect db check; some are compute-wide. outliers ranks queries by total time and calls by count, both via pg_stat_statements; lfc-hit-rate and working-set need the neon extension. If one is missing, the error gives the CREATE EXTENSION; ask before running it. Other SQL: run_sql; one plan: explain_sql_statement; new indexes: prepare_query_tuning.
- `mcp__Neon__describe_table_schema` — Returns a table's columns, indexes, constraints, and sizes. For every table, use get_database_tables.
- `mcp__Neon__get_database_tables` — Lists a database's tables and views outside the system schemas. For one table's columns, use describe_table_schema.
- `mcp__Neon__query_logs` — Returns a branch's log records. Filters combine with AND; pass logql or structured filters, not both. Pass since or start_time, not both; default last hour, max seven days. Private beta: a branch without logs returns 404 telemetry_not_enabled. Stream labels: query_loki_logs. Returns every page. Pass limit to cap how many.
- `mcp__Neon__list_functions` — Lists the functions on a branch. Returns every page. Pass limit to cap how many.
- `mcp__Neon__get_function` — Gets a function on a branch by slug.

### Hatchable
- `mcp__Hatchable__get_project` — Get project details including slug, status, deployed functions, and the database schema (tables, columns, types).
- `mcp__Hatchable__list_agent_tasks` — Read the agent tasks the project's owner has filed — plain-English asks like "make the header say X" or "the contact form is broken", written in the console and waiting for you.
- `mcp__Hatchable__list_projects` — List all projects you own or collaborate on, with their tier, role, and current version.
- `mcp__Hatchable__read_file` — Read the content of a project file.
- `mcp__Hatchable__grep` — Regex content search across a project's files. Postgres-backed, scoped to one project, with glob filtering.
- `mcp__Hatchable__list_files` — List all files in a project with their paths, sizes, and hashes.
- `mcp__Hatchable__get_schema` — Return the database schema for the project's PostgreSQL database: tables, columns (with types), and indexes.
- `mcp__Hatchable__view_logs` — View function execution logs with rich filtering. Each entry includes status_code, duration_ms, log_output (captured console.log), error (if any), and a derived `level` field (error/warning/info).
- `mcp__Hatchable__list_deployments` — List deployments for a project in reverse-chronological order. Each entry includes version, status, deployed_at, description, and summary counts (files, functions).
- `mcp__Hatchable__list_functions` — List every deployed API function for a project: route, method, runtime tier, type ('scheduled' if the function has at least one active scheduled task, else 'api'), and 24-hour invocation and error counts.
- `mcp__Hatchable__get_deployment` — Detail view of one deployment by version number — returns the full file manifest (paths, hashes, sizes) and function list captured when that version shipped. Use it with list_deployments to audit or compare what changed between versions.
- `mcp__Hatchable__list_cron_jobs` — List a project's scheduled tasks: every recurring task, every one-shot still to fire, and the 20 most recent one-shots that already fired (older fired one-shots are counted in completed_one_shots, not listed). A task points at a function and carries a cron expression (recurring) or a one-shot fire_at, plus an optional payload delivered as the request body. Tasks are either 'declared' (written into source via export const schedule or hatchable.toml, reconciled on deploy) or 'armed' (inserted by the SDK scheduler.at() call, preserved across deploys). Response includes next_fire_at, last_fired_at, attempts, last_error, and 7-day run and 5xx-error counts from FunctionLog. Diagnostic: if next_fire_at keeps moving forward but last_fired_at never advances, the scheduler isn't running.
- `mcp__Hatchable__search_documentation` — Search Hatchable's own documentation for platform behavior — routing, the SDK surface, deploy semantics, auth config, runtime limits. Call this instead of guessing when you're unsure how a Hatchable feature works.
- `mcp__Hatchable__dry_run_deploy` — Run every deploy-time validator against the project's current files without actually deploying. Returns `errors` (hard gates) and `warnings` (soft lints), plus a `would_deploy` summary of what would ship.
- `mcp__Hatchable__list_pending_uploads` — Show multipart uploads currently staged for this project that haven't yet been committed. Use this to recover from a disconnect — find the upload_id and resume from the next chunk_index. Uploads expire 10 minutes after the last chunk was added.
- `mcp__Hatchable__list_skills` — List the registry of platform skills — discrete how-to guides for one specific task each (e.g. 'gate-an-endpoint', 'add-a-cron-job', 'add-rag-search'). Each entry is a name, one-line purpose, and category. Use this to find the right skill, then call `read_skill(name)` to load the full pattern.
- `mcp__Hatchable__read_skill` — Load the full markdown body of one skill: when to use it, the canonical code shape, common pitfalls, and how to verify it works. Skills are the platform's primary agent-facing reference — every pattern an agent might need is one of these.

### Dropbox
- `mcp__Dropbox__get_file_metadata` — Get metadata, sharing details, and permissions for a Dropbox file or folder
- `mcp__Dropbox__fetch` — Fetch full text content for a Dropbox file by id or path.
- `mcp__Dropbox__list_folder` — List Dropbox folder contents; supports direct children or recursive traversal
- `mcp__Dropbox__list_file_revisions` — Tool
- `mcp__Dropbox__file_preview` — Preview Dropbox files visually with thumbnails and Open in Dropbox links
- `mcp__Dropbox__check_job_status` — Poll an async move, copy, delete, or restore_folder operation
- `mcp__Dropbox__get_file_request` — Get the metadata for one Dropbox file request by its request ID
- `mcp__Dropbox__list_file_requests` — List Dropbox file requests owned by the connected user
- `mcp__Dropbox__list_restore_events` — Tool
- `mcp__Dropbox__search` — Search Dropbox files and folders by name or content, with optional filters

### Linear
- `mcp__Linear__whoami` — Retrieve the authenticated user, the connected workspace, and how this connection reaches Linear
- `mcp__Linear__list_agent_skills` — List Linear Agent skills available to the authenticated user.
- `mcp__Linear__list_projects` — List projects in the user's Linear workspace
- `mcp__Linear__get_project` — Retrieve details of a specific project in Linear
- `mcp__Linear__get_issue` — Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.
- `mcp__Linear__list_issues` — List issues in the user's Linear workspace, including active Triage Intelligence suggestions for issues in triage. For issues assigned to me, use "me" as the assignee. For issues created by me, use "me" as the creator. Use "null" for no assignee.
- `mcp__Linear__list_comments` — List comments on a Linear issue, project, initiative, document, project milestone, or project/initiative status update. Provide exactly one of `issueId`, `projectId`, `initiativeId`, `documentId`, `milestoneId`, or `statusUpdateId`. `statusUpdateType` applies only to `statusUpdateId`; omit it for every other parent. For issues, projects, and initiatives this returns both top-level discussion threads and inline description comments. Inline (anchored) comments carry a non-null `quotedText` set to the snippet of description text they reference. Returned comments include `author` and nullable `onBehalfOf`; when set, `onBehalfOf` identifies the user the agent author acted for. Files uploaded in comment bodies are returned in `attachments` with titles and download URLs, not issue attachment IDs. Signed upload URLs expire after five minutes; call list_comments again to refresh them. Download documents using these URLs and process them with your own file tools.
- `mcp__Linear__list_diffs` — List Linear diff pull requests visible to the authenticated user
- `mcp__Linear__get_diff_threads` — Exact lookup for diff threads and the authenticated user's drafts. Use with review URLs, GitHub PR URLs, Linear full identifiers, UUIDs, or slugs.
- `mcp__Linear__list_teams` — List teams in the user's Linear workspace, including their parent IDs and hierarchy names
- `mcp__Linear__get_team` — Retrieve details of a specific Linear team, including its parent ID and hierarchy name. Use list_teams with parentTeam or ancestorTeam to find its sub-teams
- `mcp__Linear__get_workspace` — Retrieve the connected workspace's ID, name, and URL to confirm which workspace you are using
- `mcp__Linear__list_documents` — List or search documents in the user's Linear workspace by title and content
- `mcp__Linear__get_document` — Retrieve a Linear document by ID or slug
- `mcp__Linear__search` — Full-text search across Linear issues, projects, initiatives, and documents, ranked by relevance. Use this for keyword or natural-language queries (e.g. "memory leak in sync engine"). Supports "quoted phrases" for exact match, -term to exclude, and +term to require. For structured filtering by assignee, status, team, label, etc., use the list_issues or list_projects tools instead.

### Trello
- `mcp__Trello__trelloReadCard` — Fetch a Trello card's full details, or list cards across a board or list to surface open work items. Use this tool when you know the specific board, list, or card you want to inspect. For keyword-based discovery across all boards/cards, use trelloSearch instead. Actions: - "get": fetch a single card by id or card URL (cardIdOrUrl required). Returns core card fields, labels (up to 25; truncation signalled via labelsHasMore), checklists (up to 25; truncation signalled via checklistsHasMore, each with up to 25 check items; truncation signalled via checkItemsHasMore, use trelloReadChecklist for the full list), and comments (up to 25; truncation signalled via commentsHasMore). - "list_by_board": fetch all cards for a board grouped by list (boardIdOrUrl required). Response: { lists: [{ id, name, cards: [...] }], hasNextPage, nextCursor }. Each page contains up to 5 lists (configurable via limit); each list contains all its cards. Filter by card state: "open" (default), "archived", or "all". Use cursor/limit to paginate over lists (max 50 lists per page). - "list_by_list": fetch cards in a Trello list (listId required) with cursor-based pagination. Use this when the user asks for cards in a list or all cards from a specific list. Response: { cards: [...], pageInfo: { hasNextPage, endCursor } }. Filter by card state: "open" (default), "archived", or "all". Use cursor/limit to paginate (max 50 cards per page). - "get_comment": fetch a single comment on a card by its action ID (cardIdOrUrl and commentId required). For this action, cardIdOrUrl must be a Trello card ARI so the workspace is explicit for authorization. Response: { id, text, createdAt, lastEditedAt, creator, cardId }. - "list_comments": list comments on a card, newest first (cardIdOrUrl required). Response: { comments: [{ id, text, createdAt, lastEditedAt, creator }], pageInfo: { hasNextPage, endCursor } }. Use cursor/limit to paginate (default 25, max 50 comments per page). - "list_attachments": list files and links attached to a card (cardIdOrUrl required). Response: { attachments: [{ id, name, fileName, url, mimeType, bytes, createdAt, isUpload, isMalicious }], pageInfo: { hasNextPage, endCursor } }. Use cursor/limit to paginate (default 25, max 50 attachments per page). - "list_custom_field_items": list the custom field values set on a card (cardIdOrUrl required). Pairs with trelloReadBoard "list_custom_fields" for the field definitions these values belong to. Response: { customFieldItems: [{ id, customField: { id, name, type }, value: { text, number, date, checked, optionId } }], pageInfo: { hasNextPage, endCursor } }. Only the value field matching the customField.type is populated (e.g. text fields set value.text). optionId references a customField option for list/dropdown fields. Use cursor/limit to paginate (default 25, max 50 items per page). - "list_activity": list a card's full activity history, newest first (cardIdOrUrl required). Unlike "list_comments" this is unfiltered: comments, moves between lists, member add/remove, due-date changes, attachments and checklist item state changes all appear in one feed. Response: { activity: [{ id, type, displayKey, date, creator, ...typeSpecificFields }], pageInfo: { hasNextPage, endCursor } }. Every entry has id, type, displayKey, date and creator. Type-specific fields are present only for their own action type and omitted otherwise: commentText/commentLastEditedAt, listBefore/listAfter, member, attachment, dueDate, checkItem. Other action types appear with the common fields alone. Trello reuses "type" across different edits (a list move and a due-date change are both "updateCard"), so branch on "displayKey" or on which type-specific field is present, rather than on "type" alone. Same entry shape as trelloReadBoard "list_activity", minus its "card" field. Every entry is an action on the card you asked for; name that entity type when you report one. Use "list_comments" when the user only wants the discussion; use "list_activity" for "what happened to this card" or "who changed this and when". Use cursor/limit to paginate (default 25, max 50 entries per page).
- `mcp__Trello__trelloReadBoard` — Read Trello boards. Supports listing boards the authenticated user is a member of, listing all boards a user can access within a specific workspace (regardless of membership), fetching a single board by ARI or URL, listing labels on a board, listing a board's custom field definitions, and listing a board's action/history.
- `mcp__Trello__trelloReadChecklist` — Read Trello checklists (and their check items) attached to a card. Supported actions: "list_by_card" — list checklists on a card (cardId required); cursor/limit page the checklists. "get" — fetch a single checklist by id (checklistId required). In both actions each checklist is returned with its complete `items` list embedded.
- `mcp__Trello__trelloReadList` — Read Trello lists. Supported actions: "list_by_board" — list the open lists on a board (id, name, position, objectId) with cursor-based pagination (limit defaults to 25, max 50); "get" — return a single list by id, including up to 25 nested cards (id, name). - "list_activity" — page through open cards currently in a list and return each card's recent activity. Only the cards are paginated (cursor/limit, defaults to 25 cards, max 50); each card returns its 25 most recent activity entries. Use trelloReadCard to get a single card's full history. Every entry is an action on the card it is grouped under; name that entity type when you report one.
- `mcp__Trello__trelloReadWorkspace` — Read Trello workspaces (organizations) the current user has access to. Supported actions: "list" — list workspaces visible to the authenticated user (cursor-based pagination, limit defaults to 25, max 100); "get" — fetch detailed data for a single workspace by id (typically used after "list" to drill into a workspace).
- `mcp__Trello__trelloSearch` — Discover Trello boards or cards by keyword across all workspaces. Use this when the user wants to find something by name or content but does not know which board it is on. If the user already knows the board or list they want to browse, use trelloReadCard (list_by_board or list_by_list) instead — it is faster and returns richer grouped results. Supported actions: "search_boards" — search for boards by name, always include each board's `url` verbatim in the response; "search_cards" — search for cards by name/content. Both support optional workspace scoping and cursor-based pagination. Both actions return open (non-archived) results by default. To search archived items instead, include `is:archived` in the query. "search_cards" additionally supports boardIds scoping and qualifiers: label:, board:, list:, member:, due:, has:. For archived/closed cards, use `is:archived` or `is:closed` (they are equivalent for cards only). For archived boards, use `is:archived` only — boards do not support the `is:closed` alias. Due date timezone handling: Trello due-date search qualifiers use UTC boundaries. For "today" or date-based due-date queries, first call trelloReadMember (get_me) for prefs.timezone and account for the user's local timezone.

### Vercel
- `mcp__Vercel__search_vercel_documentation` — Search Vercel's published documentation for a topic and return relevant excerpts. Covers Vercel platform features, configuration, APIs, limits, and pricing, including projects and deployments, Git integration, environments, Functions and Fluid Compute, Routing Middleware, Cron Jobs, Sandbox, caching and the CDN, AI SDK and AI Gateway, Firewall and BotID, and storage such as Blob and Edge Config. Results come from a third-party documentation index (Context7). Does not access the user's Vercel account or projects.
- `mcp__Vercel__get_runtime_logs` — Use this when reading application output (console.log, warnings, errors) that the functions and daemons of a project wrote at runtime, as individual log records, or when counting those records with group_by. Filter by deployment, environment, level, source, request ID, time range, or full-text query. The default window is the latest 50 minutes; for a recent window, pass since like "30m" and omit until, which is only needed for historical end times. How far back logs go depends on the runtime-log retention of the plan. For wide time ranges, scope to a deploymentId or use group_by. Do not use for build failures; use the deployment build logs instead. For clustered summaries of production errors, prefer get_runtime_errors.
- `mcp__Vercel__get_runtime_errors` — Use this when investigating production errors or finding the most frequent runtime failures in a project. Returns pre-aggregated error clusters with error names, occurrence counts, affected routes, sample messages, and first/last seen times. Use get_runtime_logs for individual log entries; use deployment build logs for build failures. For recent windows, pass since like "24h" or "7d" and omit until; until is only needed for historical end times. Max 7-day range.
- `mcp__Vercel__get_project_trace` — Get the resolved OpenTelemetry trace for a project by trace ID or Vercel request ID. Pass traceId (32-character hex, as in a dashboard URL ending in /logs/traces/<traceId>) or requestId (from runtime logs or the x-vercel-id header). Traces are only kept for the team plan's trace retention: 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise. Internal Vercel runtime spans are removed and their children reparented; span durations are in milliseconds. Error spans include the type and stack trace of their first exception event. Returns at most 200 spans, keeping the root and error spans first; meta.omittedSpanCount reports how many were left out, and meta.partial is true when the trace exceeded the API's 10,000-span limit.
- `mcp__Vercel__list_ai_gateway_models` — Use this when choosing a model on Vercel AI Gateway or checking what one costs. Searches the live public catalog and returns each match's ID, type, context window, output limit, model-specific pricing in USD, and capability tags, with the total number of matches and, when more remain, a nextOffset to pass as offset for the next page. Use get_ai_gateway_model for the providers that serve one model. This is reference data; it does not read the user's account, so a team's virtual models (vmc/...) are not listed.
- `mcp__Vercel__get_ai_gateway_model` — Use this when comparing the providers that serve one Vercel AI Gateway model. Returns the model's description and, for each provider endpoint, its pricing in USD, context and output limits, supported parameters, zero-data-retention and no-training flags, uptime, latency, and throughput. Use a known creator/model ID directly; use list_ai_gateway_models only when you need to discover it. This is reference data; it does not read the user's account.
- `mcp__Vercel__get_ai_gateway_usage` — Use this when measuring a team's Vercel AI Gateway spend, request volume, token usage, or latency. Returns totals for the chosen metrics, optionally grouped by one dimension such as model or provider, plus an hourly or daily series when granularity is set. Covers the last 7 days by default. A scoped connection fixes the team/project; otherwise, pass projectId to limit the team query to one project. Returns aggregates only, never prompts or responses; use get_ai_gateway_leaderboard for usage across all of AI Gateway.
- `mcp__Vercel__list_projects` — List the projects of the authenticated user or the selected team. Results are paginated using limit and from. Optionally filter by name search, Git repository, connected Global Config, build settings, and other listed filters.
- `mcp__Vercel__get_project` — Get a project's details by project ID or name.
- `mcp__Vercel__get_deployment` — Get a deployment by its ID or hostname. When withGitRepoInfo is true, the response also includes Git source details. Additional details are included when the authenticated user or team owns the deployment.
- `mcp__Vercel__list_deployments` — Use this when you need deployment records or recent deployment history under the authenticated user or team. Results can be filtered by project, branch, commit, environment, state, creator, or creation time. Returns deployment data; incomplete uploads have a null URL. For a live deployment card with build status and expandable logs, use open_deployments when available.
- `mcp__Vercel__get_observability_schema` — Retrieve the available Vercel observability metrics and their query schemas. Use this to choose supported metrics and dimensions before running an observability query.
- `mcp__Vercel__create_observability_query` — Run a read-only Vercel observability query for a metric and owner or project scope. Supports time ranges, filters, grouping, aggregation, and result limits. Returns query results without changing project configuration.
- `mcp__Vercel__list_vercel_ci_invocations` — List Vercel CI invocations for a team. Optionally filter by repository provider, repository, branch, commit snapshot, author, status, conclusion, source, or creation time. Paginated with limit (default 20, max 100) and cursor.
- `mcp__Vercel__get_vercel_ci_invocation` — Get one attempt of a Vercel CI invocation, identified by invocationId and attempt.
- `mcp__Vercel__get_vercel_ci_job_run_logs` — Get the log lines available so far for one run attempt of a Vercel CI job. Optionally filter by log level or start from a since value. Returns immediately; to see new lines while the job runs, call again later, using since to skip lines already read.
- `mcp__Vercel__list_sessions` — List sandbox sessions in a project, optionally filtered by sandbox name. Sorted by creation time; paginated with limit (default 20, max 50) and an opaque cursor.
- `mcp__Vercel__get_session` — Retrieves detailed information about a specific session, including its current status, resource configuration, and exposed routes.
- `mcp__Vercel__get_remote_cache_status` — Get the Remote Caching status for the authenticated account or selected team. Returns whether Remote Caching is enabled, disabled, or disabled due to usage limits.

### Automations
- `mcp__Automations__get` — Read one task's saved instructions and context version by automation ID.
- `mcp__Automations__peek` — Privately look up task automations without displaying the list to the user.
- `mcp__Automations__list_event_sources` — List connected apps with supported automation events. Call this before discover_webhook_schema, then pass the chosen source's connector_id as connector_type. Call again after connecting or disconnecting an app.

### Plugin_Management
- `mcp__Plugin_Management__get_app_permissions` — Inspect one named ChatGPT plugin's global/default and plugin-specific permission settings. Use when the user asks what the plugin may read, write, or do, whether it must ask first, or whether it inherits the default. For a missing/broad target such as my plugins, all, or Google, make no call and ask which plugin. Never pass global. Do not use for OAuth/admin scopes, install/connect/undo requests, ordinary plugin use, or npm/Chrome/code plugins.
- `mcp__Plugin_Management__get_plugin_dependencies` — Resolve the canonical public plugins declared by one plugin's app manifest. Use only when a skill or user explicitly asks for dependency metadata. Pass a plugin ID or name@marketplace reference unchanged. Named references resolve by globally listed plugin name. This reports metadata plus current user-aware plugin status, installation policy, and installed state; it does not install or connect anything. The result separates visible canonical plugins from app entries that lack a unique canonical plugin or whose canonical plugin is unavailable to the current user.

### files
- `files__list` — List ChatGPT conversation files or browse the user's file library. Supports metadata filters for file types and dates, including the special file type 'folder' for folder-only library listings. Returns file and folder metadata only; use recursive=true for recent files across the whole library, and use files.search for ranked content retrieval. Use the Library surface for prior or persistent files, including files from previous conversations. Common Library call: {"surface":"library","recursive":true,"limit":20}. Use sort='created_at' for upload/creation time, not sort='uploaded_at'. Reuse a cursor only from a response with next_cursor, and repeat the same list request shape except for cursor; do not change surface, library_path, filters, sort, or limit while paginating.
- `files__search` — Default first choice for broad content questions or when the relevant location is unknown; this is ranked semantic search. Use one top-level search_query array with q strings only; each item may contain q and optional search_title_only. Keep scope, filters, intent, and top_k at the top level. Do not copy legacy file_search.msearch fields such as queries, source_filter, or file_type_filter; do not use web-search fields such as recency, response_length, q2, or q3, and use at most 5 query items. Extra query items are skipped with a warning. q must be nonempty; use files.list for recent-file metadata navigation. Include at least one query equivalent to the user's core question with ambiguous references resolved; use multiple queries or quote exact phrases in double quotes when useful. Defaults to all conversation files, title-and-content search, sort='relevance', and result_format='snippets'. Omit scope only when current-conversation uploads are the intended source. For named or prior files not attached here, set scope.surfaces to ['library']; include 'conversation' too when both sources could matter. Do not force Library for public or API-policy questions, code symbols, or connector-native data when web or another available connector is the better source. Restrict specific files with scope.file_refs using file_id values returned by Files; put Library folder paths in scope.library_folders. These belong in scope, not filters. Omit filters unless narrowing by file types, dates, or generated/uploaded files. Use created_after/created_before for Library upload or creation time. For photos, use image_taken_after/image_taken_before and image_location for EXIF-derived capture time and location; location fields are exact AND constraints, so use the smallest confident constraint. Request include_image_metadata only when the user explicitly asks to see image_taken_at or image_location. Keep a nonempty semantic query even when filters carry the request; use a broad query such as 'photos' when needed. If results are not relevant or complete, refine the query or retry with a higher top_k. Common calls: conversation content {"search_query":[{"q":"quarterly revenue"}],"top_k":5}; Library content {"search_query":[{"q":"quarterly revenue"}],"scope":{"surfaces":["library"]},"top_k":5}; specific conversation file {"search_query":[{"q":"quarterly revenue"}],"scope":{"file_refs":[{"file_id":"file-123"}]}}; Library folder {"search_query":[{"q":"quarterly revenue"}],"scope":{"surfaces":["library"],"library_folders":["/Reports"]}}; photo filters {"search_query":[{"q":"photos"}],"scope":{"surfaces":["library"]},"filters":{"include_file_types":["image"],"image_taken_after":"2008-01-01T00:00:00Z","image_taken_before":"2008-12-31T23:59:59Z","image_location":{"country":"France"}}}.
- `files__read` — Read a known file or range, or expand a relevant search/find result; do not use as the first step for broad retrieval. Pass one read item per independent file/range, at most 5 items per call. Extra items are skipped with a warning; submit them in separate calls. Supports full-file text windows, context around a visible files.search/list/find/read result, and specific page text/images via mode='pages' with include_images=true. A PDF or document that contains screenshots, scans, figures, or photos is still a PDF or document: never use mode='image_file' for it; use mode='pages' with start_page and include_images=true. Use mode='image_file' only for a standalone native image file returned by a prior Files result, to return pixels plus extracted text. Returns text-only output in every mode when include_images=false is explicit, even if image defaults are enabled. Returns citable line-numbered content and emits next_read/next_start_line/next_start_page when more unread file content remains, plus next_image_read when a separate page-image continuation is available; use its explicit include_images=true call. Common calls: expand a search result {"read":[{"ref_id":"turn1file0","mode":"chunk_context"}]}; read PDF/document pages with embedded images {"read":[{"ref_id":"turn1file0","mode":"pages","start_page":10,"end_page":12,"include_images":true}]}; inspect a standalone native image file (never a PDF/document) {"read":[{"ref_id":"turn1file0","mode":"image_file"}]}.
- `files__find` — Find literal or regex text matches within a known ChatGPT conversation or file-library file. Use a ref/id visible in the conversation or returned by a prior Files result; do not invent a turnNfileM ref. Use only when you know an exact term, phrase, or heading; batch up to five likely exact variants as separate find items, or use a concise regex. The request has one top-level find array; put max_matches on each item, never at the top level, and do not send top-level response_length. Use files.search instead for broad questions, unknown locations, or uncertain wording. Returns text snippets only, not images; after finding relevant text or pages, use files.read to inspect page images. Supports line bounds and page bounds; paginate with match_offset/next_match_offset. Common call: {"find":[{"ref_id":"turn1file0","pattern":"Chapter 5"},{"ref_id":"turn1file0","pattern":"Chapter Five"}]}.

### skills
- `skills__list` — List available skills and their descriptions.
- `skills__read` — Read an available skill's complete instructions or a supporting file. For listed reference files, append the exact relative path to the skill root URI and read it with this tool. PDF, DOC, DOCX, XLS, XLSX, PPT, and PPTX files bundled under skills://plugins/ return extracted text; PDF text includes source page labels and spreadsheet output may be partial. Other binary formats and binary files outside installed plugin skills are not supported. Only read skill files under skill roots available in this conversation. Only use listed skill URIs; if none exist, do not guess plugin or skill names.

### user_settings
- `user_settings__get_user_settings` — Return the user's current settings along with descriptions and allowed values. Always call this FIRST to get the set of options available before asking for clarifying information (if needed) and before changing any settings.

### 3.2 Write/destructive/elevated actions excluded

- **GitHub:** repository/file/branch/commit/issue/PR creation or updates, comments/reactions/reviews, reviewer/label/assignee changes, thread resolution, workflow reruns, merge and auto-merge.
- **Dropbox:** create/upload/copy/move/delete/restore, sharing changes, Paper edits/comments and signature sends.
- **Linear:** issue/project/comment/label/document/release/milestone/initiative/status/diff/review writes, sharing and thread resolution.
- **Remote Desktop Commander:** file writes/edits/moves/deletes, directory creation, configuration changes, process interaction/termination, session/process kills and device shutdown. `start_process` is generic execution, not intrinsically read-only; used here only for a fixed bounded Git command and the authorized report.
- **Hatchable:** project/file/task writes, SQL/function execution, deploy, upload/import, fork and feedback submission.
- **Render:** resource/workflow creation or update, deploy/trigger/cancel, environment changes and blueprint approval.
- **Neon/Supabase:** SQL, schema/migration, project/branch/role/database/auth/storage/function writes, deploy, pause/restore/reset/rebase/merge.
- **Vercel:** deploy/promotion/rollback, domain/DNS/certificate, environment/config/secret, KMS/key, firewall/routing/flag, sandbox/session execution, cache mutation and resource deletion.
- **Trello/Todoist/Gmail/Google Calendar:** all task/card/mail/event writes, sends, responses, labels and deletes.
- **Replit/Webflow/Plugin Creator/Plugin Management:** app/site/design/plugin writes, publishing, sharing, uninstall and permission changes.
- **Automations:** create/update/run-now/notify-parent and schedule changes.
- **Files host:** Library upload/move/rename/delete/share and reference-image mutations. Only the one authorized report was created.

## 4. Project-scoped evidence

### 4.1 GitHub

- Repository `suniltnngl-gm/curl-ai-bridge`, ID `1443769540`, private, default branch `main`, not archived.
- Read actions: `mcp__GitHub__get_repo`, `mcp__GitHub__fetch_issue`.
- Roadmap Issue **#19**, ID `6221727989`, updated `2026-11-18T11:51:30Z`.
- Issue purpose says it is a remaining-work register and does not authorize merge, deployment, infrastructure changes or implementation of captured ideas.
- Its embedded PR state was checked **2026-11-05**; this run did not perform a live PR/CI audit.

### 4.2 Dropbox

- Exact record `cc-006c-cloud-inbox-auth-v1.json`, file ID `id:opctR6uvYWcAAAAAAAAANw`.
- Path `/Apps/curl-ai-bridge-cloud/protocol/extensions/cc-006c-cloud-inbox-auth-v1.json`; revision `6608b2b39e65980285971`.
- Server modified `2026-11-18T11:18:22Z`; size 1,776 bytes.
- Read actions: `mcp__Dropbox__get_file_metadata`, `mcp__Dropbox__fetch`.
- Record states `project_manager=ChatGPT`, `runtime_parent=AI_A`, `event_authority=coordination-only`, `worker_execution_authority=not-granted-by-storage-or-event`.
- Integrity: EdDSA over canonical JSON with integrity member omitted; cloud-supplied keys are not auto-trusted; trust pin is an out-of-band SHA-256 public-key fingerprint.
- Inbox policy: bounded-keyset polling, durable non-expiring local deduplication, no remote claims, no cloud-object deletion, no automatic inference retries, verification before worker handoff.
- Rollout remains not live: no published assignment, live poll, production signing key, worker dispatch, schedule integration or trusted-key pin.

### 4.3 Linear

- Authenticated workspace `aidev-tools`, ID `9e912d3a-12b6-4e53-94c7-5bcb9d85d873`; `whoami` returned `connection.access=all`.
- Exact `list_projects(query="cURL AI Bridge", limit=10)` returned `projects=[]`, `hasNextPage=false`.
- `list_agent_skills` returned no entries.
- Read access is confirmed; project mapping is NOT RECONCILED. Do not infer global absence from this bounded search.

### 4.4 Desktop Commander and local repositories

- Online device `sunilkr-H81`, ID `6f9a336b-2280-4e52-bcd0-0b1b3426e948`, version 0.3.4.
- Runtime: Linux, Node.js 22.23.4, Python 3.14.4, default shell `/bin/bash`.
- Remote-call usage: **12% remaining** at identity check.
- Config reported `allowedDirectories=[]`, but exact paths were listed and Git commands succeeded; no broader access conclusion is drawn.
- Existing report folder was verified and contained 16 files before creation.

**cURL AI Bridge repo**
- `/home/sunilkr/Code/curl-ai-bridge`; branch `test/ubuntu-self-hosted-runner-smoke`.
- HEAD `b90d2c2b0594ddc0ac517834b45a855aaee8e1cd`; upstream `origin/test/ubuntu-self-hosted-runner-smoke`.
- Ahead 17 / behind 0; dirty entries 0; working and cached `git diff --check` exit 0.

**Work-ledger repo**
- `/home/sunilkr/Code/multi-project-workspace`; branch `master`.
- HEAD `ea96dc95b60b9c6f82dbddc3c6c7c4baf4d5aa05`; upstream `origin/master`.
- Ahead 7 / behind 0; dirty entries 4; working and cached `git diff --check` exit 0.
- Dirty filenames/content were not inspected; all existing work was preserved.

**Inspection deviation:** Git check output was redirected to `/tmp/curl-ai-bridge-diff-check.out` and `/tmp/curl-ai-bridge-cached-diff-check.out`. Both checks exited 0 and displayed no output. The scratch paths were not inspected or removed; no cleanup mutation was attempted. This narrow deviation from the no-file-edits rule is disclosed.

## 5. Reusable lessons with provenance

### 5.1 Discovery and adapter abstraction
- **FACT:** Native skill listing was empty while 945 actions were exposed and Hatchable separately advertised 57 platform guides. Evidence: `skills__list`, `ALL_TOOLS`, Hatchable `list_skills`.
- **INFERENCE:** Catalog, tool registry, app permission, authenticated identity and resource-level read success are independent adapter states. Evidence: Todoist/Gmail/Calendar actions exposed while app permission said `not_installed`; GitHub/Dropbox/Linear reads succeeded.
- **PROPOSAL:** Track `CATALOG_ONLY`, `TOOL_EXPOSED`, `APP_PERMISSION_FOUND`, `AUTHENTICATED`, `READ_TESTED`, `WRITE_TESTED`, `UNAVAILABLE_IN_RUN`, `NEEDS_OPERATOR`, `NOT_RECONCILED`; never infer a stronger state from a weaker one.

### 5.2 Permission and fail-closed behavior
- **FACT:** Plugin Management reported global `Allow low-risk actions` and per-app `Use my default` for ten named apps. This is ChatGPT approval metadata, not provider OAuth scope.
- **FACT:** Hatchable API/MCP access guides document declared route/tool access and role-based grants.
- **INFERENCE:** ChatGPT approval, provider authentication, resource authorization and application policy are separate gates.
- **PROPOSAL:** Per-action risk classification and explicit read allowlists; generic command execution, SQL, function execution, tool loops and deploy actions default to deny during inspection.

### 5.3 Connection versus exposure
- **FACT:** Todoist/Gmail/Calendar app permission returned `not_installed` although their namespaces exposed 49/20/10 actions.
- **FACT:** GitHub repo/issue, Dropbox file, Linear workspace and Desktop Commander device reads succeeded.
- **PROPOSAL:** Persist connection evidence with timestamp and scope; prior success does not imply current connection.

### 5.4 IDs, scoping, pagination and provenance
- **FACT:** GitHub repository/issue IDs, Dropbox file ID/revision, Linear workspace ID and Desktop Commander device ID were used.
- **FACT:** Linear project listing is cursor-based (max 50/page); Hatchable pagination guide recommends keyset cursors with unique tie-breakers and says cursors are not authorization.
- **FACT:** Dropbox fetch documents a 5 MiB extraction limit and returns an error rather than partial success on extraction failure.
- **PROPOSAL:** Store provider-native opaque IDs and cursor type/version; bind reads to exact resources or project filters; preserve revisions, timestamps, action names and query scope.

### 5.5 Multi-instance/session/configuration
- **FACT:** Hatchable external API connections are project-scoped by default; provider-app credentials are account-scoped; `per_user=true` changes connection semantics. Parallel OAuth flows use distinct single-use state values.
- **FACT:** Hatchable MCP tokens are project-audience scoped; access JWTs are documented as 1 hour and refresh tokens as 30 days from grant, with refresh not extending the refresh-token window. Revocation invalidates both.
- **UNKNOWN:** CLI session/config sharing was not inspected.
- **PROPOSAL:** Separate provider account, project connection, CLI instance, working directory, session and invocation identities. Shared sessions require explicit per-CLI evidence.

### 5.6 Model/catalogue/quota/invocation
- **FACT:** Hatchable agent guide distinguishes portable function tools from provider-native tools. `ai.streamText` is one model round and does not run the function tool loop; `ai.generateText` with execute/maxSteps runs it.
- **FACT:** Hatchable AI ledger null cost means unpriced, not free; `cost_is_complete=false` means cost is incomplete/floor; rollups cache about 60 seconds.
- **FACT:** Each tool-loop step is another model invocation; maxSteps caps the loop; tool errors can be returned to the model, which may try another path.
- **UNKNOWN:** No cURL AI Bridge provider catalogue, entitlement, quota or inference was queried.
- **PROPOSAL:** Store exact provider model IDs, alias-resolution evidence, native capability flags, cost provenance, quota bucket and entitlement separately. Unknown/unpriced is never free.

### 5.7 Retry, timeout, cancellation and terminal state
- **FACT:** Hatchable scheduler docs say delivery is not exactly-once; handlers must be idempotent. Named `scheduler.at` tasks upsert. Free-plan one-shot budget is documented as 200/day and max two deferred one-shots concurrently per project.
- **FACT:** Hatchable limits documented: 30 s CPU, 300 s wall clock, 128 MB memory, ~60 s public HTTP, ~65 s recurring cron, ~310 s one-shot, 55 s outbound fetch maximum, 5 s per DB statement. Hatchable-specific, not cURL AI Bridge limits.
- **FACT:** Desktop Commander remote execution waits at most 3 seconds synchronously; pending calls return PID/call IDs and must be queried rather than re-run while pending.
- **PROPOSAL:** Represent pending/executing/succeeded/failed/cancelled/timed-out/skipped/unknown independently; use idempotency keys and query pending results before retry.

### 5.8 Portability
- **FACT:** Hatchable maps function-style JSON Schema tools to provider-specific schemas but documents provider-native tools as provider-specific.
- **INFERENCE:** A common invocation contract needs capability negotiation and explicit native extensions.
- **PROPOSAL:** Provider-neutral core plus native-feature adapters and per-provider/per-CLI-version contract tests.

### 5.9 Webhook/collaboration security
- **FACT:** Hatchable webhook guide verifies exact `req.rawBody`, constant-time HMAC and optional timestamp replay protection; provider header/encoding remain provider-specific.
- **FACT:** Dropbox CC-006C requires out-of-band trust pinning and verification before worker handoff; storage/event presence does not grant execution authority.
- **PROPOSAL:** Preserve signed bytes, canonicalization version, key fingerprint provenance, replay window, event ID, dedupe claim and authority decision separately.

### 5.10 Safe fallback
- **FACT:** Linear project search returned no match; no broad personal-content search was used as fallback.
- **FACT:** No permission denial occurred; `not_installed` is not a permission denial.
- **PROPOSAL:** Use NOT RECONCILED for unknown paths, mappings, quotas, sessions or resource identity; an empty bounded query is not proof of global absence.

## 6. Hatchable documentation reconciliation

**Access-mode discrepancy — resolved by current guide evidence.** `api/access` distinguishes end users (`user`, with `[auth]`) from project collaborators (`member`/`admin`). The MCP guide documents owner-mode member/admin grants and user-mode user grants. Therefore `user` is not generically invalid for MCP; it is limited to the user-mode plane.

**Streaming discrepancy — unresolved.** `api/stream-a-response` documents `Response.sse` and `res.write`; `meta/platform-constraints` says the isolate lacks EventSource/WebSocket globals and `res.write`. The streaming guide also says the platform front buffers delivery until handler completion. Do not claim progressive delivery; treat server stream API and client-visible streaming as separate, unverified capabilities.

## 7. cURL AI Bridge architecture implications

Maintain distinct records/interfaces:
1. **ProviderConfig:** endpoint, auth owner, account, credential reference (never value), billing lane, quota bucket and entitlement evidence.
2. **CLIInstance:** executable/version, host/device, process identity, working directory, config profile, environment reference and supported modes.
3. **Invocation:** request ID, exact model ID, adapter/version, arguments, timeout, cancellation token, retry budget, usage/cost evidence and terminal outcome.
4. **Session:** provider-native conversation ID, isolation boundary, ownership, sharing mode and provenance.
5. **ModelDescriptor:** provider-native model ID, alias mapping, catalogue source/time, features and validation result.
6. **OrchestrationRun:** parent task ID, worker assignment, transitions, idempotency key, lease/fencing reference and evidence links.
7. **CollaborationEvent:** event/turn ID, author, signature/trust key, expiry, dedupe claim and coordination/execution authority.

Session isolation remains default. Multiple interactive/headless instances require per-CLI evidence. Reject unknown model IDs before dispatch when a trustworthy catalogue exists. Keep catalogue visibility, entitlement, quota and price separate. Inference success must not complete a task or imply collaboration synchronization.

## 8. Regression-test candidates

1. Empty native skill catalog + exposed actions must not produce CONNECTED.
2. `not_installed` app metadata blocks resource-read attempts despite exposed actions.
3. Successful identity read does not imply every resource is accessible; verify project mapping separately.
4. Stable IDs and provider cursors paginate without broadening scope.
5. Unknown model ID is rejected before invocation when catalogue validation is required.
6. Provider-native tool capability is never silently advertised as portable.
7. Null/unpriced cost and missing quota remain UNKNOWN, never zero/free.
8. Streaming token request does not execute tools without an explicit loop executor.
9. Pending remote process is queried rather than re-running the original command.
10. Duplicate scheduler delivery is idempotent; named-task upsert only where documented.
11. Webhook signatures use exact raw bytes; expired/replayed events fail closed.
12. Inference, orchestration task and collaboration delivery terminal states remain independent.
13. Each read records provider, action, stable resource ID, timestamp/revision and query scope.
14. Git inspection preserves dirty/untracked state and cannot stage/clean/stash/change refs.
15. Report creation uses exclusive-create; name collision fails rather than overwrites.

## 9. Operations, limits, gaps and exclusions

**Used:** tool/action registry enumeration; native skill list; Hatchable skill registry and 11 guide reads; Linear agent-skill list; named app permission metadata; GitHub repo/Issue #19 reads; Dropbox exact metadata/content read; Linear identity and bounded project search; Desktop Commander identity/device/config/directory reads; bounded Git status/rev-parse/upstream count/diff checks; one exclusive-create report write with read-back verification.

**Not attempted:** connected-system writes; Git stage/commit/push/merge/rebase/reset/clean/stash; PR/issue/task/comment changes; deployment/infrastructure/database mutation; OAuth/connect/reconnect/permission changes; inference/model invocation; worker dispatch; paid usage/quota consumption; credential/token/secret/environment reads; broad personal-content searches; provider connection tests for unverified providers.

**Limits:** Desktop Commander reported 12% monthly remote-call usage remaining; remote process wait max 3 s. Dropbox fetch max 5 MiB. Linear list_projects max 50/page with cursor. Some GitHub workflow wrappers are first-page-only. Hatchable-specific documented budgets are in §5.7. No provider rate-limit response or permission denial occurred.

**Coverage gaps:** no native ChatGPT skill roots; no Hatchable project/account resource read; no Linear project mapping; no authenticated resource reads for Trello, Render, Neon, Supabase, Vercel, Replit, Webflow, Plugin Creator, Automations, Todoist, Gmail or Google Calendar; no CLI session/config sharing verification; no model catalogue/quota/entitlement verification; no live streaming verification.

**Potential later operator-side actions (not requested):** establish an approved Linear project mapping if one exists; restore/install Todoist/Gmail/Calendar only if required; clarify Hatchable streaming contract; expose current provider/CLI quota evidence through approved non-secret status surfaces.

## 10. Report artifact

**Path:** `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections/plugin-capability-lessons-20261119T185855+0530.md`  
**Destination:** existing `reports/workspace-inspections/` directory on verified device; 16 existing files listed before creation.  
**Creation:** one new file with exclusive-create semantics (`O_CREAT | O_EXCL`); no overwrite or folder creation.  
**Verification:** byte-for-byte read-back, size, line count and SHA-256 computed after write; exact values returned with checkpoint response.  
**Disposition:** one report created; no source, connected record, Git state, task, lease, deployment or database changed.

## Appendix A — Complete exposed action-name manifest

All action names returned by this runtime, grouped by exact namespace. Exposure is not authorization.

### user_settings (2)
get_user_settings, set_setting

### Google_Calendar (10)
list_events, get_event, list_calendars, suggest_time, create_event, update_event, delete_event, respond_to_event, search_events, get_profile

### Gmail (20)
create_draft, update_draft, send_message, reply, forward, list_drafts, get_thread, get_message, search_threads, label_thread, unlabel_thread, apply_sensitive_thread_label, list_labels, label_message, unlabel_message, apply_sensitive_message_label, create_label, update_label, delete_label, get_profile

### GitHub (89)
add_comment_to_issue, add_issue_assignees, add_issue_labels, add_reaction_to_issue_comment, add_reaction_to_pr, add_reaction_to_pr_review_comment, add_review_to_pr, compare_commits, convert_pull_request_to_draft, create_blob, create_branch, create_commit, create_file, create_issue, create_pull_request, create_tree, delete_file, dismiss_pull_request_review, download_user_content, download_workflow_artifact, enable_auto_merge, fetch, fetch_blob, fetch_commit, fetch_commit_workflow_runs, fetch_file, fetch_issue, fetch_issue_comments, fetch_pr, fetch_pr_comments, fetch_pr_file_patch, fetch_pr_patch, fetch_workflow_job_logs, fetch_workflow_job_steps, fetch_workflow_run_artifacts, fetch_workflow_run_jobs, get_commit_combined_status, get_issue_comment_reactions, get_pr_diff, get_pr_info, get_pr_reactions, get_pr_review_comment_reactions, get_profile, get_repo, get_repo_collaborator_permission, get_user_login, get_users_recent_prs_in_repo, label_pr, list_installations, list_installed_accounts, list_pr_changed_filenames, list_pull_request_review_threads, list_pull_request_reviews, list_recent_issues, list_repositories, list_repositories_by_affiliation, list_repositories_by_installation, list_user_org_memberships, list_user_orgs, lock_issue_conversation, mark_pull_request_ready_for_review, merge_pull_request, remove_issue_assignees, remove_issue_label, remove_pull_request_reviewers, remove_reaction_from_issue_comment, remove_reaction_from_pr, remove_reaction_from_pr_review_comment, reply_to_review_comment, request_pull_request_reviewers, rerun_failed_workflow_run_jobs, rerun_workflow_job, resolve_review_thread, search, search_branches, search_commits, search_installed_repositories_streaming, search_installed_repositories_v2, search_issues, search_prs, search_repositories, unlock_issue_conversation, unresolve_review_thread, update_file, update_issue, update_issue_comment, update_pull_request, update_ref, update_review_comment

### Replit (8)
ask_question, create_app_from_prompt, publish_app, get_publish_status, list_apps, resolve_app_by_name, search_apps, update_app_using_prompt

### Remote_Desktop_Commander (30)
list_devices, who_am_i, get_tool_result, list_remote_tool_calls, shutdown, get_config, set_config_value, read_file, read_multiple_files, write_file, write_pdf, create_directory, list_directory, move_file, start_search, get_more_search_results, stop_search, list_searches, get_file_info, edit_block, start_process, read_process_output, interact_with_process, force_terminate, list_sessions, list_processes, kill_process, get_usage_stats, get_recent_tool_calls, review_device_call

### Webflow (38)
ask_webflow_ai, data_agent_instructions_tool, data_analyze_tool, data_aeo_tool, data_apps_tool, data_campaigns_tool, data_cms_tool, data_localization_tool, data_optimize_tool, data_pages_tool, data_scripts_tool, data_sites_tool, data_members_tool, data_comments_tool, data_enterprise_tool, data_forms_tool, data_fonts_tool, data_webhook_tool, data_sitemap_tool, data_assets_tool, get_asset_preview, data_style_tool, data_component_tool, data_component_props_tool, data_component_variants_tool, data_variable_tool, data_interactions_tool, data_element_tool, data_element_settings_tool, data_element_builder, data_whtml_builder, data_component_builder, asset_tool, element_snapshot_tool, designer_tool, webflow_guide_tool, get_more_tools, webflow_home

### Todoist (49)
add_tasks, complete_tasks, uncomplete_tasks, update_tasks, reschedule_tasks, find_tasks, find_tasks_by_date, find_completed_tasks, add_projects, update_projects, find_projects, project_management, project_move, add_sections, update_sections, find_sections, add_comments, find_comments, update_comments, add_reminders, find_reminders, update_reminders, view_attachment, add_labels, update_labels, find_labels, find_filters, add_filters, update_filters, find_activity, get_productivity_stats, get_project_health, get_project_activity_stats, analyze_project_health, get_workspace_insights, get_overview, delete_object, fetch_object, reorder_objects, user_info, get_user_status, set_user_status, find_project_collaborators, manage_assignments, export_project_template, import_project_template, list_workspaces, search, fetch

### Plugin_Creator (9)
create_plugin, get_owned_plugin_archive, get_plugin_files, get_plugin_metadata, get_plugin_sharing, list_owned_personal_plugins, list_plugin_releases, share_plugin, update_plugin

### Render (48)
approve_blueprint, cancel_cron_job_run, cancel_flow_run, create_blueprint, create_cron_job, create_key_value, create_postgres, create_static_site, create_web_service, create_workflow, create_workflow_version, get_blueprint, get_deploy, get_flow, get_flow_run, get_flow_run_results, get_flow_run_step, get_key_value, get_metrics, get_postgres, get_selected_workspace, get_service, get_workflow, get_workflow_run, get_workflow_run_results, get_workflow_task, get_workflow_version, list_deploys, list_events, list_flow_run_steps, list_flow_runs, list_key_value, list_log_label_values, list_logs, list_postgres_instances, list_services, list_workflow_runs, list_workflow_tasks, list_workflow_versions, list_workflows, list_workspaces, plan_blueprint, query_render_postgres, run_cron_job, select_workspace, trigger_deploy, update_blueprint, update_environment_variables

### Supabase (36)
search_docs, list_organizations, get_organization, list_projects, get_project, get_cost, confirm_cost, create_project, pause_project, restore_project, list_tables, list_extensions, list_migrations, apply_migration, execute_sql, query_logs, get_advisors, get_project_url, get_publishable_keys, generate_typescript_types, list_edge_functions, get_edge_function, deploy_edge_function, create_branch, list_branches, delete_branch, merge_branch, reset_branch, rebase_branch, create_notebook, list_notebooks, get_notebook, run_notebook, delete_notebook, submit_feedback, delete_feedback

### Neon (141)
list_organizations, run_sql, run_sql_transaction, describe_table_schema, get_database_tables, prepare_database_migration, complete_database_migration, describe_branch, get_connection_string, get_neon_auth_config, explain_sql_statement, prepare_query_tuning, complete_query_tuning, list_slow_queries, inspect_database, search, fetch, search_docs, get_doc, send_feedback, list_incidents, list_projects, count_projects, describe_project, create_project, update_project, delete_project, recover_project, list_project_permissions, list_project_members, list_regions, list_operations, get_operation, get_project_consumption, get_branch_consumption, list_branches, get_branch, create_branch, update_branch, delete_branch, get_default_branch, set_default_branch, reset_from_parent, compare_database_schema, finalize_branch_restore, list_postgres_roles, get_postgres_role, create_postgres_role, delete_postgres_role, reset_postgres_role_password, list_postgres_databases, get_postgres_database, create_postgres_database, update_postgres_database, delete_postgres_database, list_postgres_endpoints, list_branch_computes, get_postgres_endpoint, create_postgres_endpoint, update_postgres_endpoint, delete_postgres_endpoint, start_postgres_endpoint, suspend_postgres_endpoint, restart_postgres_endpoint, list_snapshots, get_snapshot_schedule, set_snapshot_schedule, create_snapshot, update_snapshot, delete_snapshot, restore_snapshot, get_auth, provision_neon_auth, disable_auth, update_auth_config, list_auth_oauth_providers, add_auth_oauth_provider, update_auth_oauth_provider, delete_auth_oauth_provider, list_auth_trusted_domains, add_auth_trusted_domain, delete_auth_trusted_domain, create_auth_user, delete_auth_user, update_auth_user_role, get_auth_oauth_server, update_auth_oauth_server, list_auth_oauth_clients, get_auth_oauth_client, create_auth_oauth_client, update_auth_oauth_client, delete_auth_oauth_client, rotate_auth_oauth_client_secret, update_auth_allow_localhost, update_auth_email_and_password, send_auth_test_email, update_auth_plugins_magic_link, update_auth_plugins_organization, update_auth_plugins_phone_number, update_auth_webhooks, update_auth_logs_export, get_data_api, provision_neon_data_api, update_data_api, delete_data_api, query_logs, list_log_fields, list_log_field_values, query_loki_logs, get_ai_gateway, list_functions, get_function, update_function, delete_function, deploy_function, list_functions_custom_domains, register_functions_custom_domain, delete_functions_custom_domain, list_triggers, get_trigger, create_trigger, update_trigger, delete_trigger, list_credentials, create_credential, revoke_credential, rotate_credential, get_storage, list_storage_buckets, create_storage_bucket, delete_storage_bucket, list_storage_objects, delete_storage_object, delete_storage_objects_by_prefix, presign_storage_object, get_realtime, enable_realtime, disable_realtime, get_realtime_secret, rotate_realtime_secret, update_auth_email_provider

### Hatchable (34)
create_project, get_project, list_agent_tasks, update_agent_task, list_projects, deploy, write_file, write_files, read_file, grep, list_files, patch_file, delete_file, execute_sql, get_schema, run_function, view_logs, list_deployments, list_functions, get_deployment, list_cron_jobs, update_project, import_file_from_url, search_documentation, dry_run_deploy, create_preview_link, upload_file, list_pending_uploads, run_code, fork_project, search_projects, list_skills, read_skill, submit_platform_feedback

### Dropbox (39)
check_job_status, check_upload_file_status, copy, create_file_request, create_folder, create_shared_link, delete, download_link, fetch, file_preview, get_file_metadata, get_file_request, get_shared_link_metadata, list_file_requests, list_file_revisions, list_folder, list_restore_events, list_shared_links, move, paper_apply_markdown, paper_comment, paper_create_document, paper_edit_content, paper_edit_table, paper_get_doc_history, paper_insert, paper_insert_image, paper_list_recent_docs, paper_read_document, restore_file_revision, restore_folder, search, sign_cancel_signature_request, sign_create_signature_request_draft, sign_download_signature_request, sign_list_signature_requests, sign_send_signature_request_reminders, upload_file, who_am_i

### Linear (93)
get_attachment, prepare_attachment_upload, prepare_file_upload, create_attachment_from_upload, create_attachment, delete_attachment, list_agent_skills, get_agent_skill, list_comments, save_comment, delete_comment, list_cycles, list_custom_views, get_document, list_documents, save_document, extract_images, get_issue, list_issues, save_issue, list_issue_statuses, get_issue_status, list_issue_labels, save_issue_label, create_issue_label, retire_issue_label, restore_issue_label, list_projects, get_project, save_project, list_project_labels, retire_project_label, restore_project_label, save_project_label, list_release_pipelines, list_releases, get_release, save_release, list_release_notes, get_release_note, save_release_note, share_issue, unshare_issue, list_milestones, get_milestone, save_milestone, get_notifications, mark_notification, list_teams, get_team, get_triage_responsibility, list_templates, get_template, list_users, get_user, get_workspace, search_documentation, get_diff, list_diffs, get_diff_threads, save_diff_comment, resolve_diff_thread, delete_diff_comment, submit_diff_review, update_diff_finding, update_diff, merge_diff, list_review_criteria, delete_review_criterion, get_agent_context, record_agent_learning, report_agent_friction, report_helpful_agent_context, whoami, list_customers, save_customer, delete_customer, list_customer_needs, save_customer_need, delete_customer_need, list_initiatives, get_initiative, save_initiative, list_initiative_labels, save_initiative_label, create_initiative_label, retire_initiative_label, restore_initiative_label, get_status_updates, save_status_update, delete_status_update, search, fetch

### Trello (15)
trelloReadCard, trelloReadBoard, trelloReadChecklist, trelloReadInbox, trelloReadList, trelloReadMember, trelloReadPlanner, trelloReadWorkspace, trelloWriteBoard, trelloWriteCard, trelloWriteChecklist, trelloWriteInbox, trelloWriteList, trelloSearch, trelloWritePlanner

### Vercel (260)
search_vercel_documentation, get_git_deployment_context, create_git_project, open_deployments, get_runtime_logs, get_runtime_errors, get_project_trace, list_agent_run_projects, list_agent_runs, get_agent_run, get_agent_run_trace, get_access_to_vercel_url, web_fetch_vercel_url, authorize_team_sso, authorize_team_access, submit_feedback, get_purchase_quote, buy_domain, get_domain_order, list_toolbar_threads, get_toolbar_thread, change_toolbar_thread_resolve_status, reply_to_toolbar_thread, edit_toolbar_message, add_toolbar_reaction, get_board_identity, list_board_channels, list_board_threads, get_board_thread, start_board_thread, reply_to_board_thread, react_to_board_message, label_board_message, wait_for_board_changes, list_ai_gateway_models, get_ai_gateway_model, get_ai_gateway_leaderboard, get_ai_gateway_usage, list_drives, get_or_create_drive, delete_drive, delete_session_snapshot, delete_sandbox, get_flags_project_disconnection_link, get_project_deletion_link, get_domains_records_by_record_id, get_storage_stores_by_id, list_access_groups, read_access_group_project, read_access_group, list_access_group_members, list_access_group_projects, list_billing_charges, list_contract_commitments, list_bulk_redirects, list_bulk_redirect_versions, get_connector, get_connector_project_connection, get_deployment_feature_flags, get_domain_project_domains, list_drains, get_drain, get_shared_env_var, list_event_types, get_edge_configs, get_edge_config, get_edge_config_backups, get_edge_config_backup, get_edge_config_item, get_edge_config_items, get_edge_config_token, get_edge_config_tokens, get_configuration, list_integration_configuration_products, list_integration_configurations, git_namespaces, list_integration_billing_plans, search_repo, list_kms_issuers, get_kms_issuer, get_microfrontends_config, get_microfrontends_config_for_project, get_observability_configuration_projects, get_project_env, get_rolling_release, get_rolling_release_billing_status, get_rolling_release_config, list_promote_aliases, list_project_routes, list_project_route_versions, list_flags_project_connections, list_flags, get_flag, list_flag_versions, list_feature_flag_sdk_keys, list_flag_segments, get_flag_segment, get_flag_settings, aggregate_events, count_events, aggregate_pageviews, count_pageviews, get_domain_availability, get_contact_info_schema, get_domain_contact_verification, get_domain_price, get_order, get_tld, get_tld_price, list_supported_tlds, get_active_attack_status, get_bypass_ip, get_firewall_config, list_team_flags, list_team_flag_settings, list_vercel_ci_invocation_attempts, get_vercel_ci_invocation, list_vercel_ci_job_definitions, get_vercel_ci_job_definition, list_vercel_ci_job_runs, get_vercel_ci_job_run, get_vercel_ci_job_run_logs, list_vercel_ci_task_definitions, get_vercel_ci_task_run_logs, list_vercel_ci_task_runs, get_vercel_ci_invocation_logs, get_vercel_ci_task_logs, get_vercel_ci_invocation_tree, get_webhooks, list_projects, filter_project_envs, get_deployment, list_connectors, list_connector_project_connections, list_project_connector_connections, list_deployment_aliases, get_observability_schema, list_flags_v2, list_named_sandboxes, get_named_sandbox, list_sessions, get_session, list_session_commands, get_session_command, get_session_command_logs, list_session_snapshots, get_session_snapshot, list_teams, get_team, list_team_flags_v2, get_auth_user, list_vercel_ci_invocations, list_deployment_events, list_user_events, list_team_members, list_aliases, get_alias, list_domains, get_domain, get_records, list_deployment_files, get_domain_config, list_deployments, get_remote_cache_status, list_certs, get_cert_by_id, get_deployment_file_contents, get_domain_verification_record, get_project, list_project_custom_environments, get_custom_environment, list_project_domains, get_project_domain, patch_url_protection_bypass, update_record, update_drain, patch_edge_config_items, update_kms_issuer, update_kms_issuer_policy, update_project_protection_bypass, update_rolling_release_config, edit_route, update_flag, update_flag_segment, update_flag_settings, update_firewall_config, cancel_deployment, update_connector, update_sandbox, update_project, edit_project_env, create_storage_stores_blob, restore_redirects, update_bulk_redirect_version, upsert_connector_project_connection, rerequest_check, create_drain, test_drain, invalidate_by_src_images, invalidate_by_tags, create_edge_config, restore_edge_config_backup, create_edge_config_token, create_kms_issuer, create_kms_signing_key, activate_kms_signing_key, revoke_kms_signing_key, create_kms_issuer_policy, approve_rolling_release_stage, complete_rolling_release, start_rolling_release, pause_project, request_rollback, add_route, generate_route, update_route_versions, unpause_project, create_trace_session, get_bulk_availability, get_bulk_price, search_domains, update_attack_challenge_mode, retry_vercel_ci_invocation, add_project_domain, create_project_env, request_promote, create_project, create_deployment, assign_alias, create_record, upload_file, create_observability_query, create_sandboxes_v2, run_session_command, kill_session_command, extend_session_timeout, create_session_directory, read_session_file, write_session_files, update_session_network_policy, create_sandboxes_sessions_by_session_id_snapshot_v2, stop_session, create_sandboxes_v3, create_sandboxes_sessions_by_session_id_snapshot_v3, create_sandboxes_v4, create_or_transfer_domain, artifact_query, record_events, issue_cert, verify_project_domain, replace_domain_dns_records, accept_project_transfer_request, stage_redirects, update_edge_config, stage_routes, create_flags_project_connection, create_flag, create_sdk_key, put_firewall_config, upload_artifact

### Automations (7)
create, get, list_event_sources, notify_parent, peek, run_now, update

### Plugin_Management (4)
get_app_permissions, get_plugin_dependencies, uninstall_app, update_app_permissions

### files (11)
create_reference_image, update_reference_image, delete_reference_image, list_reference_images, list, search, read, find, materialize, manage_library, share

### skills (2)
read, list

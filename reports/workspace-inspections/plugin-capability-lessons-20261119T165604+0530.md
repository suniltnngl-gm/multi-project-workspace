
# cURL AI Bridge — Plugin Capability Lessons Checkpoint

## Run and coverage

- Run timestamp: 2026-11-19T16:56:04+05:30 (device-local timestamp for artifact creation).
- Runtime surface: ChatGPT tool registry enumerated directly through the current tool catalog.
- Exposed actions: 945 across 21 namespaces.
- ChatGPT installed skill roots: 0; skills__list returned [].
- Hatchable platform skill registry: 57 entries; list_skills completed successfully.
- Linear agent-skill registry: 0 entries; hasNextPage=false.
- Read skill documents: 11 unique Hatchable guides, listed below.
- Scope: exact cURL AI Bridge GitHub repository and Issue #19; one exact Dropbox protocol record; exact Linear project-name search; two verified local Git repositories; bounded plugin-permission metadata. No broad personal-content search.
- Completeness: all action names exposed in this invocation were enumerated. Descriptions were reviewed for selected read actions and relevant mixed/side-effect actions, not all 945 schemas. No claim that every provider account was connected or every provider skill/document was inspected.

## Skill/catalog evidence

### ChatGPT skill roots
The native skills__list action returned an empty array. Therefore there were no installed ChatGPT skill roots available to read in this run. The skills__read action is exposed but has no valid skill URI to consume.

### Hatchable platform skills (not ChatGPT plugin skill roots)
Hatchable list_skills returned 57 platform how-to guides. This is a separate in-product platform registry, not evidence that 57 ChatGPT plugins are installed. The following 11 guides were read through read_skill:

- meta/platform-constraints
- api/access
- mcp/expose-an-mcp-tool
- ai/build-an-agent-with-tools
- ai/inspect-llm-call-history
- ai/use-a-provider-directly
- api/stream-a-response
- data/query-with-pagination
- integrations/connect-an-external-api
- integrations/verify-a-webhook
- ops/read-the-logs

Current Hatchable skill registry:
- admin/recognize-the-project-admin: Gate an admin-only route to the project's owner (or any admin collaborator) without building a login form or an app-level users table.
- ai/add-a-knowledge-base: A knowledge base is the storage half of RAG: put text + metadata, query by semantic similarity (pgvector embeddings).
- ai/add-an-llm-endpoint: Scaffold a route that takes a prompt, calls a language model, and returns the response.
- ai/add-rag-search: Retrieval-augmented generation: index your content as embeddings, retrieve the top-K relevant chunks for a query, pass them to the LLM as context.
- ai/build-an-agent-with-tools: Define tools the model can call, pass them to `ai.generateText` with `maxSteps`, and the runtime drives the loop: model picks a tool → your…
- ai/inspect-llm-call-history: Every `ai.generateText` / `ai.streamText` / `ai.embed` / `ai.fetch` call is logged to the platform's AI ledger automatically — model…
- ai/show-ai-spend: Every `ai.generateText` / `ai.streamText` / `ai.fetch` / `ai.generateImage` call writes a priced row into the platform's `ai_call_logs`.
- ai/use-a-provider-directly: `ai.fetch` escape hatch for what `generateText` doesn't cover: image generation, audio, files, batches, prompt caching, or any new endpoint…
- api/access: Every API route and MCP tool on Hatchable must declare who can call it.
- api/add-an-api-route: File-based routing under `api/`.
- api/proxy-an-external-api: Call third-party APIs from server-side handlers, never from the browser.
- api/scheduler: Routes declared `access: 'scheduler'` are invoked only by the platform's scheduler — `[[cron]]` blocks in `hatchable.toml` or runtime…
- api/stream-a-response: Send a response as it is produced instead of all at once: tokens from a model as they arrive, progress events from a long job, a large export row by row.
- auth/add-google-signin: Google sign-in for the app's END USERS (the `[auth]` plane — not project collaborators).
- auth/build-a-login-page: Ship your own `/login` page as part of enabling `[auth]` — styled like YOUR app, wired to the platform's auth client.
- auth/enable-app-auth: Give your app its own sign-up/sign-in for end users — people who find the app and create an account themselves, as opposed to collaborators you invite.
- auth/gate-an-endpoint: Require a signed-in caller before a route runs — login handled by the platform: `export const access = 'member'` for collaborators…
- auth/handle-the-anonymous-case: Serve one public route to both signed-in users and anonymous visitors — check `req.member` and vary the response.
- auth/handle-user-deletion: When the project owner deletes an end user from the console's Users tab, the platform runs a deletion ceremony: it revokes that user's AI…
- background/add-a-cron-job: Schedule a recurring API route via `[[cron]]` blocks in `hatchable.toml`.
- background/add-a-scheduled-digest: Composite pattern: cron job fires on schedule, queries the database for what to send, calls `email.send` for each recipient.
- background/defer-with-scheduler: `scheduler.at(when, route, opts?)` arms a one-shot or recurring fire of any `api/*.js` route.
- browser/scrape-a-page: `browser.session` runs a function with a Chromium page instance, letting you navigate, fill forms, click, and extract data.
- browser/take-a-screenshot: `browser.screenshot(url)` returns a PNG buffer of any URL rendered by managed Chromium.
- config/declare-configurable-fields: Expose buyer-editable settings without building an admin UI.
- config/read-config-values: Read buyer-editable settings declared via `[[config]]` in `hatchable.toml`.
- data/add-a-table: Create a Postgres table with a SQL migration — the platform applies `migrations/*.sql` in filename order on deploy; once applied, a…
- data/one-off-backfill: Run a data migration that fires once on deploy and never again.
- data/query-with-pagination: Paginate SQL queries with keyset cursors on `id`/`created_at` instead of OFFSET — stable and fast on Postgres.
- data/row-access: Row access — let Postgres decide which rows a caller may touch
- data/transactions: Run multiple SQL writes atomically with `db.transaction` on the project's Postgres database.
- data/write-a-safe-migration: Migrate Postgres schema safely, and define the project's functions, procedures and triggers — a migration is the only place a routine can be created.
- design/apply-house-design: Apply this when a user building on Hatchable has **not specified their own design direction**.
- email/send-transactional-email: `email.send` for one-off transactional messages — receipts, confirmations, password resets, digests.
- integrations/connect-an-external-api: Talk to Reddit, GitHub, Notion, Linear, Slack, or any other HTTP API from a Hatchable handler without writing OAuth flow code or storing tokens yourself.
- integrations/verify-a-webhook: Verify inbound webhook signatures (Stripe, GitHub, Shopify, Slack) with `webhooks.verifyHmac` — constant-time, replay-window safe.
- mcp/expose-an-mcp-tool: Let an AI client (Claude, ChatGPT, Cursor, etc.) call your project's logic directly.
- meta/file-platform-feedback: Hatchable is built on top of an isolate runtime, an SDK, an MCP layer, a deploy pipeline, and a docs corpus — all of which have rough edges.
- meta/platform-constraints: Hatchable is not a typical Node host.
- ops/debug-a-failing-deploy: When `deploy` returns an error, the message names the issue and points at the fix.
- ops/deploy-the-project: `deploy` MCP tool ships the current state of project files to production.
- ops/inspect-the-schema: Read the live Postgres database schema (tables, columns, indexes) with `get_schema`, and run ad-hoc SQL with `execute_sql`, before writing migrations.
- ops/read-the-logs: Debug production errors: `view_logs` returns request logs, console output, and handler errors, filtered by route, level, time, or full-text.
- pages/add-a-form-and-handle-it: The standard form pattern: Alpine state on the page, `fetch` POST to an `/api/...` route, JSON response, redirect or update inline.
- pages/add-a-page: Build an HTML page using Tailwind CSS (via CDN) and Alpine.js (via CDN) for interactivity.
- pages/add-react-and-htm-spa: When client state genuinely demands React — multi-step forms, real-time dashboards, drag-and-drop, complex data grids — **vendor React +…
- pages/server-render-a-page: Serve dynamic HTML at a clean URL.
- pages/share-design-tokens: Define brand colors, fonts, spacing, and radii once in `/theme.css` and reference them across all pages.
- pages/write-host-aware-urls: An app can answer on several hostnames: its `{slug}.hatchable.site` subdomain plus any custom domains the owner has added.
- project/export-project-data: Pull the project's data and files for backup, off-platform analysis, or migration.
- project/fork-from-canonical: Forking creates a new project as a copy of an existing one — files, schema, seed data, all of it.
- project/handle-agent-tasks: Read and resolve the plain-English agent tasks a project's owner filed in their console, and close them with the deploy that fixed them.
- project/set-environment-variables: Declare secrets, env config, and API keys in `hatchable.toml` (`[[secret]]`, `[[config]]`, `[ai]`); read them with `config.get`.
- realtime/publish-and-subscribe: Live updates without polling loops.
- storage/accept-a-file-upload: Accept multipart/form-data uploads, store the file via `storage.put`, and hand the browser a short-lived presigned URL.
- storage/expire-files-with-tmp: Any `storage.put` whose key starts with `tmp/` gets auto-deleted by S3 ~7 days after it was written.
- storage/serve-stored-files: Serve private stored files to browsers via signed URLs, stable redirects, or streamed bytes — four patterns with `storage.url`/`storage.get`.

### Linear agent skills
Linear list_agent_skills returned an empty array and hasNextPage=false. No Linear agent-skill instructions were available to read.

## Three-state reconciliation

Definitions:
- CATALOG: a skill/catalog entry exists.
- EXPOSED: one or more tool actions are present in the current runtime registry.
- CONNECTION/READ: only a successful bounded data read proves read access for that resource. Permission metadata alone is not account authentication.

| Family | Catalog evidence | Actions exposed | Connection/read evidence | Run status |
|---|---|---:|---|---|
| Native ChatGPT skills | 0 roots | skills__list/read (2) | No skill resource available | UNAVAILABLE-IN-RUN |
| GitHub | No ChatGPT skill root | 89 | Exact repository metadata and Issue #19 read succeeded | READ-TESTED |
| Dropbox | No ChatGPT skill root | 39 | Exact CC-006C metadata and content read succeeded | READ-TESTED |
| Linear | Linear agent skills 0 | 93 | Authenticated workspace read; bounded project search succeeded with no matches | READ-TESTED |
| Remote Desktop Commander | No ChatGPT skill root | 30 | Account/device discovery and read-only Git status command succeeded on verified device | READ-TESTED |
| Hatchable | 57 platform guides | 34 | Platform skill catalog and 11 guide reads succeeded; project account/resource access not reconciled | READ-TESTED — catalog only |
| Plugin Management | No ChatGPT skill root | 4 | Named app permission metadata reads succeeded | READ-TESTED — metadata only |
| Trello | No ChatGPT skill root | 15 | Permission metadata found; no project data read | TOOL-EXPOSED |
| Render | No ChatGPT skill root | 48 | Permission metadata found; no workspace/service read | TOOL-EXPOSED |
| Neon | No ChatGPT skill root | 141 | Permission metadata found; no organization/project read | TOOL-EXPOSED |
| Supabase | No ChatGPT skill root | 36 | Permission metadata found; no organization/project read | TOOL-EXPOSED |
| Vercel | No ChatGPT skill root | 260 | Permission metadata found; no team/project read | TOOL-EXPOSED |
| Replit | No ChatGPT skill root | 8 | Permission metadata found; no app read | TOOL-EXPOSED |
| Webflow | No ChatGPT skill root | 38 | Permission metadata found; no site read | TOOL-EXPOSED |
| Plugin Creator | No ChatGPT skill root | 9 | Permission metadata found; no owned-plugin read | TOOL-EXPOSED |
| Automations | No ChatGPT skill root | 7 | Actions exposed; no automation record read | TOOL-EXPOSED |
| Todoist | No ChatGPT skill root | 49 | App permission lookup says not_installed; no data read | UNAVAILABLE-IN-RUN |
| Gmail | No ChatGPT skill root | 20 | App permission lookup says not_installed; no data read | UNAVAILABLE-IN-RUN |
| Google Calendar | No ChatGPT skill root | 10 | App permission lookup says not_installed; no data read | UNAVAILABLE-IN-RUN |
| File library | No ChatGPT skill root | 11 | Host file actions exposed; not used | TOOL-EXPOSED |
| User settings | No ChatGPT skill root | 2 | Host settings actions exposed; not used | TOOL-EXPOSED |

## App permission metadata

The named app-permission lookup returned global permission “Allow low-risk actions”. Every found app inherited “Use my default”; the tool description says sensitive-information actions may still be denied. This is a ChatGPT action-approval policy, not proof of OAuth scopes or provider account access.

Found permission records (13): GitHub, Dropbox, Linear, Remote Desktop Commander, Hatchable, Trello, Render, Neon, Supabase, Vercel, Replit, Webflow, Plugin Creator.

Reported not_installed (3): Todoist, Gmail, Google Calendar. Their tool namespaces nevertheless remain exposed. Do not infer connectivity from those action names.

No permission settings, installations, OAuth connections, account settings or scopes were changed.

## Bounded project evidence

### GitHub
- Repository: suniltnngl-gm/curl-ai-bridge; stable repository ID 1443769540.
- Private repository; default branch main; not archived.
- Repository API response reported admin, maintain, pull, push and triage permissions as true. These are provider-reported repository permissions, not authorization to perform any action under this scheduled review.
- Issue #19 ID 6221727989, open, last updated 2026-11-18T11:51:30Z.
- Issue #19 states it is a durable tracking register and does not authorize merge, deployment, infrastructure changes or implementation. Its embedded PR state is dated 2026-11-05; do not treat that embedded snapshot as a fresh PR audit.
- No comments, issue edits, PR changes, workflow dispatches or GitHub writes were performed.

### Dropbox
- Exact file ID: id:opctR6uvYWcAAAAAAAAANw.
- Revision: 6608b2b39e65980285971.
- Path: /Apps/curl-ai-bridge-cloud/protocol/extensions/cc-006c-cloud-inbox-auth-v1.json.
- Server modified: 2026-11-18T11:18:22Z; size 1,776 bytes.
- Record states event_authority=coordination-only, project_manager=ChatGPT, runtime_parent=AI_A, worker_execution_authority=not-granted-by-storage-or-event.
- It specifies Ed25519 verification with out-of-band SHA-256 pinning; cloud-supplied keys are not auto-trusted; bounded-keyset polling; no remote claims; durable local non-expiring deduplication; invalid events retained as cloud evidence; verification before worker handoff; no automatic inference retries; no cloud object deletion.
- Rollout fields say live assignment, live inbox poll, production signing key, remote worker dispatch, schedule integration and trusted key pin were not performed/provisioned.
- No Dropbox writes or sharing/permission changes were performed.

### Linear
- Authenticated workspace: aidev-tools, stable workspace ID 9e912d3a-12b6-4e53-94c7-5bcb9d85d873.
- Connection response identified client ChatGPT and access=all; this is the connector-reported connection scope, not an implementation grant.
- Exact project search for “cURL AI Bridge” returned zero results. This does not prove no related issue/document exists under another team, archive, label or identifier.
- No task/project/comment changes were performed.

### Remote Desktop Commander and local Git
- Verified online device: sunilkr-H81, ID 6f9a336b-2280-4e52-bcd0-0b1b3426e948, app version 0.3.4.
- Device host reported sunilkr-H81; Linux x86_64. Its initial process working directory was the Desktop Commander package directory, so absolute project paths were used.
- Account usage metadata reported 12% remote-call allowance remaining; the subsequent process result reported 87% of monthly usage used. Further remote inspection was avoided.
- cURL AI Bridge repository: /home/sunilkr/Code/curl-ai-bridge; branch test/ubuntu-self-hosted-runner-smoke; HEAD b90d2c2b0594ddc0ac517834b45a855aaee8e1cd; ahead 17 / behind 0; 0 dirty entries.
- Work-ledger repository: /home/sunilkr/Code/multi-project-workspace; branch master; HEAD e28afe7eca1a585a58ad8d8c3628fd98322e7549; ahead 6 / behind 0; 5 dirty entries: modified .github/workflows/ci.yml and apps/api/src/database.js; untracked apps/api/test/taskBootstrapCli.test.js, reports/, scripts/task-bootstrap-register-current.mjs.
- git diff --check and git diff --cached --check passed for both repositories.
- No source files were read. All pre-existing changes and untracked files were preserved.

## Selected read-action descriptions from the current tool registry

Descriptions below are the exact first descriptive paragraph exposed by the tool registry. Full schemas remain available from the runtime action definitions; this is not a claim that every schema was inspected.

### GitHub
- mcp__GitHub__get_repo — Retrieve metadata for a GitHub repository. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url`: - `repository_full_name`: `owner/name`, such as `openai/openai`. Maps to GitHub REST `owner` and `repo` path parameters. - `repository_id`: numeric GitHub repository ID, such as `1296269`. - `repository_url`: repository URL or nested repository URL, such as a PR, issue, branch, file, REST API, GitHub Enterprise Server `/api/v3`, or GHE.com API URL. GitHub REST repository docs: https://docs.github.com/en/rest/repos/repos#get-a-repository GitHub Enterprise Server REST docs: https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/getting-started-with-the-rest-api GHE.com API host docs: https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency#api-access
- mcp__GitHub__fetch_issue — Fetch a GitHub issue. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url` to select the issue's repository.
- mcp__GitHub__search_issues — Search one repository or every repository the linked account can access. Supply at most one repository selector. Empty lists mean no repository filter. A `repo:owner/name` query does not require a separate repository selector.
- mcp__GitHub__fetch_file — Fetch file content by repository path, using the default branch when ref is omitted.
- mcp__GitHub__fetch_pr — Fetch a pull request with its diff, metadata, and optionally comments.
- mcp__GitHub__get_commit_combined_status — Fetch the combined CI status and individual status checks for a commit.
### Dropbox
- mcp__Dropbox__search — Search Dropbox files and folders by name or content, with optional filters
- mcp__Dropbox__get_file_metadata — Get metadata, sharing details, and permissions for a Dropbox file or folder
- mcp__Dropbox__fetch — Fetch full text content for a Dropbox file by id or path.
- mcp__Dropbox__list_folder — List Dropbox folder contents; supports direct children or recursive traversal
- mcp__Dropbox__list_file_revisions — Tool
### Linear
- mcp__Linear__whoami — Retrieve the authenticated user, the connected workspace, and how this connection reaches Linear
- mcp__Linear__search — Full-text search across Linear issues, projects, initiatives, and documents, ranked by relevance. Use this for keyword or natural-language queries (e.g. "memory leak in sync engine"). Supports "quoted phrases" for exact match, -term to exclude, and +term to require. For structured filtering by assignee, status, team, label, etc., use the list_issues or list_projects tools instead.
- mcp__Linear__list_projects — List projects in the user's Linear workspace
- mcp__Linear__get_project — Retrieve details of a specific project in Linear
- mcp__Linear__get_issue — Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.
- mcp__Linear__list_agent_skills — List Linear Agent skills available to the authenticated user.
### Remote Desktop Commander
- mcp__Remote_Desktop_Commander__who_am_i — Get details about the currently authenticated user, including this month's remote tool-call usage as a percentage
- mcp__Remote_Desktop_Commander__list_devices — List this account's Desktop Commander devices, their online/offline status, IDs for device selection, and device-management guidance
- mcp__Remote_Desktop_Commander__read_file — Read contents from files and URLs. Read PDF files and extract content as markdown and images.
- mcp__Remote_Desktop_Commander__list_directory — Get a detailed listing of all files and directories in a specified path.
- mcp__Remote_Desktop_Commander__get_file_info — Retrieve detailed metadata about a file or directory including: - size - creation time - last modified time - permissions - type - lineCount (for text files) - lastLine (zero-indexed number of last line, for text files) - appendPosition (line number for appending, for text files) - sheets (for Excel files - array of {name, rowCount, colCount})
- mcp__Remote_Desktop_Commander__read_process_output — Read output from a running process with file-like pagination support.
- mcp__Remote_Desktop_Commander__get_usage_stats — Get usage statistics for debugging and analysis.
### Hatchable
- mcp__Hatchable__list_skills — List the registry of platform skills — discrete how-to guides for one specific task each (e.g. 'gate-an-endpoint', 'add-a-cron-job', 'add-rag-search'). Each entry is a name, one-line purpose, and category. Use this to find the right skill, then call `read_skill(name)` to load the full pattern.
- mcp__Hatchable__read_skill — Load the full markdown body of one skill: when to use it, the canonical code shape, common pitfalls, and how to verify it works. Skills are the platform's primary agent-facing reference — every pattern an agent might need is one of these.
- mcp__Hatchable__get_project — Get project details including slug, status, deployed functions, and the database schema (tables, columns, types).
- mcp__Hatchable__list_projects — List all projects you own or collaborate on, with their tier, role, and current version.
- mcp__Hatchable__read_file — Read the content of a project file.
- mcp__Hatchable__grep — Regex content search across a project's files. Postgres-backed, scoped to one project, with glob filtering.
- mcp__Hatchable__view_logs — View function execution logs with rich filtering. Each entry includes status_code, duration_ms, log_output (captured console.log), error (if any), and a derived `level` field (error/warning/info).
- mcp__Hatchable__get_schema — Return the database schema for the project's PostgreSQL database: tables, columns (with types), and indexes.
### Trello
- mcp__Trello__trelloReadBoard — Read Trello boards. Supports listing boards the authenticated user is a member of, listing all boards a user can access within a specific workspace (regardless of membership), fetching a single board by ARI or URL, listing labels on a board, listing a board's custom field definitions, and listing a board's action/history.
- mcp__Trello__trelloReadCard — Fetch a Trello card's full details, or list cards across a board or list to surface open work items. Use this tool when you know the specific board, list, or card you want to inspect. For keyword-based discovery across all boards/cards, use trelloSearch instead. Actions: - "get": fetch a single card by id or card URL (cardIdOrUrl required). Returns core card fields, labels (up to 25; truncation signalled via labelsHasMore), checklists (up to 25; truncation signalled via checklistsHasMore, each with up to 25 check items; truncation signalled via checkItemsHasMore, use trelloReadChecklist for the full list), and comments (up to 25; truncation signalled via commentsHasMore). - "list_by_board": fetch all cards for a board grouped by list (boardIdOrUrl required). Response: { lists: [{ id, name, cards: [...] }], hasNextPage, nextCursor }. Each page contains up to 5 lists (configurable via limit); each list contains all its cards. Filter by card state: "open" (default), "archived", or "all". Use cursor/limit to paginate over lists (max 50 lists per page). - "list_by_list": fetch cards in a Trello list (listId required) with cursor-based pagination. Use this when the user asks for cards in a list or all cards from a specific list. Response: { cards: [...], pageInfo: { hasNextPage, endCursor } }. Filter by card state: "open" (default), "archived", or "all". Use cursor/limit to paginate (max 50 cards per page). - "get_comment": fetch a single comment on a card by its action ID (cardIdOrUrl and commentId required). For this action, cardIdOrUrl must be a Trello card ARI so the workspace is explicit for authorization. Response: { id, text, createdAt, lastEditedAt, creator, cardId }. - "list_comments": list comments on a card, newest first (cardIdOrUrl required). Response: { comments: [{ id, text, createdAt, lastEditedAt, creator }], pageInfo: { hasNextPage, endCursor } }. Use cursor/limit to paginate (default 25, max 50 comments per page). - "list_attachments": list files and links attached to a card (cardIdOrUrl required). Response: { attachments: [{ id, name, fileName, url, mimeType, bytes, createdAt, isUpload, isMalicious }], pageInfo: { hasNextPage, endCursor } }. Use cursor/limit to paginate (default 25, max 50 attachments per page). - "list_custom_field_items": list the custom field values set on a card (cardIdOrUrl required). Pairs with trelloReadBoard "list_custom_fields" for the field definitions these values belong to. Response: { customFieldItems: [{ id, customField: { id, name, type }, value: { text, number, date, checked, optionId } }], pageInfo: { hasNextPage, endCursor } }. Only the value field matching the customField.type is populated (e.g. text fields set value.text). optionId references a customField option for list/dropdown fields. Use cursor/limit to paginate (default 25, max 50 items per page). - "list_activity": list a card's full activity history, newest first (cardIdOrUrl required). Unlike "list_comments" this is unfiltered: comments, moves between lists, member add/remove, due-date changes, attachments and checklist item state changes all appear in one feed. Response: { activity: [{ id, type, displayKey, date, creator, ...typeSpecificFields }], pageInfo: { hasNextPage, endCursor } }. Every entry has id, type, displayKey, date and creator. Type-specific fields are present only for their own action type and omitted otherwise: commentText/commentLastEditedAt, listBefore/listAfter, member, attachment, dueDate, checkItem. Other action types appear with the common fields alone. Trello reuses "type" across different edits (a list move and a due-date change are both "updateCard"), so branch on "displayKey" or on which type-specific field is present, rather than on "type" alone. Same entry shape as trelloReadBoard "list_activity", minus its "card" field. Every entry is an action on the card you asked for; name that entity type when you report one. Use "list_comments" when the user only wants the discussion; use "list_activity" for "what happened to this card" or "who changed this and when". Use cursor/limit to paginate (default 25, max 50 entries per page).
- mcp__Trello__trelloReadChecklist — Read Trello checklists (and their check items) attached to a card. Supported actions: "list_by_card" — list checklists on a card (cardId required); cursor/limit page the checklists. "get" — fetch a single checklist by id (checklistId required). In both actions each checklist is returned with its complete `items` list embedded.
- mcp__Trello__trelloSearch — Discover Trello boards or cards by keyword across all workspaces. Use this when the user wants to find something by name or content but does not know which board it is on. If the user already knows the board or list they want to browse, use trelloReadCard (list_by_board or list_by_list) instead — it is faster and returns richer grouped results. Supported actions: "search_boards" — search for boards by name, always include each board's `url` verbatim in the response; "search_cards" — search for cards by name/content. Both support optional workspace scoping and cursor-based pagination. Both actions return open (non-archived) results by default. To search archived items instead, include `is:archived` in the query. "search_cards" additionally supports boardIds scoping and qualifiers: label:, board:, list:, member:, due:, has:. For archived/closed cards, use `is:archived` or `is:closed` (they are equivalent for cards only). For archived boards, use `is:archived` only — boards do not support the `is:closed` alias. Due date timezone handling: Trello due-date search qualifiers use UTC boundaries. For "today" or date-based due-date queries, first call trelloReadMember (get_me) for prefs.timezone and account for the user's local timezone.
### Render
- mcp__Render__list_workspaces — List the workspaces that you have access to
- mcp__Render__list_services — List all services in your Render account
- mcp__Render__get_service — Get details about a specific service
- mcp__Render__list_logs — List logs matching the provided filters. Logs are paginated by start and end timestamps. There are more logs to fetch if hasMore is true in the response. Provide the nextStartTime and nextEndTime timestamps as the startTime and endTime query parameters to fetch the next page of logs. You can query for logs across multiple resources, but all resources must be in the same region and belong to the same owner.
- mcp__Render__get_metrics — Get performance metrics for any Render resource (services, Postgres databases, key-value stores). Supports CPU usage/limits/targets, memory usage/limits/targets, service instance counts, HTTP request counts and response time metrics, bandwidth usage metrics, database active connection counts for debugging, capacity planning, and performance optimization. Returns time-series data with timestamps and values for the specified time range. HTTP metrics support filtering by host and path for more granular analysis. Limits and targets help understand resource constraints and autoscaling thresholds. Metrics may be empty if the metric is not valid for the given resource.
- mcp__Render__list_deploys — List deploys matching the provided filters. If no filters are provided, all deploys for the service are returned.
### Neon
- mcp__Neon__list_organizations — Lists the organizations the user belongs to; an organization API key gets its own organization. search filters by name or id.
- mcp__Neon__list_projects — Lists the projects in an organization; search filters by name or id. To also find branches, computes, or snapshots, use search. Returns every page. Pass limit to cap how many. `org_id` is optional: organization API keys use their organization; personal API keys auto-select when unambiguous and otherwise return the IDs to choose from.
- mcp__Neon__describe_project — Gets a project's settings, owner, and usage. For branches, use list_branches.
- mcp__Neon__get_project_consumption — Returns per-project consumption in an organization. metrics: every name get_branch_consumption takes, plus extra_branches_month and snapshot_storage_bytes_month. Launch, Scale, Agent, Business, or Enterprise plans; others get 403. Returns every page. Pass limit to cap how many.
- mcp__Neon__list_branches — Lists a project's branches with id (br-...), name, parent, and default flag; search finds a branch's id by name. Returns every page. Pass limit to cap how many.
- mcp__Neon__query_logs — Returns a branch's log records. Filters combine with AND; pass logql or structured filters, not both. Pass since or start_time, not both; default last hour, max seven days. Private beta: a branch without logs returns 404 telemetry_not_enabled. Stream labels: query_loki_logs. Returns every page. Pass limit to cap how many.
### Supabase
- mcp__Supabase__list_organizations — Lists all organizations that the user is a member of.
- mcp__Supabase__list_projects — Lists all Supabase projects for the user. Use this to help discover the project ID of the project that the user is working on.
- mcp__Supabase__get_project — Gets details for a Supabase project. `status` is `ACTIVE_HEALTHY` when the project is ready for database tools; other values such as `COMING_UP`, `RESTORING`, or `INACTIVE` (paused) mean database calls will fail or time out.
- mcp__Supabase__list_tables — Lists all tables in one or more schemas. By default returns a compact summary. Set verbose to true to include column details, primary keys, and foreign key constraints.
- mcp__Supabase__query_logs — Runs a custom read-only ClickHouse SQL query against a Supabase project's unified logs stream, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_end; other windows are rejected. If you pass only iso_timestamp_start, the end defaults to now, so for a past time range pass both timestamps. For a longer range, make one call per 24-hour slice. Do not poll this tool in a loop.
### Vercel
- mcp__Vercel__list_projects — List the projects of the authenticated user or the selected team. Results are paginated using limit and from. Optionally filter by name search, Git repository, connected Global Config, build settings, and other listed filters.
- mcp__Vercel__get_project — Get a project's details by project ID or name.
- mcp__Vercel__list_deployments — Use this when you need deployment records or recent deployment history under the authenticated user or team. Results can be filtered by project, branch, commit, environment, state, creator, or creation time. Returns deployment data; incomplete uploads have a null URL. For a live deployment card with build status and expandable logs, use open_deployments when available.
- mcp__Vercel__get_deployment — Get a deployment by its ID or hostname. When withGitRepoInfo is true, the response also includes Git source details. Additional details are included when the authenticated user or team owns the deployment.
- mcp__Vercel__list_ai_gateway_models — Use this when choosing a model on Vercel AI Gateway or checking what one costs. Searches the live public catalog and returns each match's ID, type, context window, output limit, model-specific pricing in USD, and capability tags, with the total number of matches and, when more remain, a nextOffset to pass as offset for the next page. Use get_ai_gateway_model for the providers that serve one model. This is reference data; it does not read the user's account, so a team's virtual models (vmc/...) are not listed.
- mcp__Vercel__get_ai_gateway_usage — Use this when measuring a team's Vercel AI Gateway spend, request volume, token usage, or latency. Returns totals for the chosen metrics, optionally grouped by one dimension such as model or provider, plus an hourly or daily series when granularity is set. Covers the last 7 days by default. A scoped connection fixes the team/project; otherwise, pass projectId to limit the team query to one project. Returns aggregates only, never prompts or responses; use get_ai_gateway_leaderboard for usage across all of AI Gateway.
### Replit
- mcp__Replit__list_apps — List Replit Apps the user can edit, most recently updated first; `query` optionally filters by matching app titles, surfacing the best matches for the query first. Use this when the user wants to browse or pick from their apps, or when you need a replId but resolve_app_by_name returned found=false because the user gave an approximate name — present the returned titles and let the user choose, then pass the chosen replId to update_app_using_prompt or ask_question. This is a search/list, not the exact resolver: prefer resolve_app_by_name when the user already gave an exact app name. Results can include apps owned by or shared with the user.
- mcp__Replit__resolve_app_by_name — Look up by exact name a Replit App the user can edit and return its replId (UUID) and URL. Use this when the user refers to an app by name (e.g. "update my Todo App", "what does my Recipe Tracker do?") and you don't already have a replId from create_app_from_prompt earlier in this conversation. Pass the result's replId into update_app_using_prompt or ask_question to act on the app. Matching is case-insensitive but exact: this is a name resolver, not a search. If the user gives you an approximate or partial name and this tool returns found=false, call list_apps (optionally with the partial name as the query) and let the user pick from the results rather than guessing. Results can include apps owned by or shared with the user.
- mcp__Replit__search_apps — Search Replit Apps the user can edit (owned or shared with them). query is a BM25-style keyword search over app titles, best matches first; updatedAfter/updatedBefore bound the last-updated time; these combine. Prefer the default recency ordering: only set updatedAfter/updatedBefore when the user explicitly asks to filter by time, since date bounds exclude apps that would otherwise be listed. url resolves a Replit App URL directly to that app and ignores the other filters. With no filters, this returns the user's most recently updated apps. Pass a result's replId to update_app_using_prompt or ask_question to act on that app. <important>This tool is EXPERIMENTAL: prefer it for finding the user's apps, but if it errors or its results do not match what the user described, fall back to resolve_app_by_name (exact name) and list_apps (recent apps).</important>
- mcp__Replit__get_publish_status — Check the publish status of the user's Replit App: whether it has ever been published, the current status of its most recent publish, and the public URL it serves. found=false means the app has never been published; call publish_app to publish it for the first time. When found, 'success' means it is live at the returned url, 'failed' means the last publish did not go through, 'suspended' means the published app is paused and not serving, and anything else means a publish or lifecycle operation is still in progress. Use this to poll every 30 seconds after calling publish_app, or whenever the user asks whether their app is published or what its live URL is. Takes the same replId as publish_app.
### Webflow
- mcp__Webflow__get_asset_preview — Get an image preview of a site asset by its asset ID. Fetches the asset's metadata, downloads the smallest available image variant (or the original file when no variants exist), and returns the image content. Works with any image content type (e.g. JPG, PNG, GIF, WEBP); non-image files and files larger than 2 MB return an error instead of an image. Returns a 404 error if the asset does not exist or has been deleted.
- mcp__Webflow__webflow_home — Opens the Webflow home view: the most recently published sites this account can reach (up to 48), with Designer and live links. Use it when the user opens the Webflow app or asks for an overview of their sites. To list every site, find a site id, or get site details for other tools, use data_sites_tool instead.
### Todoist
- mcp__Todoist__To_Do_List___Calendar__find_projects — List or search by name the projects the user has joined. By default only active projects are returned; use archivedStatus ('archived' or 'all') to include archived projects. When searching or when archivedStatus is 'all', all matching projects are returned (pagination is ignored). Otherwise projects are returned with pagination. Workspace projects the user hasn't joined are left out unless includeUnjoined is set, or a search matches no joined project.
- mcp__Todoist__To_Do_List___Calendar__find_tasks — Find active tasks by text, project/section/parent, responsible user, labels, raw filter, or saved filter (filterIdOrName). Without filters, list a page. Default scope: unassigned + mine; responsibleUserFiltering="all" includes others.
- mcp__Todoist__To_Do_List___Calendar__search — Search across tasks and projects in Todoist. Returns a list of relevant results with IDs, titles, and URLs.
- mcp__Todoist__To_Do_List___Calendar__fetch_object — Fetch a single task, project, comment, or section by its ID. Use this when you have a specific object ID and want to retrieve its full details. Set includeChildren to also get its direct subtasks or sub-projects.
### Gmail
- mcp__Gmail__search_threads — Lists email threads from the authenticated user's Gmail account.
- mcp__Gmail__get_thread — Retrieves a specific email thread from the authenticated user's Gmail account, including a list of its messages.
- mcp__Gmail__get_message — Retrieves a specific email message from the authenticated user's Gmail account by its unique message ID.
- mcp__Gmail__list_drafts — Lists draft emails from the authenticated user's Gmail account.
### Google Calendar
- mcp__Google_Calendar__search_events — Searches events on the user's primary calendar using semantic search.
- mcp__Google_Calendar__list_events — Returns events on the given calendar matching all specified constraints. Time constraints should not be specified unless requested by the user. For open-ended keyword or topic-based searches on the primary calendar, the search_events tool must be used instead.
- mcp__Google_Calendar__get_event — Returns a single event on the given calendar.
- mcp__Google_Calendar__list_calendars — Returns the calendars this user has access to (their calendar list). Use this tool to resolve calendar identifying data (for example, 'my family calendar') into its corresponding `calendar_id` (email identifier)
### Plugin Management
- mcp__Plugin_Management__get_app_permissions — Inspect one named ChatGPT plugin's global/default and plugin-specific permission settings. Use when the user asks what the plugin may read, write, or do, whether it must ask first, or whether it inherits the default. For a missing/broad target such as my plugins, all, or Google, make no call and ask which plugin. Never pass global. Do not use for OAuth/admin scopes, install/connect/undo requests, ordinary plugin use, or npm/Chrome/code plugins.

## Reusable lessons

1. FACT — Capability discovery must be a layered state machine: skill/catalog entry, exposed action, permission metadata, authenticated account, resource-scoped read, and verified write capability are different states. Evidence: skills__list returned 0; Hatchable list_skills returned 57; Linear list_agent_skills returned 0; named app permission lookups; successful GitHub/Dropbox/Linear/Remote Desktop reads.

2. FACT — An action namespace can remain exposed while its app is reported not installed. Evidence: Todoist (49 actions), Gmail (20) and Google Calendar (10) are exposed, while their named permission lookups returned not_installed. Safe adapter state is UNAVAILABLE-IN-RUN for data access, not connected.

3. PROPOSAL — Classify each action by operation effect, data sensitivity, scope and reversibility; do not classify an entire provider as safe because its global permission says Allow low-risk actions. Treat mixed-action routers and generic command execution as deny-by-default, then allow only exact read shapes.

4. FACT — Stable identifiers and pagination contracts are provider-specific. GitHub uses repository identity plus issue number; Dropbox supports file IDs and opaque search cursors; Linear uses workspace/project IDs and cursor pagination; Hatchable documents keyset cursors with tie-breakers. Evidence: action descriptions and Dropbox/Linear/Hatchable skill contracts.

5. FACT — Dropbox search has two modes: query-only simplified search (up to 100 active file results, no folders and no pagination fields) versus advanced mode with opaque cursor. Dropbox fetch has a 5 MiB maximum and returns an error rather than partial extracted success. Evidence: mcp__Dropbox__search and mcp__Dropbox__fetch descriptions.

6. FACT — Remote Desktop Commander start_process is a general execution primitive, not intrinsically read-only. Its remote wait is capped at 3 seconds; long-running work returns a PID and read_process_output supports offset/length pagination with a configurable line cap. Evidence: action descriptions and this run's bounded read-only Git command.

7. FACT — Hatchable MCP grants are project-scoped by token audience; documented access JWT lifetime is one hour and refresh-token lifetime is 30 days from grant, with refresh not extending that 30-day window. Revocation invalidates both. Evidence: hatchable://platform/skills/mcp/expose-an-mcp-tool.

8. FACT — Hatchable external API OAuth credentials are project-scoped by default, while provider OAuth app client credentials are account-scoped; per-end-user connections are a separate mode. OAuth state is single-use, random and short-lived (10 minutes). Evidence: hatchable://platform/skills/integrations/connect-an-external-api.

9. FACT — Provider/model catalog visibility does not establish entitlement. Hatchable's AI ledger explicitly treats null cost as unpriced, not free; cost_is_complete must be checked. The ledger is project-scoped and rollups cache for about 60 seconds. Evidence: hatchable://platform/skills/ai/inspect-llm-call-history.

10. FACT — Hatchable documents ai.generateText at 60 calls/minute and embeddings at 200/minute; ai.fetch has no gateway request cap of its own but shares the daily spend cap, and provider 429s remain provider-owned. Provider calls time out at 170 seconds; setup-required can return 412. These are Hatchable platform guide facts, not observed limits for cURL AI Bridge or other providers. Evidence: hatchable://platform/skills/ai/use-a-provider-directly and ai/build-an-agent-with-tools.

11. FACT — Tool-loop execution and streaming are distinct. generateText with execute functions and maxSteps auto-loops; omitting execute returns planned tool calls for external control. streamText emits one model round and does not execute tools or auto-loop. Each loop step is another model invocation and incurs cost. Evidence: hatchable://platform/skills/ai/build-an-agent-with-tools.

12. FACT — Hatchable keyset cursors need deterministic tie-breakers for non-unique sort columns; cursors are not authorization and should be invalidated/versioned when ordering schema changes. Evidence: hatchable://platform/skills/data/query-with-pagination.

13. FACT — Webhook verification should use exact raw request bytes, constant-time signature comparison and replay-window validation where timestamps are signed. Evidence: hatchable://platform/skills/integrations/verify-a-webhook.

14. FACT — Logs are retention-limited, carry request IDs, and omit request/response bodies and client IP; secrets and sensitive user data must not be logged. Evidence: hatchable://platform/skills/ops/read-the-logs.

15. UNKNOWN — No direct evidence in this run establishes whether OpenCode, Copilot CLI, Hermes, AGY or other local CLIs share configuration, credential stores, model aliases, session state or headless/interactive state. Keep those dimensions separate until tested with non-inference inspection.

16. INFERENCE — A common orchestration adapter can normalize discovery, invocation lifecycle, cancellation, result retrieval and error categories, but should preserve provider-native schemas, authentication tenancy, quota semantics, cursors and tool capabilities as typed extensions.

17. PROPOSAL — Persist provenance for every adapter observation: provider, action name/version, resource ID, account/workspace identity reference (non-secret), scope, read timestamp, result state, pagination cursor, error class, evidence hash and expiry/freshness.

## cURL AI Bridge architecture implications

Keep these runtime entities distinct:

- ProviderEnvironment: provider endpoint, account/credential owner, auth mode, billing lane, quota bucket and capability catalog.
- CLIInstance: executable/version, host/device, working directory, config root, process mode and environment reference.
- Invocation: request ID, exact model identifier, arguments, timeout, cancellation token and normalized outcome.
- Session: provider-native conversation/session ID, ownership, isolation boundary and explicit sharing policy.
- ModelDescriptor: provider-native ID, alias mapping, modalities, tool support, catalogue provenance and validation timestamp.
- OrchestrationRun: task/lease identity, dispatch state, retry budget, worker identity and terminal orchestration state.
- TaskSync: independent synchronization/outbox state and delivery evidence.

Default to isolated sessions. Treat shared sessions as explicit opt-in with provider-specific compatibility tests. Validate exact model IDs before dispatch when a trusted catalogue exists; keep aliases as a separate resolution layer and reject unknown identifiers rather than guessing. Keep account, billing and quota lanes distinct. A model response or tool-loop completion must not automatically mark an orchestration task complete.

No inference, model invocation, worker dispatch, swarm action, paid usage or quota consumption was performed.

## Documentation conflicts and unresolved semantics

- ACCESS conflict: api/access.md says access=user is not valid in mcp/*.js, while mcp/expose-an-mcp-tool.md documents user-mode MCP grants using access=user. Do not choose an interpretation without authoritative resolution.
- Streaming conflict: meta/platform-constraints.md says responses are fully buffered and no res.write/WebSocket/EventSource globals exist; api/stream-a-response.md documents Response.sse/res.write and streaming behavior, while also describing a frontend rollout caveat. Treat the runtime contract as unresolved.
- These conflicts are documentation observations only; no project code or platform configuration was changed.

## Excluded actions and safety boundary

No action was taken for:
- GitHub issue/PR comments, edits, labels, branch/ref changes, merges, workflow reruns or dispatch.
- Dropbox upload, create, move, copy, delete, restore, share, Paper edits/comments or signature requests.
- Linear issue/project/document/comment writes, uploads, sharing, reviews or merges.
- Remote file writes, directory creation, moves, edits, process interaction/termination, shutdown or configuration changes.
- Hatchable file/project writes, SQL execution, functions, deploys, uploads, task updates, previews or project creation.
- Trello writes; Render deployments/infrastructure/environment changes; Neon/Supabase SQL or migrations and resource/auth/credential changes; Vercel deployments, environment, DNS, flags, sandbox or session-command mutations; Replit app creation/update/publish; Webflow CMS/designer/publish changes.
- Todoist task/project/comment/reminder changes; Gmail draft/send/reply/forward/label changes; Calendar event changes.
- Plugin installation, uninstallation, connection, OAuth, permission updates, account/subscription changes, model inference, worker dispatch, cache reset or external network mutation.

The repository API permission flags and Linear connection access field are observations, not authorization. No operator approval or elevation was requested.

## Coverage gaps and later prerequisites

- Native ChatGPT skill roots were absent; no ChatGPT skill-specific provider guidance could be read.
- Hatchable project ID/account resource was not established; only its platform skill registry was inspected.
- Linear project mapping remains unresolved because the exact project search returned no result.
- Trello, Render, Neon, Supabase, Vercel, Replit and Webflow were not read-tested; their account connection and resource scopes remain unknown despite permission metadata records.
- Todoist, Gmail and Google Calendar data access was unavailable because app permission lookup reported not_installed.
- CLI-specific configuration/session/quota-sharing behavior remains unknown; no CLI was invoked and no inference was tested.
- Hatchable MCP access and streaming documentation conflicts require authoritative documentation reconciliation before implementation reliance.
- GitHub, Dropbox and provider-specific rate limits were not queried; do not invent limits. Remote Desktop Commander reported 12% usage remaining before the local status check, so further remote calls were avoided.

No operator action is requested during this run. If later project work requires unavailable account access, project mapping, or resolution of documentation conflicts, it must be handled as a separate operator-controlled workflow.

## Artifact verification

- Destination: existing reports/workspace-inspections directory under /home/sunilkr/Code/multi-project-workspace.
- Creation mode: exclusive create; existing names are never overwritten.
- Verification: file read back from the created path; UTF-8 bytes, line count and SHA-256 computed; readback equality checked.
- This report records observations, not completeness or implementation authorization.

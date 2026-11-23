# cURL AI Bridge — Plugin Capability Lessons
**Checkpoint:** 11  
**Run timestamp:** 2026-11-19 19:49:14 +0530  
**Runtime:** ChatGPT tool-enabled runtime; Remote Desktop Commander device `sunilkr-H81` / `6f9a336b-2280-4e52-bcd0-0b1b3426e948`  
**Disposition:** bounded discovery; read-only except this one new report. No implementation authorization.

## 1. Executive summary
- Current tool registry: **945 actions / 21 namespaces**. Exact names for all actions are listed in section 3.
- Native ChatGPT `skills__list` returned `[]`. Hatchable's separate platform skill registry returned **57** guides; ten applicable guides were read. Linear `list_agent_skills` returned `agentSkills: []`, no next page.
- Eighteen exact app permission lookups: **14 found**, **4 not_installed**. The global ChatGPT permission is **Allow low-risk actions**; found apps use **Use my default**. This is not OAuth scope or provider-auth proof.
- Bounded successful reads: GitHub repository + Issue #19; Dropbox CC-006C; Linear workspace + bounded project search; Remote Desktop Commander device/config/path/Git inspection; Hatchable skill registry/docs; Plugin Management permission metadata.
- No provider write, inference, model invocation, worker dispatch, quota consumption, OAuth/connect flow, permission change, deployment, database mutation, or Git mutation occurred.

## 2. Runtime and skill catalog evidence
- Remote device online; Linux x64; Desktop Commander v0.3.4; Node 22.23.4; Python 3.14.4; shell /bin/bash.
- Current Desktop Commander config: `allowedDirectories: []` (no configured directory allowlist); blocked command list includes privilege-changing commands. Config was not changed. A generic shell executor is high-risk by default; only reviewed read-only Git commands and the authorized report creation were used.
- Remote Desktop Commander usage: **12% remaining** at identity check.
- Native `skills__list`: empty. Native `skills__read` only accepts listed skill URIs; no native roots to read.
- Hatchable `list_skills`: 57 catalog entries (platform how-to guides, not ChatGPT-installed plugin skills). Ten guide entry points read: `meta/platform-constraints`, `api/access`, `mcp/expose-an-mcp-tool`, `ai/build-an-agent-with-tools`, `api/stream-a-response`, `integrations/verify-a-webhook`, `data/query-with-pagination`, `ai/inspect-llm-call-history`, `integrations/connect-an-external-api`, `ops/read-the-logs`.
- Linear `list_agent_skills`: empty. No other provider-specific skill registry was exposed by the native skills catalog.

### Hatchable catalog (57)
- `recognize-the-project-admin` (admin) — Gate an admin-only route to the project's owner (or any admin collaborator) without building a login form or an app-level users table.
- `add-a-knowledge-base` (ai) — A knowledge base is the storage half of RAG: put text + metadata, query by semantic similarity (pgvector embeddings).
- `add-an-llm-endpoint` (ai) — Scaffold a route that takes a prompt, calls a language model, and returns the response.
- `add-rag-search` (ai) — Retrieval-augmented generation: index your content as embeddings, retrieve the top-K relevant chunks for a query, pass them to the LLM as context.
- `build-an-agent-with-tools` (ai) — Define tools the model can call, pass them to `ai.generateText` with `maxSteps`, and the runtime drives the loop: model picks a tool → your…
- `inspect-llm-call-history` (ai) — Every `ai.generateText` / `ai.streamText` / `ai.embed` / `ai.fetch` call is logged to the platform's AI ledger automatically — model…
- `show-ai-spend` (ai) — Every `ai.generateText` / `ai.streamText` / `ai.fetch` / `ai.generateImage` call writes a priced row into the platform's `ai_call_logs`.
- `use-a-provider-directly` (ai) — `ai.fetch` escape hatch for what `generateText` doesn't cover: image generation, audio, files, batches, prompt caching, or any new endpoint…
- `access` (api) — Every API route and MCP tool on Hatchable must declare who can call it.
- `add-an-api-route` (api) — File-based routing under `api/`.
- `proxy-an-external-api` (api) — Call third-party APIs from server-side handlers, never from the browser.
- `scheduler` (api) — Routes declared `access: 'scheduler'` are invoked only by the platform's scheduler — `[[cron]]` blocks in `hatchable.toml` or runtime…
- `stream-a-response` (api) — Send a response as it is produced instead of all at once: tokens from a model as they arrive, progress events from a long job, a large export row by row.
- `add-google-signin` (auth) — Google sign-in for the app's END USERS (the `[auth]` plane — not project collaborators).
- `build-a-login-page` (auth) — Ship your own `/login` page as part of enabling `[auth]` — styled like YOUR app, wired to the platform's auth client.
- `enable-app-auth` (auth) — Give your app its own sign-up/sign-in for end users — people who find the app and create an account themselves, as opposed to collaborators you invite.
- `gate-an-endpoint` (auth) — Require a signed-in caller before a route runs — login handled by the platform: `export const access = 'member'` for collaborators…
- `handle-the-anonymous-case` (auth) — Serve one public route to both signed-in users and anonymous visitors — check `req.member` and vary the response.
- `handle-user-deletion` (auth) — When the project owner deletes an end user from the console's Users tab, the platform runs a deletion ceremony: it revokes that user's AI…
- `add-a-cron-job` (background) — Schedule a recurring API route via `[[cron]]` blocks in `hatchable.toml`.
- `add-a-scheduled-digest` (background) — Composite pattern: cron job fires on schedule, queries the database for what to send, calls `email.send` for each recipient.
- `defer-with-scheduler` (background) — `scheduler.at(when, route, opts?)` arms a one-shot or recurring fire of any `api/*.js` route.
- `scrape-a-page` (browser) — `browser.session` runs a function with a Chromium page instance, letting you navigate, fill forms, click, and extract data.
- `take-a-screenshot` (browser) — `browser.screenshot(url)` returns a PNG buffer of any URL rendered by managed Chromium.
- `declare-configurable-fields` (config) — Expose buyer-editable settings without building an admin UI.
- `read-config-values` (config) — Read buyer-editable settings declared via `[[config]]` in `hatchable.toml`.
- `add-a-table` (data) — Create a Postgres table with a SQL migration — the platform applies `migrations/*.sql` in filename order on deploy; once applied, a…
- `one-off-backfill` (data) — Run a data migration that fires once on deploy and never again.
- `query-with-pagination` (data) — Paginate SQL queries with keyset cursors on `id`/`created_at` instead of OFFSET — stable and fast on Postgres.
- `row-access` (data) — Row access — let Postgres decide which rows a caller may touch
- `transactions` (data) — Run multiple SQL writes atomically with `db.transaction` on the project's Postgres database.
- `write-a-safe-migration` (data) — Migrate Postgres schema safely, and define the project's functions, procedures and triggers — a migration is the only place a routine can be created.
- `apply-house-design` (design) — Apply this when a user building on Hatchable has **not specified their own design direction**.
- `send-transactional-email` (email) — `email.send` for one-off transactional messages — receipts, confirmations, password resets, digests.
- `connect-an-external-api` (integrations) — Talk to Reddit, GitHub, Notion, Linear, Slack, or any other HTTP API from a Hatchable handler without writing OAuth flow code or storing tokens yourself.
- `verify-a-webhook` (integrations) — Verify inbound webhook signatures (Stripe, GitHub, Shopify, Slack) with `webhooks.verifyHmac` — constant-time, replay-window safe.
- `expose-an-mcp-tool` (mcp) — Let an AI client (Claude, ChatGPT, Cursor, etc.) call your project's logic directly.
- `file-platform-feedback` (meta) — Hatchable is built on top of an isolate runtime, an SDK, an MCP layer, a deploy pipeline, and a docs corpus — all of which have rough edges.
- `platform-constraints` (meta) — Hatchable is not a typical Node host.
- `debug-a-failing-deploy` (ops) — When `deploy` returns an error, the message names the issue and points at the fix.
- `deploy-the-project` (ops) — `deploy` MCP tool ships the current state of project files to production.
- `inspect-the-schema` (ops) — Read the live Postgres database schema (tables, columns, indexes) with `get_schema`, and run ad-hoc SQL with `execute_sql`, before writing migrations.
- `read-the-logs` (ops) — Debug production errors: `view_logs` returns request logs, console output, and handler errors, filtered by route, level, time, or full-text.
- `add-a-form-and-handle-it` (pages) — The standard form pattern: Alpine state on the page, `fetch` POST to an `/api/...` route, JSON response, redirect or update inline.
- `add-a-page` (pages) — Build an HTML page using Tailwind CSS (via CDN) and Alpine.js (via CDN) for interactivity.
- `add-react-and-htm-spa` (pages) — When client state genuinely demands React — multi-step forms, real-time dashboards, drag-and-drop, complex data grids — **vendor React +…
- `server-render-a-page` (pages) — Serve dynamic HTML at a clean URL.
- `share-design-tokens` (pages) — Define brand colors, fonts, spacing, and radii once in `/theme.css` and reference them across all pages.
- `write-host-aware-urls` (pages) — An app can answer on several hostnames: its `{slug}.hatchable.site` subdomain plus any custom domains the owner has added.
- `export-project-data` (project) — Pull the project's data and files for backup, off-platform analysis, or migration.
- `fork-from-canonical` (project) — Forking creates a new project as a copy of an existing one — files, schema, seed data, all of it.
- `handle-agent-tasks` (project) — Read and resolve the plain-English agent tasks a project's owner filed in their console, and close them with the deploy that fixed them.
- `set-environment-variables` (project) — Declare secrets, env config, and API keys in `hatchable.toml` (`[[secret]]`, `[[config]]`, `[ai]`); read them with `config.get`.
- `publish-and-subscribe` (realtime) — Live updates without polling loops.
- `accept-a-file-upload` (storage) — Accept multipart/form-data uploads, store the file via `storage.put`, and hand the browser a short-lived presigned URL.
- `expire-files-with-tmp` (storage) — Any `storage.put` whose key starts with `tmp/` gets auto-deleted by S3 ~7 days after it was written.
- `serve-stored-files` (storage) — Serve private stored files to browsers via signed URLs, stable redirects, or streamed bytes — four patterns with `storage.url`/`storage.get`.

## 3. Complete current tool action map
Tool exposure is not permission, authentication or successful use. Names are exact from the current runtime registry.

### files (11)
- `files__create_reference_image`
- `files__delete_reference_image`
- `files__find`
- `files__list_reference_images`
- `files__list`
- `files__manage_library`
- `files__materialize`
- `files__read`
- `files__search`
- `files__share`
- `files__update_reference_image`

### mcp__Automations (7)
- `mcp__Automations__create`
- `mcp__Automations__get`
- `mcp__Automations__list_event_sources`
- `mcp__Automations__notify_parent`
- `mcp__Automations__peek`
- `mcp__Automations__run_now`
- `mcp__Automations__update`

### mcp__Dropbox (39)
- `mcp__Dropbox__check_job_status`
- `mcp__Dropbox__check_upload_file_status`
- `mcp__Dropbox__copy`
- `mcp__Dropbox__create_file_request`
- `mcp__Dropbox__create_folder`
- `mcp__Dropbox__create_shared_link`
- `mcp__Dropbox__delete`
- `mcp__Dropbox__download_link`
- `mcp__Dropbox__fetch`
- `mcp__Dropbox__file_preview`
- `mcp__Dropbox__get_file_metadata`
- `mcp__Dropbox__get_file_request`
- `mcp__Dropbox__get_shared_link_metadata`
- `mcp__Dropbox__list_file_requests`
- `mcp__Dropbox__list_file_revisions`
- `mcp__Dropbox__list_folder`
- `mcp__Dropbox__list_restore_events`
- `mcp__Dropbox__list_shared_links`
- `mcp__Dropbox__move`
- `mcp__Dropbox__paper_apply_markdown`
- `mcp__Dropbox__paper_comment`
- `mcp__Dropbox__paper_create_document`
- `mcp__Dropbox__paper_edit_content`
- `mcp__Dropbox__paper_edit_table`
- `mcp__Dropbox__paper_get_doc_history`
- `mcp__Dropbox__paper_insert_image`
- `mcp__Dropbox__paper_insert`
- `mcp__Dropbox__paper_list_recent_docs`
- `mcp__Dropbox__paper_read_document`
- `mcp__Dropbox__restore_file_revision`
- `mcp__Dropbox__restore_folder`
- `mcp__Dropbox__search`
- `mcp__Dropbox__sign_cancel_signature_request`
- `mcp__Dropbox__sign_create_signature_request_draft`
- `mcp__Dropbox__sign_download_signature_request`
- `mcp__Dropbox__sign_list_signature_requests`
- `mcp__Dropbox__sign_send_signature_request_reminders`
- `mcp__Dropbox__upload_file`
- `mcp__Dropbox__who_am_i`

### mcp__GitHub (89)
- `mcp__GitHub__add_comment_to_issue`
- `mcp__GitHub__add_issue_assignees`
- `mcp__GitHub__add_issue_labels`
- `mcp__GitHub__add_reaction_to_issue_comment`
- `mcp__GitHub__add_reaction_to_pr_review_comment`
- `mcp__GitHub__add_reaction_to_pr`
- `mcp__GitHub__add_review_to_pr`
- `mcp__GitHub__compare_commits`
- `mcp__GitHub__convert_pull_request_to_draft`
- `mcp__GitHub__create_blob`
- `mcp__GitHub__create_branch`
- `mcp__GitHub__create_commit`
- `mcp__GitHub__create_file`
- `mcp__GitHub__create_issue`
- `mcp__GitHub__create_pull_request`
- `mcp__GitHub__create_tree`
- `mcp__GitHub__delete_file`
- `mcp__GitHub__dismiss_pull_request_review`
- `mcp__GitHub__download_user_content`
- `mcp__GitHub__download_workflow_artifact`
- `mcp__GitHub__enable_auto_merge`
- `mcp__GitHub__fetch_blob`
- `mcp__GitHub__fetch_commit_workflow_runs`
- `mcp__GitHub__fetch_commit`
- `mcp__GitHub__fetch_file`
- `mcp__GitHub__fetch_issue_comments`
- `mcp__GitHub__fetch_issue`
- `mcp__GitHub__fetch_pr_comments`
- `mcp__GitHub__fetch_pr_file_patch`
- `mcp__GitHub__fetch_pr_patch`
- `mcp__GitHub__fetch_pr`
- `mcp__GitHub__fetch_workflow_job_logs`
- `mcp__GitHub__fetch_workflow_job_steps`
- `mcp__GitHub__fetch_workflow_run_artifacts`
- `mcp__GitHub__fetch_workflow_run_jobs`
- `mcp__GitHub__fetch`
- `mcp__GitHub__get_commit_combined_status`
- `mcp__GitHub__get_issue_comment_reactions`
- `mcp__GitHub__get_pr_diff`
- `mcp__GitHub__get_pr_info`
- `mcp__GitHub__get_pr_reactions`
- `mcp__GitHub__get_pr_review_comment_reactions`
- `mcp__GitHub__get_profile`
- `mcp__GitHub__get_repo_collaborator_permission`
- `mcp__GitHub__get_repo`
- `mcp__GitHub__get_user_login`
- `mcp__GitHub__get_users_recent_prs_in_repo`
- `mcp__GitHub__label_pr`
- `mcp__GitHub__list_installations`
- `mcp__GitHub__list_installed_accounts`
- `mcp__GitHub__list_pr_changed_filenames`
- `mcp__GitHub__list_pull_request_review_threads`
- `mcp__GitHub__list_pull_request_reviews`
- `mcp__GitHub__list_recent_issues`
- `mcp__GitHub__list_repositories_by_affiliation`
- `mcp__GitHub__list_repositories_by_installation`
- `mcp__GitHub__list_repositories`
- `mcp__GitHub__list_user_org_memberships`
- `mcp__GitHub__list_user_orgs`
- `mcp__GitHub__lock_issue_conversation`
- `mcp__GitHub__mark_pull_request_ready_for_review`
- `mcp__GitHub__merge_pull_request`
- `mcp__GitHub__remove_issue_assignees`
- `mcp__GitHub__remove_issue_label`
- `mcp__GitHub__remove_pull_request_reviewers`
- `mcp__GitHub__remove_reaction_from_issue_comment`
- `mcp__GitHub__remove_reaction_from_pr_review_comment`
- `mcp__GitHub__remove_reaction_from_pr`
- `mcp__GitHub__reply_to_review_comment`
- `mcp__GitHub__request_pull_request_reviewers`
- `mcp__GitHub__rerun_failed_workflow_run_jobs`
- `mcp__GitHub__rerun_workflow_job`
- `mcp__GitHub__resolve_review_thread`
- `mcp__GitHub__search_branches`
- `mcp__GitHub__search_commits`
- `mcp__GitHub__search_installed_repositories_streaming`
- `mcp__GitHub__search_installed_repositories_v2`
- `mcp__GitHub__search_issues`
- `mcp__GitHub__search_prs`
- `mcp__GitHub__search_repositories`
- `mcp__GitHub__search`
- `mcp__GitHub__unlock_issue_conversation`
- `mcp__GitHub__unresolve_review_thread`
- `mcp__GitHub__update_file`
- `mcp__GitHub__update_issue_comment`
- `mcp__GitHub__update_issue`
- `mcp__GitHub__update_pull_request`
- `mcp__GitHub__update_ref`
- `mcp__GitHub__update_review_comment`

### mcp__Gmail (20)
- `mcp__Gmail__apply_sensitive_message_label`
- `mcp__Gmail__apply_sensitive_thread_label`
- `mcp__Gmail__create_draft`
- `mcp__Gmail__create_label`
- `mcp__Gmail__delete_label`
- `mcp__Gmail__forward`
- `mcp__Gmail__get_message`
- `mcp__Gmail__get_profile`
- `mcp__Gmail__get_thread`
- `mcp__Gmail__label_message`
- `mcp__Gmail__label_thread`
- `mcp__Gmail__list_drafts`
- `mcp__Gmail__list_labels`
- `mcp__Gmail__reply`
- `mcp__Gmail__search_threads`
- `mcp__Gmail__send_message`
- `mcp__Gmail__unlabel_message`
- `mcp__Gmail__unlabel_thread`
- `mcp__Gmail__update_draft`
- `mcp__Gmail__update_label`

### mcp__Google_Calendar (10)
- `mcp__Google_Calendar__create_event`
- `mcp__Google_Calendar__delete_event`
- `mcp__Google_Calendar__get_event`
- `mcp__Google_Calendar__get_profile`
- `mcp__Google_Calendar__list_calendars`
- `mcp__Google_Calendar__list_events`
- `mcp__Google_Calendar__respond_to_event`
- `mcp__Google_Calendar__search_events`
- `mcp__Google_Calendar__suggest_time`
- `mcp__Google_Calendar__update_event`

### mcp__Hatchable (34)
- `mcp__Hatchable__create_preview_link`
- `mcp__Hatchable__create_project`
- `mcp__Hatchable__delete_file`
- `mcp__Hatchable__deploy`
- `mcp__Hatchable__dry_run_deploy`
- `mcp__Hatchable__execute_sql`
- `mcp__Hatchable__fork_project`
- `mcp__Hatchable__get_deployment`
- `mcp__Hatchable__get_project`
- `mcp__Hatchable__get_schema`
- `mcp__Hatchable__grep`
- `mcp__Hatchable__import_file_from_url`
- `mcp__Hatchable__list_agent_tasks`
- `mcp__Hatchable__list_cron_jobs`
- `mcp__Hatchable__list_deployments`
- `mcp__Hatchable__list_files`
- `mcp__Hatchable__list_functions`
- `mcp__Hatchable__list_pending_uploads`
- `mcp__Hatchable__list_projects`
- `mcp__Hatchable__list_skills`
- `mcp__Hatchable__patch_file`
- `mcp__Hatchable__read_file`
- `mcp__Hatchable__read_skill`
- `mcp__Hatchable__run_code`
- `mcp__Hatchable__run_function`
- `mcp__Hatchable__search_documentation`
- `mcp__Hatchable__search_projects`
- `mcp__Hatchable__submit_platform_feedback`
- `mcp__Hatchable__update_agent_task`
- `mcp__Hatchable__update_project`
- `mcp__Hatchable__upload_file`
- `mcp__Hatchable__view_logs`
- `mcp__Hatchable__write_file`
- `mcp__Hatchable__write_files`

### mcp__Linear (93)
- `mcp__Linear__create_attachment_from_upload`
- `mcp__Linear__create_attachment`
- `mcp__Linear__create_initiative_label`
- `mcp__Linear__create_issue_label`
- `mcp__Linear__delete_attachment`
- `mcp__Linear__delete_comment`
- `mcp__Linear__delete_customer_need`
- `mcp__Linear__delete_customer`
- `mcp__Linear__delete_diff_comment`
- `mcp__Linear__delete_review_criterion`
- `mcp__Linear__delete_status_update`
- `mcp__Linear__extract_images`
- `mcp__Linear__fetch`
- `mcp__Linear__get_agent_context`
- `mcp__Linear__get_agent_skill`
- `mcp__Linear__get_attachment`
- `mcp__Linear__get_diff_threads`
- `mcp__Linear__get_diff`
- `mcp__Linear__get_document`
- `mcp__Linear__get_initiative`
- `mcp__Linear__get_issue_status`
- `mcp__Linear__get_issue`
- `mcp__Linear__get_milestone`
- `mcp__Linear__get_notifications`
- `mcp__Linear__get_project`
- `mcp__Linear__get_release_note`
- `mcp__Linear__get_release`
- `mcp__Linear__get_status_updates`
- `mcp__Linear__get_team`
- `mcp__Linear__get_template`
- `mcp__Linear__get_triage_responsibility`
- `mcp__Linear__get_user`
- `mcp__Linear__get_workspace`
- `mcp__Linear__list_agent_skills`
- `mcp__Linear__list_comments`
- `mcp__Linear__list_custom_views`
- `mcp__Linear__list_customer_needs`
- `mcp__Linear__list_customers`
- `mcp__Linear__list_cycles`
- `mcp__Linear__list_diffs`
- `mcp__Linear__list_documents`
- `mcp__Linear__list_initiative_labels`
- `mcp__Linear__list_initiatives`
- `mcp__Linear__list_issue_labels`
- `mcp__Linear__list_issue_statuses`
- `mcp__Linear__list_issues`
- `mcp__Linear__list_milestones`
- `mcp__Linear__list_project_labels`
- `mcp__Linear__list_projects`
- `mcp__Linear__list_release_notes`
- `mcp__Linear__list_release_pipelines`
- `mcp__Linear__list_releases`
- `mcp__Linear__list_review_criteria`
- `mcp__Linear__list_teams`
- `mcp__Linear__list_templates`
- `mcp__Linear__list_users`
- `mcp__Linear__mark_notification`
- `mcp__Linear__merge_diff`
- `mcp__Linear__prepare_attachment_upload`
- `mcp__Linear__prepare_file_upload`
- `mcp__Linear__record_agent_learning`
- `mcp__Linear__report_agent_friction`
- `mcp__Linear__report_helpful_agent_context`
- `mcp__Linear__resolve_diff_thread`
- `mcp__Linear__restore_initiative_label`
- `mcp__Linear__restore_issue_label`
- `mcp__Linear__restore_project_label`
- `mcp__Linear__retire_initiative_label`
- `mcp__Linear__retire_issue_label`
- `mcp__Linear__retire_project_label`
- `mcp__Linear__save_comment`
- `mcp__Linear__save_customer_need`
- `mcp__Linear__save_customer`
- `mcp__Linear__save_diff_comment`
- `mcp__Linear__save_document`
- `mcp__Linear__save_initiative_label`
- `mcp__Linear__save_initiative`
- `mcp__Linear__save_issue_label`
- `mcp__Linear__save_issue`
- `mcp__Linear__save_milestone`
- `mcp__Linear__save_project_label`
- `mcp__Linear__save_project`
- `mcp__Linear__save_release_note`
- `mcp__Linear__save_release`
- `mcp__Linear__save_status_update`
- `mcp__Linear__search_documentation`
- `mcp__Linear__search`
- `mcp__Linear__share_issue`
- `mcp__Linear__submit_diff_review`
- `mcp__Linear__unshare_issue`
- `mcp__Linear__update_diff_finding`
- `mcp__Linear__update_diff`
- `mcp__Linear__whoami`

### mcp__Neon (141)
- `mcp__Neon__add_auth_oauth_provider`
- `mcp__Neon__add_auth_trusted_domain`
- `mcp__Neon__compare_database_schema`
- `mcp__Neon__complete_database_migration`
- `mcp__Neon__complete_query_tuning`
- `mcp__Neon__count_projects`
- `mcp__Neon__create_auth_oauth_client`
- `mcp__Neon__create_auth_user`
- `mcp__Neon__create_branch`
- `mcp__Neon__create_credential`
- `mcp__Neon__create_postgres_database`
- `mcp__Neon__create_postgres_endpoint`
- `mcp__Neon__create_postgres_role`
- `mcp__Neon__create_project`
- `mcp__Neon__create_snapshot`
- `mcp__Neon__create_storage_bucket`
- `mcp__Neon__create_trigger`
- `mcp__Neon__delete_auth_oauth_client`
- `mcp__Neon__delete_auth_oauth_provider`
- `mcp__Neon__delete_auth_trusted_domain`
- `mcp__Neon__delete_auth_user`
- `mcp__Neon__delete_branch`
- `mcp__Neon__delete_data_api`
- `mcp__Neon__delete_function`
- `mcp__Neon__delete_functions_custom_domain`
- `mcp__Neon__delete_postgres_database`
- `mcp__Neon__delete_postgres_endpoint`
- `mcp__Neon__delete_postgres_role`
- `mcp__Neon__delete_project`
- `mcp__Neon__delete_snapshot`
- `mcp__Neon__delete_storage_bucket`
- `mcp__Neon__delete_storage_object`
- `mcp__Neon__delete_storage_objects_by_prefix`
- `mcp__Neon__delete_trigger`
- `mcp__Neon__deploy_function`
- `mcp__Neon__describe_branch`
- `mcp__Neon__describe_project`
- `mcp__Neon__describe_table_schema`
- `mcp__Neon__disable_auth`
- `mcp__Neon__disable_realtime`
- `mcp__Neon__enable_realtime`
- `mcp__Neon__explain_sql_statement`
- `mcp__Neon__fetch`
- `mcp__Neon__finalize_branch_restore`
- `mcp__Neon__get_ai_gateway`
- `mcp__Neon__get_auth_oauth_client`
- `mcp__Neon__get_auth_oauth_server`
- `mcp__Neon__get_auth`
- `mcp__Neon__get_branch_consumption`
- `mcp__Neon__get_branch`
- `mcp__Neon__get_connection_string`
- `mcp__Neon__get_data_api`
- `mcp__Neon__get_database_tables`
- `mcp__Neon__get_default_branch`
- `mcp__Neon__get_doc`
- `mcp__Neon__get_function`
- `mcp__Neon__get_neon_auth_config`
- `mcp__Neon__get_operation`
- `mcp__Neon__get_postgres_database`
- `mcp__Neon__get_postgres_endpoint`
- `mcp__Neon__get_postgres_role`
- `mcp__Neon__get_project_consumption`
- `mcp__Neon__get_realtime_secret`
- `mcp__Neon__get_realtime`
- `mcp__Neon__get_snapshot_schedule`
- `mcp__Neon__get_storage`
- `mcp__Neon__get_trigger`
- `mcp__Neon__inspect_database`
- `mcp__Neon__list_auth_oauth_clients`
- `mcp__Neon__list_auth_oauth_providers`
- `mcp__Neon__list_auth_trusted_domains`
- `mcp__Neon__list_branch_computes`
- `mcp__Neon__list_branches`
- `mcp__Neon__list_credentials`
- `mcp__Neon__list_functions_custom_domains`
- `mcp__Neon__list_functions`
- `mcp__Neon__list_incidents`
- `mcp__Neon__list_log_field_values`
- `mcp__Neon__list_log_fields`
- `mcp__Neon__list_operations`
- `mcp__Neon__list_organizations`
- `mcp__Neon__list_postgres_databases`
- `mcp__Neon__list_postgres_endpoints`
- `mcp__Neon__list_postgres_roles`
- `mcp__Neon__list_project_members`
- `mcp__Neon__list_project_permissions`
- `mcp__Neon__list_projects`
- `mcp__Neon__list_regions`
- `mcp__Neon__list_slow_queries`
- `mcp__Neon__list_snapshots`
- `mcp__Neon__list_storage_buckets`
- `mcp__Neon__list_storage_objects`
- `mcp__Neon__list_triggers`
- `mcp__Neon__prepare_database_migration`
- `mcp__Neon__prepare_query_tuning`
- `mcp__Neon__presign_storage_object`
- `mcp__Neon__provision_neon_auth`
- `mcp__Neon__provision_neon_data_api`
- `mcp__Neon__query_logs`
- `mcp__Neon__query_loki_logs`
- `mcp__Neon__recover_project`
- `mcp__Neon__register_functions_custom_domain`
- `mcp__Neon__reset_from_parent`
- `mcp__Neon__reset_postgres_role_password`
- `mcp__Neon__restart_postgres_endpoint`
- `mcp__Neon__restore_snapshot`
- `mcp__Neon__revoke_credential`
- `mcp__Neon__rotate_auth_oauth_client_secret`
- `mcp__Neon__rotate_credential`
- `mcp__Neon__rotate_realtime_secret`
- `mcp__Neon__run_sql_transaction`
- `mcp__Neon__run_sql`
- `mcp__Neon__search_docs`
- `mcp__Neon__search`
- `mcp__Neon__send_auth_test_email`
- `mcp__Neon__send_feedback`
- `mcp__Neon__set_default_branch`
- `mcp__Neon__set_snapshot_schedule`
- `mcp__Neon__start_postgres_endpoint`
- `mcp__Neon__suspend_postgres_endpoint`
- `mcp__Neon__update_auth_allow_localhost`
- `mcp__Neon__update_auth_config`
- `mcp__Neon__update_auth_email_and_password`
- `mcp__Neon__update_auth_email_provider`
- `mcp__Neon__update_auth_logs_export`
- `mcp__Neon__update_auth_oauth_client`
- `mcp__Neon__update_auth_oauth_provider`
- `mcp__Neon__update_auth_oauth_server`
- `mcp__Neon__update_auth_plugins_magic_link`
- `mcp__Neon__update_auth_plugins_organization`
- `mcp__Neon__update_auth_plugins_phone_number`
- `mcp__Neon__update_auth_user_role`
- `mcp__Neon__update_auth_webhooks`
- `mcp__Neon__update_branch`
- `mcp__Neon__update_data_api`
- `mcp__Neon__update_function`
- `mcp__Neon__update_postgres_database`
- `mcp__Neon__update_postgres_endpoint`
- `mcp__Neon__update_project`
- `mcp__Neon__update_snapshot`
- `mcp__Neon__update_trigger`

### mcp__Plugin_Creator (9)
- `mcp__Plugin_Creator__create_plugin`
- `mcp__Plugin_Creator__get_owned_plugin_archive`
- `mcp__Plugin_Creator__get_plugin_files`
- `mcp__Plugin_Creator__get_plugin_metadata`
- `mcp__Plugin_Creator__get_plugin_sharing`
- `mcp__Plugin_Creator__list_owned_personal_plugins`
- `mcp__Plugin_Creator__list_plugin_releases`
- `mcp__Plugin_Creator__share_plugin`
- `mcp__Plugin_Creator__update_plugin`

### mcp__Plugin_Management (4)
- `mcp__Plugin_Management__get_app_permissions`
- `mcp__Plugin_Management__get_plugin_dependencies`
- `mcp__Plugin_Management__uninstall_app`
- `mcp__Plugin_Management__update_app_permissions`

### mcp__Remote_Desktop_Commander (30)
- `mcp__Remote_Desktop_Commander__create_directory`
- `mcp__Remote_Desktop_Commander__edit_block`
- `mcp__Remote_Desktop_Commander__force_terminate`
- `mcp__Remote_Desktop_Commander__get_config`
- `mcp__Remote_Desktop_Commander__get_file_info`
- `mcp__Remote_Desktop_Commander__get_more_search_results`
- `mcp__Remote_Desktop_Commander__get_recent_tool_calls`
- `mcp__Remote_Desktop_Commander__get_tool_result`
- `mcp__Remote_Desktop_Commander__get_usage_stats`
- `mcp__Remote_Desktop_Commander__interact_with_process`
- `mcp__Remote_Desktop_Commander__kill_process`
- `mcp__Remote_Desktop_Commander__list_devices`
- `mcp__Remote_Desktop_Commander__list_directory`
- `mcp__Remote_Desktop_Commander__list_processes`
- `mcp__Remote_Desktop_Commander__list_remote_tool_calls`
- `mcp__Remote_Desktop_Commander__list_searches`
- `mcp__Remote_Desktop_Commander__list_sessions`
- `mcp__Remote_Desktop_Commander__move_file`
- `mcp__Remote_Desktop_Commander__read_file`
- `mcp__Remote_Desktop_Commander__read_multiple_files`
- `mcp__Remote_Desktop_Commander__read_process_output`
- `mcp__Remote_Desktop_Commander__review_device_call`
- `mcp__Remote_Desktop_Commander__set_config_value`
- `mcp__Remote_Desktop_Commander__shutdown`
- `mcp__Remote_Desktop_Commander__start_process`
- `mcp__Remote_Desktop_Commander__start_search`
- `mcp__Remote_Desktop_Commander__stop_search`
- `mcp__Remote_Desktop_Commander__who_am_i`
- `mcp__Remote_Desktop_Commander__write_file`
- `mcp__Remote_Desktop_Commander__write_pdf`

### mcp__Render (48)
- `mcp__Render__approve_blueprint`
- `mcp__Render__cancel_cron_job_run`
- `mcp__Render__cancel_flow_run`
- `mcp__Render__create_blueprint`
- `mcp__Render__create_cron_job`
- `mcp__Render__create_key_value`
- `mcp__Render__create_postgres`
- `mcp__Render__create_static_site`
- `mcp__Render__create_web_service`
- `mcp__Render__create_workflow_version`
- `mcp__Render__create_workflow`
- `mcp__Render__get_blueprint`
- `mcp__Render__get_deploy`
- `mcp__Render__get_flow_run_results`
- `mcp__Render__get_flow_run_step`
- `mcp__Render__get_flow_run`
- `mcp__Render__get_flow`
- `mcp__Render__get_key_value`
- `mcp__Render__get_metrics`
- `mcp__Render__get_postgres`
- `mcp__Render__get_selected_workspace`
- `mcp__Render__get_service`
- `mcp__Render__get_workflow_run_results`
- `mcp__Render__get_workflow_run`
- `mcp__Render__get_workflow_task`
- `mcp__Render__get_workflow_version`
- `mcp__Render__get_workflow`
- `mcp__Render__list_deploys`
- `mcp__Render__list_events`
- `mcp__Render__list_flow_run_steps`
- `mcp__Render__list_flow_runs`
- `mcp__Render__list_key_value`
- `mcp__Render__list_log_label_values`
- `mcp__Render__list_logs`
- `mcp__Render__list_postgres_instances`
- `mcp__Render__list_services`
- `mcp__Render__list_workflow_runs`
- `mcp__Render__list_workflow_tasks`
- `mcp__Render__list_workflow_versions`
- `mcp__Render__list_workflows`
- `mcp__Render__list_workspaces`
- `mcp__Render__plan_blueprint`
- `mcp__Render__query_render_postgres`
- `mcp__Render__run_cron_job`
- `mcp__Render__select_workspace`
- `mcp__Render__trigger_deploy`
- `mcp__Render__update_blueprint`
- `mcp__Render__update_environment_variables`

### mcp__Replit (8)
- `mcp__Replit__ask_question`
- `mcp__Replit__create_app_from_prompt`
- `mcp__Replit__get_publish_status`
- `mcp__Replit__list_apps`
- `mcp__Replit__publish_app`
- `mcp__Replit__resolve_app_by_name`
- `mcp__Replit__search_apps`
- `mcp__Replit__update_app_using_prompt`

### mcp__Supabase (36)
- `mcp__Supabase__apply_migration`
- `mcp__Supabase__confirm_cost`
- `mcp__Supabase__create_branch`
- `mcp__Supabase__create_notebook`
- `mcp__Supabase__create_project`
- `mcp__Supabase__delete_branch`
- `mcp__Supabase__delete_feedback`
- `mcp__Supabase__delete_notebook`
- `mcp__Supabase__deploy_edge_function`
- `mcp__Supabase__execute_sql`
- `mcp__Supabase__generate_typescript_types`
- `mcp__Supabase__get_advisors`
- `mcp__Supabase__get_cost`
- `mcp__Supabase__get_edge_function`
- `mcp__Supabase__get_notebook`
- `mcp__Supabase__get_organization`
- `mcp__Supabase__get_project_url`
- `mcp__Supabase__get_project`
- `mcp__Supabase__get_publishable_keys`
- `mcp__Supabase__list_branches`
- `mcp__Supabase__list_edge_functions`
- `mcp__Supabase__list_extensions`
- `mcp__Supabase__list_migrations`
- `mcp__Supabase__list_notebooks`
- `mcp__Supabase__list_organizations`
- `mcp__Supabase__list_projects`
- `mcp__Supabase__list_tables`
- `mcp__Supabase__merge_branch`
- `mcp__Supabase__pause_project`
- `mcp__Supabase__query_logs`
- `mcp__Supabase__rebase_branch`
- `mcp__Supabase__reset_branch`
- `mcp__Supabase__restore_project`
- `mcp__Supabase__run_notebook`
- `mcp__Supabase__search_docs`
- `mcp__Supabase__submit_feedback`

### mcp__Todoist (49)
- `mcp__Todoist__To_Do_List___Calendar__add_comments`
- `mcp__Todoist__To_Do_List___Calendar__add_filters`
- `mcp__Todoist__To_Do_List___Calendar__add_labels`
- `mcp__Todoist__To_Do_List___Calendar__add_projects`
- `mcp__Todoist__To_Do_List___Calendar__add_reminders`
- `mcp__Todoist__To_Do_List___Calendar__add_sections`
- `mcp__Todoist__To_Do_List___Calendar__add_tasks`
- `mcp__Todoist__To_Do_List___Calendar__analyze_project_health`
- `mcp__Todoist__To_Do_List___Calendar__complete_tasks`
- `mcp__Todoist__To_Do_List___Calendar__delete_object`
- `mcp__Todoist__To_Do_List___Calendar__export_project_template`
- `mcp__Todoist__To_Do_List___Calendar__fetch_object`
- `mcp__Todoist__To_Do_List___Calendar__fetch`
- `mcp__Todoist__To_Do_List___Calendar__find_activity`
- `mcp__Todoist__To_Do_List___Calendar__find_comments`
- `mcp__Todoist__To_Do_List___Calendar__find_completed_tasks`
- `mcp__Todoist__To_Do_List___Calendar__find_filters`
- `mcp__Todoist__To_Do_List___Calendar__find_labels`
- `mcp__Todoist__To_Do_List___Calendar__find_project_collaborators`
- `mcp__Todoist__To_Do_List___Calendar__find_projects`
- `mcp__Todoist__To_Do_List___Calendar__find_reminders`
- `mcp__Todoist__To_Do_List___Calendar__find_sections`
- `mcp__Todoist__To_Do_List___Calendar__find_tasks_by_date`
- `mcp__Todoist__To_Do_List___Calendar__find_tasks`
- `mcp__Todoist__To_Do_List___Calendar__get_overview`
- `mcp__Todoist__To_Do_List___Calendar__get_productivity_stats`
- `mcp__Todoist__To_Do_List___Calendar__get_project_activity_stats`
- `mcp__Todoist__To_Do_List___Calendar__get_project_health`
- `mcp__Todoist__To_Do_List___Calendar__get_user_status`
- `mcp__Todoist__To_Do_List___Calendar__get_workspace_insights`
- `mcp__Todoist__To_Do_List___Calendar__import_project_template`
- `mcp__Todoist__To_Do_List___Calendar__list_workspaces`
- `mcp__Todoist__To_Do_List___Calendar__manage_assignments`
- `mcp__Todoist__To_Do_List___Calendar__project_management`
- `mcp__Todoist__To_Do_List___Calendar__project_move`
- `mcp__Todoist__To_Do_List___Calendar__reorder_objects`
- `mcp__Todoist__To_Do_List___Calendar__reschedule_tasks`
- `mcp__Todoist__To_Do_List___Calendar__search`
- `mcp__Todoist__To_Do_List___Calendar__set_user_status`
- `mcp__Todoist__To_Do_List___Calendar__uncomplete_tasks`
- `mcp__Todoist__To_Do_List___Calendar__update_comments`
- `mcp__Todoist__To_Do_List___Calendar__update_filters`
- `mcp__Todoist__To_Do_List___Calendar__update_labels`
- `mcp__Todoist__To_Do_List___Calendar__update_projects`
- `mcp__Todoist__To_Do_List___Calendar__update_reminders`
- `mcp__Todoist__To_Do_List___Calendar__update_sections`
- `mcp__Todoist__To_Do_List___Calendar__update_tasks`
- `mcp__Todoist__To_Do_List___Calendar__user_info`
- `mcp__Todoist__To_Do_List___Calendar__view_attachment`

### mcp__Trello (15)
- `mcp__Trello__trelloReadBoard`
- `mcp__Trello__trelloReadCard`
- `mcp__Trello__trelloReadChecklist`
- `mcp__Trello__trelloReadInbox`
- `mcp__Trello__trelloReadList`
- `mcp__Trello__trelloReadMember`
- `mcp__Trello__trelloReadPlanner`
- `mcp__Trello__trelloReadWorkspace`
- `mcp__Trello__trelloSearch`
- `mcp__Trello__trelloWriteBoard`
- `mcp__Trello__trelloWriteCard`
- `mcp__Trello__trelloWriteChecklist`
- `mcp__Trello__trelloWriteInbox`
- `mcp__Trello__trelloWriteList`
- `mcp__Trello__trelloWritePlanner`

### mcp__Vercel (260)
- `mcp__Vercel__accept_project_transfer_request`
- `mcp__Vercel__activate_kms_signing_key`
- `mcp__Vercel__add_project_domain`
- `mcp__Vercel__add_route`
- `mcp__Vercel__add_toolbar_reaction`
- `mcp__Vercel__aggregate_events`
- `mcp__Vercel__aggregate_pageviews`
- `mcp__Vercel__approve_rolling_release_stage`
- `mcp__Vercel__artifact_query`
- `mcp__Vercel__assign_alias`
- `mcp__Vercel__authorize_team_access`
- `mcp__Vercel__authorize_team_sso`
- `mcp__Vercel__buy_domain`
- `mcp__Vercel__cancel_deployment`
- `mcp__Vercel__change_toolbar_thread_resolve_status`
- `mcp__Vercel__complete_rolling_release`
- `mcp__Vercel__count_events`
- `mcp__Vercel__count_pageviews`
- `mcp__Vercel__create_deployment`
- `mcp__Vercel__create_drain`
- `mcp__Vercel__create_edge_config_token`
- `mcp__Vercel__create_edge_config`
- `mcp__Vercel__create_flag`
- `mcp__Vercel__create_flags_project_connection`
- `mcp__Vercel__create_git_project`
- `mcp__Vercel__create_kms_issuer_policy`
- `mcp__Vercel__create_kms_issuer`
- `mcp__Vercel__create_kms_signing_key`
- `mcp__Vercel__create_observability_query`
- `mcp__Vercel__create_or_transfer_domain`
- `mcp__Vercel__create_project_env`
- `mcp__Vercel__create_project`
- `mcp__Vercel__create_record`
- `mcp__Vercel__create_sandboxes_sessions_by_session_id_snapshot_v2`
- `mcp__Vercel__create_sandboxes_sessions_by_session_id_snapshot_v3`
- `mcp__Vercel__create_sandboxes_v2`
- `mcp__Vercel__create_sandboxes_v3`
- `mcp__Vercel__create_sandboxes_v4`
- `mcp__Vercel__create_sdk_key`
- `mcp__Vercel__create_session_directory`
- `mcp__Vercel__create_storage_stores_blob`
- `mcp__Vercel__create_trace_session`
- `mcp__Vercel__delete_drive`
- `mcp__Vercel__delete_sandbox`
- `mcp__Vercel__delete_session_snapshot`
- `mcp__Vercel__edit_project_env`
- `mcp__Vercel__edit_route`
- `mcp__Vercel__edit_toolbar_message`
- `mcp__Vercel__extend_session_timeout`
- `mcp__Vercel__filter_project_envs`
- `mcp__Vercel__generate_route`
- `mcp__Vercel__get_access_to_vercel_url`
- `mcp__Vercel__get_active_attack_status`
- `mcp__Vercel__get_agent_run_trace`
- `mcp__Vercel__get_agent_run`
- `mcp__Vercel__get_ai_gateway_leaderboard`
- `mcp__Vercel__get_ai_gateway_model`
- `mcp__Vercel__get_ai_gateway_usage`
- `mcp__Vercel__get_alias`
- `mcp__Vercel__get_auth_user`
- `mcp__Vercel__get_board_identity`
- `mcp__Vercel__get_board_thread`
- `mcp__Vercel__get_bulk_availability`
- `mcp__Vercel__get_bulk_price`
- `mcp__Vercel__get_bypass_ip`
- `mcp__Vercel__get_cert_by_id`
- `mcp__Vercel__get_configuration`
- `mcp__Vercel__get_connector_project_connection`
- `mcp__Vercel__get_connector`
- `mcp__Vercel__get_contact_info_schema`
- `mcp__Vercel__get_custom_environment`
- `mcp__Vercel__get_deployment_feature_flags`
- `mcp__Vercel__get_deployment_file_contents`
- `mcp__Vercel__get_deployment`
- `mcp__Vercel__get_domain_availability`
- `mcp__Vercel__get_domain_config`
- `mcp__Vercel__get_domain_contact_verification`
- `mcp__Vercel__get_domain_order`
- `mcp__Vercel__get_domain_price`
- `mcp__Vercel__get_domain_project_domains`
- `mcp__Vercel__get_domain_verification_record`
- `mcp__Vercel__get_domain`
- `mcp__Vercel__get_domains_records_by_record_id`
- `mcp__Vercel__get_drain`
- `mcp__Vercel__get_edge_config_backup`
- `mcp__Vercel__get_edge_config_backups`
- `mcp__Vercel__get_edge_config_item`
- `mcp__Vercel__get_edge_config_items`
- `mcp__Vercel__get_edge_config_token`
- `mcp__Vercel__get_edge_config_tokens`
- `mcp__Vercel__get_edge_config`
- `mcp__Vercel__get_edge_configs`
- `mcp__Vercel__get_firewall_config`
- `mcp__Vercel__get_flag_segment`
- `mcp__Vercel__get_flag_settings`
- `mcp__Vercel__get_flag`
- `mcp__Vercel__get_flags_project_disconnection_link`
- `mcp__Vercel__get_git_deployment_context`
- `mcp__Vercel__get_kms_issuer`
- `mcp__Vercel__get_microfrontends_config_for_project`
- `mcp__Vercel__get_microfrontends_config`
- `mcp__Vercel__get_named_sandbox`
- `mcp__Vercel__get_observability_configuration_projects`
- `mcp__Vercel__get_observability_schema`
- `mcp__Vercel__get_or_create_drive`
- `mcp__Vercel__get_order`
- `mcp__Vercel__get_project_deletion_link`
- `mcp__Vercel__get_project_domain`
- `mcp__Vercel__get_project_env`
- `mcp__Vercel__get_project_trace`
- `mcp__Vercel__get_project`
- `mcp__Vercel__get_purchase_quote`
- `mcp__Vercel__get_records`
- `mcp__Vercel__get_remote_cache_status`
- `mcp__Vercel__get_rolling_release_billing_status`
- `mcp__Vercel__get_rolling_release_config`
- `mcp__Vercel__get_rolling_release`
- `mcp__Vercel__get_runtime_errors`
- `mcp__Vercel__get_runtime_logs`
- `mcp__Vercel__get_session_command_logs`
- `mcp__Vercel__get_session_command`
- `mcp__Vercel__get_session_snapshot`
- `mcp__Vercel__get_session`
- `mcp__Vercel__get_shared_env_var`
- `mcp__Vercel__get_storage_stores_by_id`
- `mcp__Vercel__get_team`
- `mcp__Vercel__get_tld_price`
- `mcp__Vercel__get_tld`
- `mcp__Vercel__get_toolbar_thread`
- `mcp__Vercel__get_vercel_ci_invocation_logs`
- `mcp__Vercel__get_vercel_ci_invocation_tree`
- `mcp__Vercel__get_vercel_ci_invocation`
- `mcp__Vercel__get_vercel_ci_job_definition`
- `mcp__Vercel__get_vercel_ci_job_run_logs`
- `mcp__Vercel__get_vercel_ci_job_run`
- `mcp__Vercel__get_vercel_ci_task_logs`
- `mcp__Vercel__get_vercel_ci_task_run_logs`
- `mcp__Vercel__get_webhooks`
- `mcp__Vercel__git_namespaces`
- `mcp__Vercel__invalidate_by_src_images`
- `mcp__Vercel__invalidate_by_tags`
- `mcp__Vercel__issue_cert`
- `mcp__Vercel__kill_session_command`
- `mcp__Vercel__label_board_message`
- `mcp__Vercel__list_access_group_members`
- `mcp__Vercel__list_access_group_projects`
- `mcp__Vercel__list_access_groups`
- `mcp__Vercel__list_agent_run_projects`
- `mcp__Vercel__list_agent_runs`
- `mcp__Vercel__list_ai_gateway_models`
- `mcp__Vercel__list_aliases`
- `mcp__Vercel__list_billing_charges`
- `mcp__Vercel__list_board_channels`
- `mcp__Vercel__list_board_threads`
- `mcp__Vercel__list_bulk_redirect_versions`
- `mcp__Vercel__list_bulk_redirects`
- `mcp__Vercel__list_certs`
- `mcp__Vercel__list_connector_project_connections`
- `mcp__Vercel__list_connectors`
- `mcp__Vercel__list_contract_commitments`
- `mcp__Vercel__list_deployment_aliases`
- `mcp__Vercel__list_deployment_events`
- `mcp__Vercel__list_deployment_files`
- `mcp__Vercel__list_deployments`
- `mcp__Vercel__list_domains`
- `mcp__Vercel__list_drains`
- `mcp__Vercel__list_drives`
- `mcp__Vercel__list_event_types`
- `mcp__Vercel__list_feature_flag_sdk_keys`
- `mcp__Vercel__list_flag_segments`
- `mcp__Vercel__list_flag_versions`
- `mcp__Vercel__list_flags_project_connections`
- `mcp__Vercel__list_flags_v2`
- `mcp__Vercel__list_flags`
- `mcp__Vercel__list_integration_billing_plans`
- `mcp__Vercel__list_integration_configuration_products`
- `mcp__Vercel__list_integration_configurations`
- `mcp__Vercel__list_kms_issuers`
- `mcp__Vercel__list_named_sandboxes`
- `mcp__Vercel__list_project_connector_connections`
- `mcp__Vercel__list_project_custom_environments`
- `mcp__Vercel__list_project_domains`
- `mcp__Vercel__list_project_route_versions`
- `mcp__Vercel__list_project_routes`
- `mcp__Vercel__list_projects`
- `mcp__Vercel__list_promote_aliases`
- `mcp__Vercel__list_session_commands`
- `mcp__Vercel__list_session_snapshots`
- `mcp__Vercel__list_sessions`
- `mcp__Vercel__list_supported_tlds`
- `mcp__Vercel__list_team_flag_settings`
- `mcp__Vercel__list_team_flags_v2`
- `mcp__Vercel__list_team_flags`
- `mcp__Vercel__list_team_members`
- `mcp__Vercel__list_teams`
- `mcp__Vercel__list_toolbar_threads`
- `mcp__Vercel__list_user_events`
- `mcp__Vercel__list_vercel_ci_invocation_attempts`
- `mcp__Vercel__list_vercel_ci_invocations`
- `mcp__Vercel__list_vercel_ci_job_definitions`
- `mcp__Vercel__list_vercel_ci_job_runs`
- `mcp__Vercel__list_vercel_ci_task_definitions`
- `mcp__Vercel__list_vercel_ci_task_runs`
- `mcp__Vercel__open_deployments`
- `mcp__Vercel__patch_edge_config_items`
- `mcp__Vercel__patch_url_protection_bypass`
- `mcp__Vercel__pause_project`
- `mcp__Vercel__put_firewall_config`
- `mcp__Vercel__react_to_board_message`
- `mcp__Vercel__read_access_group_project`
- `mcp__Vercel__read_access_group`
- `mcp__Vercel__read_session_file`
- `mcp__Vercel__record_events`
- `mcp__Vercel__replace_domain_dns_records`
- `mcp__Vercel__reply_to_board_thread`
- `mcp__Vercel__reply_to_toolbar_thread`
- `mcp__Vercel__request_promote`
- `mcp__Vercel__request_rollback`
- `mcp__Vercel__rerequest_check`
- `mcp__Vercel__restore_edge_config_backup`
- `mcp__Vercel__restore_redirects`
- `mcp__Vercel__retry_vercel_ci_invocation`
- `mcp__Vercel__revoke_kms_signing_key`
- `mcp__Vercel__run_session_command`
- `mcp__Vercel__search_domains`
- `mcp__Vercel__search_repo`
- `mcp__Vercel__search_vercel_documentation`
- `mcp__Vercel__stage_redirects`
- `mcp__Vercel__stage_routes`
- `mcp__Vercel__start_board_thread`
- `mcp__Vercel__start_rolling_release`
- `mcp__Vercel__stop_session`
- `mcp__Vercel__submit_feedback`
- `mcp__Vercel__test_drain`
- `mcp__Vercel__unpause_project`
- `mcp__Vercel__update_attack_challenge_mode`
- `mcp__Vercel__update_bulk_redirect_version`
- `mcp__Vercel__update_connector`
- `mcp__Vercel__update_drain`
- `mcp__Vercel__update_edge_config`
- `mcp__Vercel__update_firewall_config`
- `mcp__Vercel__update_flag_segment`
- `mcp__Vercel__update_flag_settings`
- `mcp__Vercel__update_flag`
- `mcp__Vercel__update_kms_issuer_policy`
- `mcp__Vercel__update_kms_issuer`
- `mcp__Vercel__update_project_protection_bypass`
- `mcp__Vercel__update_project`
- `mcp__Vercel__update_record`
- `mcp__Vercel__update_rolling_release_config`
- `mcp__Vercel__update_route_versions`
- `mcp__Vercel__update_sandbox`
- `mcp__Vercel__update_session_network_policy`
- `mcp__Vercel__upload_artifact`
- `mcp__Vercel__upload_file`
- `mcp__Vercel__upsert_connector_project_connection`
- `mcp__Vercel__verify_project_domain`
- `mcp__Vercel__wait_for_board_changes`
- `mcp__Vercel__web_fetch_vercel_url`
- `mcp__Vercel__write_session_files`

### mcp__Webflow (38)
- `mcp__Webflow__ask_webflow_ai`
- `mcp__Webflow__asset_tool`
- `mcp__Webflow__data_aeo_tool`
- `mcp__Webflow__data_agent_instructions_tool`
- `mcp__Webflow__data_analyze_tool`
- `mcp__Webflow__data_apps_tool`
- `mcp__Webflow__data_assets_tool`
- `mcp__Webflow__data_campaigns_tool`
- `mcp__Webflow__data_cms_tool`
- `mcp__Webflow__data_comments_tool`
- `mcp__Webflow__data_component_builder`
- `mcp__Webflow__data_component_props_tool`
- `mcp__Webflow__data_component_tool`
- `mcp__Webflow__data_component_variants_tool`
- `mcp__Webflow__data_element_builder`
- `mcp__Webflow__data_element_settings_tool`
- `mcp__Webflow__data_element_tool`
- `mcp__Webflow__data_enterprise_tool`
- `mcp__Webflow__data_fonts_tool`
- `mcp__Webflow__data_forms_tool`
- `mcp__Webflow__data_interactions_tool`
- `mcp__Webflow__data_localization_tool`
- `mcp__Webflow__data_members_tool`
- `mcp__Webflow__data_optimize_tool`
- `mcp__Webflow__data_pages_tool`
- `mcp__Webflow__data_scripts_tool`
- `mcp__Webflow__data_sitemap_tool`
- `mcp__Webflow__data_sites_tool`
- `mcp__Webflow__data_style_tool`
- `mcp__Webflow__data_variable_tool`
- `mcp__Webflow__data_webhook_tool`
- `mcp__Webflow__data_whtml_builder`
- `mcp__Webflow__designer_tool`
- `mcp__Webflow__element_snapshot_tool`
- `mcp__Webflow__get_asset_preview`
- `mcp__Webflow__get_more_tools`
- `mcp__Webflow__webflow_guide_tool`
- `mcp__Webflow__webflow_home`

### skills (2)
- `skills__list`
- `skills__read`

### user_settings (2)
- `user_settings__get_user_settings`
- `user_settings__set_setting`

## 4. Relevant read-oriented action descriptions
The following are exact exposed descriptions before each action's TypeScript schema. They are catalog evidence; only the operations in section 6 were actually invoked.

#### `mcp__GitHub__get_repo`
Retrieve metadata for a GitHub repository. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url`: - `repository_full_name`: `owner/name`, such as `openai/openai`. Maps to GitHub REST `owner` and `repo` path parameters. - `repository_id`: numeric GitHub repository ID, such as `1296269`. - `repository_url`: repository URL or nested repository URL, such as a PR, issue, branch, file, REST API, GitHub Enterprise Server `/api/v3`, or GHE.com API URL. GitHub REST repository docs: https://docs.github.com/en/rest/repos/repos#get-a-repository GitHub Enterprise Server REST docs: https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/getting-started-with-the-rest-api GHE.com API host docs: https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency#api-access

#### `mcp__GitHub__fetch_issue`
Fetch a GitHub issue. You must populate exactly one of `repository_full_name`, `repository_id`, or `repository_url` to select the issue's repository.

#### `mcp__GitHub__fetch_file`
Fetch file content by repository path, using the default branch when ref is omitted.

#### `mcp__GitHub__fetch_pr`
Fetch a pull request with its diff, metadata, and optionally comments.

#### `mcp__GitHub__get_pr_info`
Get metadata (title, description, refs, and status) for a pull request. This action does *not* include the actual code changes. If you need the diff or per-file patches, call `fetch_pr_patch` instead (or use `get_users_recent_prs_in_repo` with ``include_diff=True`` when listing the user's own PRs).

#### `mcp__GitHub__get_commit_combined_status`
Fetch the combined CI status and individual status checks for a commit.

#### `mcp__GitHub__fetch_workflow_job_logs`
Fetch decoded logs for a GitHub Actions workflow job. GitHub serves this endpoint through a temporary redirect; the underlying client follows that redirect before decoding the bytes. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#download-job-logs-for-a-workflow-run-job

#### `mcp__GitHub__fetch_workflow_job_steps`
Fetch steps for a GitHub Actions workflow job. Returns only step summaries, not the full job payload. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#get-a-job-for-a-workflow-run

#### `mcp__GitHub__fetch_workflow_run_jobs`
Fetch jobs for a GitHub Actions workflow run. This wrapper returns the latest attempt's jobs from the first page only. Docs: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28#list-jobs-for-a-workflow-run

#### `mcp__GitHub__list_pull_request_reviews`
List review submissions on a pull request. Returns GraphQL review nodes normalized into the connector's review model. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreview

#### `mcp__GitHub__list_pull_request_review_threads`
List inline review threads on a pull request, including resolved state. Returns GraphQL review thread nodes, including comment bodies and resolution metadata. Docs: https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread

#### `mcp__GitHub__search_issues`
Search one repository or every repository the linked account can access. Supply at most one repository selector. Empty lists mean no repository filter. A `repo:owner/name` query does not require a separate repository selector.

#### `mcp__GitHub__search_prs`
Search GitHub pull requests globally, by organization, or optionally by repository.

#### `mcp__Dropbox__get_file_metadata`
Get metadata, sharing details, and permissions for a Dropbox file or folder

PATHS:
- Input path_or_file_id accepts fq_path, ns_path, or file_id.
- Namespace IDs in ns_path are decimal digits and match [0-9]+.
- file_id: a Dropbox-issued file id (format: "id:<id>", where <id> uses A-Z, a-z, 0-9, "_" and "-"; example: "id:AbCd-_12"). It can identify a file or folder.
- Dropbox shared/web URLs are not accepted.
- Paths must be Unicode NFC-normalized; decomposed forms are rejected.
- Output nested metadata uses fq_path fields such as path_display and path_lower.
- Never strip the "ns:<id>//" prefix from values returned by other tools before passing them here.

REQUEST CONTRACT:
- path_or_file_id (string, REQUIRED): File or folder identifier.
  - Path formats: fq_path such as "/Documents/file.txt" or ns_path such as "ns:123//Documents/file.txt".
  - file_id format: "id:<id>", where <id> uses A-Z, a-z, 0-9, "_" and "-"; example: "id:AbCd-_12".

RESPONSE CONTRACT:
- metadata_type: "file" | "folder". Inspect this first.
- file: Present only when metadata_type="file".
  - tag, id, name, path_display, path_lower
  - client_modified, server_modified
  - size, size_display, is_downloadable, mime_type, rev
  - size may be absent (not zero) for empty files due to proto serialization. Treat absent as zero.
  - sharing_info, permissions, url, ext, has_explicit_shared_members
- folder: Present only when metadata_type="folder".
  - tag, id, name, path_display, path_lower
  - sharing_info, permissions, url
  - descendants_count, folder_size

ASSISTANT POLICY:
- Treat the response as nested. Do not assume there is a flat top-level tag, id, or name.
- Do not assume both file and folder are present.
- When using results from list_folder or search, pass the exact returned ns_path or file_id.

EXAMPLES:

{"path_or_file_id": "/Documents/report.pdf"}
{"path_or_file_id": "ns:123//Photos/image.png"}
{"path_or_file_id": "id:AbCd-_12"}

#### `mcp__Dropbox__fetch`
Fetch full text content for a Dropbox file by id or path.

REQUEST:
- id: File identifier or Dropbox path (required string; accepts file_id, fq_path, or ns_path)

INPUT SHAPES:
- Namespace IDs in ns_path are decimal digits and match [0-9]+.
- file_id: a Dropbox-issued file id (format: "id:<id>", where <id> uses A-Z, a-z, 0-9, "_" and "-"; example: "id:AbCd-_12"). It can identify a file or folder.

RESPONSE:
- id: Same id-or-path token used for the request
- title: Human-readable file title
- text: Full extracted text content
- url: Openable Dropbox URL for the file
- metadata: Optional string fields such as path_display and server_modified

NOTES:
- Use the id returned by search directly with this tool, or pass an existing Dropbox path.
- Shared/web URLs are not accepted; callers must pass a Dropbox path, namespace path, or file_id.
- Use this tool when the user wants extracted text content from the file, such as reading, quoting, or summarizing the file's text.
- Dropbox Paper documents are supported. For Paper, `text` is Markdown that includes the document title and supported structure such as headings, tables, links, lists, and code blocks.
- For preview-oriented asks such as preview, show, open, inspect visually, or get a thumbnail/open-in-Dropbox experience, prefer file_preview instead.
- This tool uses Dropbox's existing content extraction backends.
- url prefers GetFileContent.content_link and falls back to GetFileMetadata.file.url when needed.
- Max file size: 5 MiB.
- If extraction fails, the tool returns an error instead of a partial success payload.

EXAMPLES:
{"id": "/Documents/report.pdf"}
{"id": "ns:123//Documents/report.pdf"}
{"id": "id:AbCd-_12"}

#### `mcp__Dropbox__list_folder`
List Dropbox folder contents; supports direct children or recursive traversal

Purpose: List files and folders in Dropbox with cursor-based pagination.

PATHS:
- Input path accepts root ("" or "/"), fq_path (for example "/Documents"), or ns_path (for example "ns:123//Documents"). Dropbox shared/web URLs are not accepted.
- Namespace IDs in ns_path are decimal digits and match [0-9]+.
- Paths are case-insensitive.
- Paths must be Unicode NFC-normalized; decomposed forms are rejected.
- Use "" or "/" for root.
- Output entries[].path is always ns_path. Use this exact value for follow-on MCP calls.
- Output entries[].file_id is Dropbox-issued metadata for the entry.
- Output entries[].path_display is the fq_path. Only populated when recursive=false (children mode). Empty for recursive mode.
- Never strip the "ns:<id>//" prefix from returned paths.

REQUEST MODES:
- First call: send {"path": "..."} with optional parameters. To list root, send {"path": ""} or {"path": "/"}. Do not include cursor.
- Pagination: send {"cursor": "..."} only. Do not include path or other parameters.
- Cursor pagination returns the listing state from when the list started, not the latest folder state. To observe renames, moves, or new children after the first page, start a new list request instead of continuing the old cursor.
- For browsing a folder, set recursive=false explicitly. Omitting recursive performs a recursive scan. Recursive mode may traverse deeply and across mounted namespaces.

PARAMETERS:
- path (string, REQUIRED, first call only): Directory to list. Accepts "" or "/" for root, fq_path, or ns_path. Do not omit path in client requests. Dropbox shared/web URLs are not accepted.
- cursor (string, pagination only): Opaque non-empty cursor from a previous list_folder response. Reuse only with list_folder pagination. Mutually exclusive with all other parameters.
- object_types (string[], optional, first call only): User-facing object type filters. Valid values: "folder", "file". Empty or omitted returns all supported entries.
  - Any value other than "folder"/"file" is rejected with INVALID_OBJECT_TYPES.
  - "folder" includes regular folders and shared/team folder mounts.
  - "file" includes regular files and cloud docs.
  - For extension/category filtering, use search with path + file_extensions/file_categories.
- recursive (bool, optional, first call only): true or omitted lists all descendants recursively. false lists immediate children only (like ls).
- max_results (uint64, optional, first call only): Maximum page size. Range 0-600. Defaults to 300 when omitted or set to 0. It may return fewer entries than requested, including zero entries, even when has_more=true.

RESPONSE CONTRACT:
- entries[]: Array of object records.
  - name: Basename only.
  - path: ns_path. Use this exact value for follow-on MCP calls.
  - modified_time: Server-side modification time in ISO 8601 when available.
  - client_modified: Client-specified content modification time in ISO 8601 when available.
  - file_id: Dropbox-issued metadata for the entry.
  - object_type: "file" | "folder" | "mount".
  - path_display: fq_path. Populated for recursive=false only. Empty for recursive mode.
  - file.size: Present when object_type="file".
  - folder: Empty object when object_type="folder".
  - mount: Empty object when object_type="mount".
  - Shared folders may surface as object_type "mount" after sharing.
- cursor: Opaque cursor for the next page. Empty when has_more=false.
- has_more: Whether the server has more pages to scan. has_more=true means there is more data to scan but does not guarantee additional matching entries; a page may return zero entries with has_more=true. has_more=false means scanning is complete. Always paginate until has_more=false; do not infer completeness from entry count alone.

ASSISTANT POLICY:
- When showing entries to the user, MUST use path_display if path_display is present. Only fall back to path (ns_path) when path_display is absent or empty.
- For interactive folder browsing, prefer recursive=false. Use recursive=true only when the user explicitly asks to scan descendants.
- Validate modes strictly: first call uses path, pagination uses cursor only. Do not send options with cursor.
- Cursor pagination is snapshot-style: continuing a cursor returns the state from when the list started. Start a new list request when the user wants the latest folder state.
- Treat results as partial while has_more=true or cursor is non-empty.
- Ask before scanning many additional pages for exhaustive requests.
- Never claim root-level completeness until pagination is exhausted.
- For follow-on MCP calls, reuse entries[].path. Use entries[].file_id only with tools whose schema accepts file_id.

EXAMPLES:

{"path": ""}
{"path": "/Documents", "recursive": false}
{"path": "ns:123//Documents"}
{"cursor": "base64_cursor_from_previous_response"}

#### `mcp__Dropbox__search`
Search Dropbox files and folders by name or content, with optional filters

REQUEST:
- New search: non-empty query is required. Optional filters and sorting parameters can scope or refine results.
- max_results controls the maximum number of results returned by a new search. It accepts 1-1000 and defaults to 100 when omitted.
- Pagination: send only the non-empty opaque cursor returned by a previous search response. Do not include query or filters with cursor.
- search_mode is optional. Omit it to use Dropbox's default search behavior, or set it to "title_only" to search filenames only. Semantic retrieval, when available, is selected automatically by Dropbox rather than through search_mode.
- Do not combine search_mode="title_only" with filename_only=false; filename_only=true is accepted for compatibility.

INPUT SHAPES:
- path accepts fq_path or ns_path.
- Namespace IDs in ns_path are decimal digits and match [0-9]+.

RESPONSE:
- results: Unified search results
  - id (string, required): Tool-ready identifier when the result has a Dropbox file_id; otherwise an empty string. Format: "id:<id>", where <id> uses A-Z, a-z, 0-9, "_" and "-". Example: "id:AbCd-_12".
  - title (string, required): File or folder basename. Example: "quarterly-report.pdf".
  - url (string, required): Openable Dropbox URL supplied directly by Fileverse search; empty when unavailable. Example: "https://www.dropbox.com/home/Reports/quarterly-report.pdf".
  - path (string, optional): Namespace-qualified path for follow-on calls. Example: "ns:123//Reports/quarterly-report.pdf".
  - path_display (string, optional): Human-readable display path. Example: "/Reports/quarterly-report.pdf".
  - object_type (string, optional): Result kind, such as "file", "folder", "paper", or "deleted". Example: "file".
  - match_type (string, optional): Where the query matched, such as "FILENAME", "FILE_CONTENT", or "BOTH_FILENAME_AND_CONTENT". Example: "FILENAME".
  - mime_type (string, optional): MIME type when available; omitted for folders. Example: "application/pdf".
  - size (integer, optional): File size in bytes; omitted when zero. Example: 2048.
  - last_modified (string, optional): ISO 8601 modification timestamp. Example: "2026-03-24T17:04:05Z".
  - rank (integer, optional): 1-based rank in the Fileverse search result stream; omitted when zero. Example: 1.
- has_more, cursor, total_results: Pagination fields populated in advanced/raw mode

NOTES:
- Query-only requests use simplified search: they return up to 100 active file results, never return folders, and do not include pagination fields.
- To return folders, specify include_folders. Providing this parameter activates advanced mode.
- Any extra parameter beyond query, or any cursor call, switches search into advanced mode.
- Search may return files that later fail text extraction in fetch.

EXAMPLES:
{"query": "quarterly reports"}
{"query": "quarterly reports", "max_results": 25}
{"query": "quarterly reports", "search_mode": "title_only"}
{"query": "projects", "include_folders": true}
{"query": "budget", "path": "/Documents", "file_categories": ["PDF"], "order_by": "last_modified"}
{"query": "budget", "path": "ns:123//Documents", "file_categories": ["PDF"], "order_by": "last_modified"}
{"cursor": "base64_cursor_from_previous_response"}

#### `mcp__Linear__whoami`
Retrieve the authenticated user, the connected workspace, and how this connection reaches Linear

#### `mcp__Linear__list_projects`
List projects in the user's Linear workspace

#### `mcp__Linear__get_project`
Retrieve details of a specific project in Linear

#### `mcp__Linear__list_issues`
List issues in the user's Linear workspace, including active Triage Intelligence suggestions for issues in triage. For issues assigned to me, use "me" as the assignee. For issues created by me, use "me" as the creator. Use "null" for no assignee.

#### `mcp__Linear__get_issue`
Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.

#### `mcp__Linear__list_agent_skills`
List Linear Agent skills available to the authenticated user.

#### `mcp__Remote_Desktop_Commander__list_devices`
List this account's Desktop Commander devices, their online/offline status, IDs for device selection, and device-management guidance

#### `mcp__Remote_Desktop_Commander__get_config`
Get the complete server configuration as JSON. Config includes fields for:
                        - blockedCommands (array of blocked shell commands)
                        - defaultShell (shell to use for commands)
                        - allowedDirectories (paths the server can access)
                        - fileReadLineLimit (max lines for read_file, default 1000)
                        - fileWriteLineLimit (max lines per write_file call, default 50)
                        - telemetryEnabled (boolean for telemetry opt-in/out)
                        - currentClient (information about the currently connected MCP client)
                        - clientHistory (history of all clients that have connected)
                        - version (version of the DesktopCommander)
                        - systemInfo (operating system and environment details)
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

#### `mcp__Remote_Desktop_Commander__read_file`
Read contents from files and URLs.
                        Read PDF files and extract content as markdown and images.
                        
                        Suitable for reading authorized local files directly without starting a shell command.
                        
                        Supports partial file reading with:
                        - 'offset' (start line, default: 0)
                          * Positive: Start from line N (0-based indexing)
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail lines)
                        
                        Examples:
                        - offset: 0, length: 10     → First 10 lines
                        - offset: 100, length: 5    → Lines 100-104
                        - offset: -20               → Last 20 lines  
                        - offset: -5, length: 10    → Last 5 lines (length ignored)
                        
                        Performance optimizations:
                        - Large files with negative offsets use reverse reading for efficiency
                        - Large files with deep positive offsets use byte estimation
                        - Small files use fast readline streaming
                        
                        When reading from the file system, only works within allowed directories.
                        Can fetch content from URLs when isUrl parameter is set to true
                        (URLs are always read in full regardless of offset/length).
                        
                        FORMAT HANDLING (by extension):
                        - Text: Uses offset/length for line-based pagination
                        - Excel (.xlsx, .xls, .xlsm): Returns JSON 2D array
                          * sheet: "Sheet1" (name) or "0" (index as string, 0-based)
                          * range uses FROM:TO format (e.g., "A1:D100", "C1:C1", "B2:B50")
                          * offset/length work as row pagination (optional fallback)
                        - Images (PNG, JPEG, GIF, WebP): Base64 encoded viewable content
                        - PDF: Extracts text content as markdown with page structure
                          * offset/length work as page pagination (0-based)
                          * Includes embedded images when available
                        - DOCX (.docx): Two modes depending on parameters:
                          * DEFAULT (no offset/length): Returns a text-bearing outline — shows paragraphs with text,
                            tables with cell content, styles, image refs. Skips shapes/drawings/SVG noise.
                            Each element shows its body index [0], [1], etc.
                          * WITH offset/length: Returns raw pretty-printed XML with line pagination.
                            Use this to drill into specific sections or see the actual XML for editing.
                          * Raw DOCX XML output is compatible with edit_block's XML find/replace mode using
                            XML fragments copied from the read output.
                          * Raw XML mode requires a non-zero offset (offset=1 starts from line 1).
                            offset=0 returns the outline regardless of length.
                          * Bulk transformations can be performed programmatically against the DOCX archive
                            when the task requires changes across many XML text nodes.

                        Paths refer to the selected device. Relative paths depend on that device's current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

#### `mcp__Remote_Desktop_Commander__list_directory`
Get a detailed listing of all files and directories in a specified path.
                        
                        Returns a structured directory listing without starting a shell command.
                        Results distinguish between files and directories with [FILE] and [DIR] prefixes.
                        
                        Supports recursive listing with the 'depth' parameter (default: 2):
                        - depth=1: Only direct contents of the directory
                        - depth=2: Contents plus one level of subdirectories
                        - depth=3+: Multiple levels deep
                        
                        CONTEXT OVERFLOW PROTECTION:
                        - Top-level directory shows ALL items
                        - Nested directories are limited to 100 items maximum per directory
                        - When a nested directory has more than 100 items, you'll see a warning like:
                          [WARNING] node_modules: 500 items hidden (showing first 100 of 600 total)
                        - This prevents overwhelming the context with large directories like node_modules
                        
                        Results show full relative paths from the root directory being listed.
                        Example output with depth=2:
                        [DIR] src
                        [FILE] src/index.ts
                        [DIR] src/tools
                        [FILE] src/tools/filesystem.ts
                        
                        If a directory cannot be accessed, it will show [DENIED] instead.
                        If a path does not exist, it will show [NOT_FOUND] instead.
                        Only works within allowed directories.
                        
                        Paths refer to the selected device. Relative paths depend on that device's current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

#### `mcp__Remote_Desktop_Commander__get_file_info`
Retrieve detailed metadata about a file or directory including:
                        - size
                        - creation time
                        - last modified time
                        - permissions
                        - type
                        - lineCount (for text files)
                        - lastLine (zero-indexed number of last line, for text files)
                        - appendPosition (line number for appending, for text files)
                        - sheets (for Excel files - array of {name, rowCount, colCount})

                        Only works within allowed directories.
                        
                        Paths refer to the selected device. Relative paths depend on that device's current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

#### `mcp__Remote_Desktop_Commander__start_process`
Start a terminal process on the authorized device with intelligent state detection.
                        
                        Suitable for shell commands, interactive REPL sessions, data-processing scripts,
                        programmatic file analysis, and other long-running terminal work.
                        
                        The connected device determines shell syntax and available commands. Windows devices commonly use PowerShell or CMD; macOS and Linux devices commonly use Unix shells. Use commands and paths appropriate for the selected device.
                        
                        Examples:
                        • start_process("python3 -i") → Start an interactive Python REPL
                        • start_process("node -i") → Start an interactive Node.js REPL
                        • start_process("node:local") → Run stateless Node.js code on the MCP server
                        • start_process("wc -l /path/file.csv") → Run a one-shot shell command

                        Interactive process sessions support follow-up input after they are started.
                        Long-running process sessions expose newly available output while they remain active.
                        Binary files can be processed with appropriate command-line tools or libraries available
                        in the selected process environment.

                        SMART DETECTION:
                        - Detects REPL prompts (>>>, >, $, etc.)
                        - Identifies when a process is waiting for input
                        - Recognizes process completion vs timeout
                        - Early exit prevents unnecessary waiting
                        
                        STATES DETECTED:
                        Process waiting for input (shows prompt)
                        Process finished execution
                        Process running (use read_process_output)

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_exit, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit

                        Paths refer to the selected device. Relative paths depend on that device's current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.
                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

REMOTE EXECUTION:
Remote execution waits at most 3 seconds for completion or a prompt. If the process is still running, it continues in the background and returns its PID. Larger timeout_ms values are accepted but capped at 3000ms.

#### `mcp__Remote_Desktop_Commander__read_process_output`
Read output from a running process with file-like pagination support.
                        
                        Supports partial output reading with offset and length parameters (like read_file):
                        - 'offset' (start line, default: 0)
                          * offset=0: Read NEW output since last read (default, like old behavior)
                          * Positive: Read from absolute line position
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 NEW lines since last read
                        - offset: 0                  → All new lines (respects config limit)
                        - offset: 500, length: 50    → Lines 500-549 (absolute position)
                        - offset: -20                → Last 20 lines (tail)
                        - offset: -50, length: 10    → Start 50 from end, read 10 lines
                        
                        OUTPUT PROTECTION:
                        - Uses same fileReadLineLimit as read_file (default: 1000 lines)
                        - Returns status like: [Reading 100 lines from line 0 (total: 5000 lines, 4900 remaining)]
                        - Prevents context overflow from verbose processes
                        
                        SMART FEATURES:
                        - For offset=0, waits up to timeout_ms for new output to arrive
                        - Detects REPL prompts and process completion
                        - Shows process state (waiting for input, finished, etc.)
                        
                        DETECTION STATES:
                        Process waiting for input (ready for interact_with_process)
                        Process finished execution
                        Timeout reached (may still be running)

                        This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.

REMOTE EXECUTION:
Remote execution waits at most 3 seconds for new output. If nothing new arrives, call again later. Larger timeout_ms values are accepted but capped at 3000ms.

#### `mcp__Hatchable__list_skills`
List the registry of platform skills — discrete how-to guides for one specific task each (e.g. 'gate-an-endpoint', 'add-a-cron-job', 'add-rag-search'). Each entry is a name, one-line purpose, and category. Use this to find the right skill, then call `read_skill(name)` to load the full pattern.

When in doubt about how a Hatchable feature works, **list_skills first**. The skills are the canonical, agent-tested patterns. They beat guessing or reading the verbose docs.

Filter by `query` (matches name + purpose) or `tag` (auth, data, ai, ops, etc.). Without filters, returns the full registry (~50 entries).

#### `mcp__Hatchable__read_skill`
Load the full markdown body of one skill: when to use it, the canonical code shape, common pitfalls, and how to verify it works. Skills are the platform's primary agent-facing reference — every pattern an agent might need is one of these.

Pass either the bare name (e.g. 'gate-an-endpoint') or the category-qualified path (e.g. 'auth/gate-an-endpoint'). Use `list_skills` first to discover names.

#### `mcp__Hatchable__get_project`
Get project details including slug, status, deployed functions, and the database schema (tables, columns, types).

#### `mcp__Hatchable__list_files`
List all files in a project with their paths, sizes, and hashes.

#### `mcp__Hatchable__read_file`
Read the content of a project file.

Pass offset/limit to read a range of lines — useful for large files where the whole file would blow the context window. When either is set, the response includes cat -n style line-numbered content so subsequent patch_file calls can reference exact line numbers.

#### `mcp__Hatchable__grep`
Regex content search across a project's files. Postgres-backed, scoped to one project, with glob filtering.

Three output modes:
- files_with_matches (default) — list paths containing a match
- content — matching lines with optional context and line numbers
- count — per-file match counts + total

Default head_limit is 250 to prevent context blowups on broad patterns. Use glob to narrow by path (e.g. 'api/**/*.js', 'public/**/*.html'). Regex uses Postgres syntax (~ / ~*). Invalid or catastrophic patterns error out via a 2s statement timeout — simplify the pattern if that happens.

#### `mcp__Hatchable__get_schema`
Return the database schema for the project's PostgreSQL database: tables, columns (with types), and indexes.

#### `mcp__Hatchable__view_logs`
View function execution logs with rich filtering. Each entry includes status_code, duration_ms, log_output (captured console.log), error (if any), and a derived `level` field (error/warning/info).

Filter by any combination of function_name, route, method, status_code (exact or 4xx/5xx wildcards), level, time range (since/until — ISO or relative like '1h'/'30m'/'7d'), full-text query across log_output and error, or specific request_id.

Use this to debug production issues: e.g. `level='error'` + `since='1h'` finds everything that blew up in the last hour.

#### `mcp__Hatchable__list_deployments`
List deployments for a project in reverse-chronological order. Each entry includes version, status, deployed_at, description, and summary counts (files, functions).

Use this to understand recent deploy history, identify a known-good version for rollback, or debug a regression by comparing two versions.

#### `mcp__Hatchable__dry_run_deploy`
Run every deploy-time validator against the project's current files without actually deploying. Returns `errors` (hard gates) and `warnings` (soft lints), plus a `would_deploy` summary of what would ship.

Errors catch: package.json build scripts, reserved table names in migrations, auth route collisions, usage cap breaches.

Warnings catch known runtime footguns that type-check but silently misbehave — most notably `db.query()` / `ai.generateText()` / `config.get()` calls without `await` (returning a Promise is truthy, so `if (!result)` guards pass and downstream property reads are undefined). Safer than calling deploy blindly and finding out mid-flight.

#### `mcp__Plugin_Management__get_app_permissions`
Inspect one named ChatGPT plugin's global/default and plugin-specific permission settings. Use when the user asks what the plugin may read, write, or do, whether it must ask first, or whether it inherits the default. For a missing/broad target such as my plugins, all, or Google, make no call and ask which plugin. Never pass global. Do not use for OAuth/admin scopes, install/connect/undo requests, ordinary plugin use, or npm/Chrome/code plugins.

#### `mcp__Plugin_Management__get_plugin_dependencies`
Resolve the canonical public plugins declared by one plugin's app manifest. Use only when a skill or user explicitly asks for dependency metadata. Pass a plugin ID or name@marketplace reference unchanged. Named references resolve by globally listed plugin name. This reports metadata plus current user-aware plugin status, installation policy, and installed state; it does not install or connect anything. The result separates visible canonical plugins from app entries that lack a unique canonical plugin or whose canonical plugin is unavailable to the current user.

#### `mcp__Render__list_workspaces`
List the workspaces that you have access to

#### `mcp__Render__list_services`
List all services in your Render account

#### `mcp__Render__get_service`
Get details about a specific service

#### `mcp__Render__list_deploys`
List deploys matching the provided filters. If no filters are provided, all deploys for the service are returned.

#### `mcp__Render__get_deploy`
Retrieve the details of a particular deploy for a particular service.

#### `mcp__Render__list_logs`
List logs matching the provided filters. Logs are paginated by start and end timestamps. There are more logs to fetch if hasMore is true in the response. Provide the nextStartTime and nextEndTime timestamps as the startTime and endTime query parameters to fetch the next page of logs. You can query for logs across multiple resources, but all resources must be in the same region and belong to the same owner.

#### `mcp__Render__get_metrics`
Get performance metrics for any Render resource (services, Postgres databases, key-value stores). Supports CPU usage/limits/targets, memory usage/limits/targets, service instance counts, HTTP request counts and response time metrics, bandwidth usage metrics, database active connection counts for debugging, capacity planning, and performance optimization. Returns time-series data with timestamps and values for the specified time range. HTTP metrics support filtering by host and path for more granular analysis. Limits and targets help understand resource constraints and autoscaling thresholds. Metrics may be empty if the metric is not valid for the given resource.

#### `mcp__Neon__list_organizations`
Lists the organizations the user belongs to; an organization API key gets its own organization. search filters by name or id.

#### `mcp__Neon__list_projects`
Lists the projects in an organization; search filters by name or id. To also find branches, computes, or snapshots, use search. Returns every page. Pass limit to cap how many. `org_id` is optional: organization API keys use their organization; personal API keys auto-select when unambiguous and otherwise return the IDs to choose from.

#### `mcp__Neon__describe_project`
Gets a project's settings, owner, and usage. For branches, use list_branches.

#### `mcp__Neon__list_branches`
Lists a project's branches with id (br-...), name, parent, and default flag; search finds a branch's id by name. Returns every page. Pass limit to cap how many.

#### `mcp__Neon__describe_branch`
Returns a branch summary, its database names, and a tree of one database's schemas, tables, views, indexes, sequences, and functions. Read-only: one catalog query in a READ ONLY transaction, so it changes no data; a suspended compute wakes to run it. Branch record only: get_branch; table names: get_database_tables; columns: describe_table_schema.

#### `mcp__Neon__get_database_tables`
Lists a database's tables and views outside the system schemas. For one table's columns, use describe_table_schema.

#### `mcp__Neon__describe_table_schema`
Returns a table's columns, indexes, constraints, and sizes. For every table, use get_database_tables.

#### `mcp__Neon__list_operations`
Lists a project's operations; ones older than six months may be gone. Returns every page. Pass limit to cap how many.

#### `mcp__Neon__query_logs`
Returns a branch's log records. Filters combine with AND; pass logql or structured filters, not both. Pass since or start_time, not both; default last hour, max seven days. Private beta: a branch without logs returns 404 telemetry_not_enabled. Stream labels: query_loki_logs. Returns every page. Pass limit to cap how many.

#### `mcp__Supabase__list_organizations`
Lists all organizations that the user is a member of.

#### `mcp__Supabase__list_projects`
Lists all Supabase projects for the user. Use this to help discover the project ID of the project that the user is working on.

#### `mcp__Supabase__get_project`
Gets details for a Supabase project. `status` is `ACTIVE_HEALTHY` when the project is ready for database tools; other values such as `COMING_UP`, `RESTORING`, or `INACTIVE` (paused) mean database calls will fail or time out.

#### `mcp__Supabase__list_tables`
Lists all tables in one or more schemas. By default returns a compact summary. Set verbose to true to include column details, primary keys, and foreign key constraints.

#### `mcp__Supabase__list_migrations`
Lists all migrations in the database.

#### `mcp__Supabase__query_logs`
Runs a custom read-only ClickHouse SQL query against a Supabase project's unified logs stream, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_end; other windows are rejected. If you pass only iso_timestamp_start, the end defaults to now, so for a past time range pass both timestamps. For a longer range, make one call per 24-hour slice. Do not poll this tool in a loop.

#### `mcp__Supabase__get_advisors`
Gets a list of advisory notices for the Supabase project. Use this to check for security vulnerabilities, performance improvements, or health issues. Include the remediation URL as a clickable link so that the user can reference the issue themselves. It's recommended to run this tool regularly, especially after making DDL changes to the database since it will catch things like missing RLS policies.

#### `mcp__Vercel__search_vercel_documentation`
Search Vercel's published documentation for a topic and return relevant excerpts. Covers Vercel platform features, configuration, APIs, limits, and pricing, including projects and deployments, Git integration, environments, Functions and Fluid Compute, Routing Middleware, Cron Jobs, Sandbox, caching and the CDN, AI SDK and AI Gateway, Firewall and BotID, and storage such as Blob and Edge Config. Results come from a third-party documentation index (Context7). Does not access the user's Vercel account or projects.

#### `mcp__Vercel__get_runtime_logs`
Use this when reading application output (console.log, warnings, errors) that the functions and daemons of a project wrote at runtime, as individual log records, or when counting those records with group_by. Filter by deployment, environment, level, source, request ID, time range, or full-text query. The default window is the latest 50 minutes; for a recent window, pass since like "30m" and omit until, which is only needed for historical end times. How far back logs go depends on the runtime-log retention of the plan. For wide time ranges, scope to a deploymentId or use group_by. Do not use for build failures; use the deployment build logs instead. For clustered summaries of production errors, prefer get_runtime_errors.

#### `mcp__Vercel__get_runtime_errors`
Use this when investigating production errors or finding the most frequent runtime failures in a project. Returns pre-aggregated error clusters with error names, occurrence counts, affected routes, sample messages, and first/last seen times. Use get_runtime_logs for individual log entries; use deployment build logs for build failures. For recent windows, pass since like "24h" or "7d" and omit until; until is only needed for historical end times. Max 7-day range.

#### `mcp__Vercel__get_project_trace`
Get the resolved OpenTelemetry trace for a project by trace ID or Vercel request ID. Pass traceId (32-character hex, as in a dashboard URL ending in /logs/traces/<traceId>) or requestId (from runtime logs or the x-vercel-id header). Traces are only kept for the team plan's trace retention: 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise. Internal Vercel runtime spans are removed and their children reparented; span durations are in milliseconds. Error spans include the type and stack trace of their first exception event. Returns at most 200 spans, keeping the root and error spans first; meta.omittedSpanCount reports how many were left out, and meta.partial is true when the trace exceeded the API's 10,000-span limit.

#### `mcp__Vercel__list_ai_gateway_models`
Use this when choosing a model on Vercel AI Gateway or checking what one costs. Searches the live public catalog and returns each match's ID, type, context window, output limit, model-specific pricing in USD, and capability tags, with the total number of matches and, when more remain, a nextOffset to pass as offset for the next page. Use get_ai_gateway_model for the providers that serve one model. This is reference data; it does not read the user's account, so a team's virtual models (vmc/...) are not listed.

#### `mcp__Vercel__get_ai_gateway_model`
Use this when comparing the providers that serve one Vercel AI Gateway model. Returns the model's description and, for each provider endpoint, its pricing in USD, context and output limits, supported parameters, zero-data-retention and no-training flags, uptime, latency, and throughput. Use a known creator/model ID directly; use list_ai_gateway_models only when you need to discover it. This is reference data; it does not read the user's account.

#### `mcp__Vercel__get_ai_gateway_usage`
Use this when measuring a team's Vercel AI Gateway spend, request volume, token usage, or latency. Returns totals for the chosen metrics, optionally grouped by one dimension such as model or provider, plus an hourly or daily series when granularity is set. Covers the last 7 days by default. A scoped connection fixes the team/project; otherwise, pass projectId to limit the team query to one project. Returns aggregates only, never prompts or responses; use get_ai_gateway_leaderboard for usage across all of AI Gateway.

#### `mcp__Vercel__list_projects`
List the projects of the authenticated user or the selected team. Results are paginated using limit and from. Optionally filter by name search, Git repository, connected Global Config, build settings, and other listed filters.

#### `mcp__Vercel__get_project`
Get a project's details by project ID or name.

#### `mcp__Vercel__list_deployments`
Use this when you need deployment records or recent deployment history under the authenticated user or team. Results can be filtered by project, branch, commit, environment, state, creator, or creation time. Returns deployment data; incomplete uploads have a null URL. For a live deployment card with build status and expandable logs, use open_deployments when available.

#### `mcp__Vercel__get_deployment`
Get a deployment by its ID or hostname. When withGitRepoInfo is true, the response also includes Git source details. Additional details are included when the authenticated user or team owns the deployment.

#### `mcp__Vercel__list_sessions`
List sandbox sessions in a project, optionally filtered by sandbox name. Sorted by creation time; paginated with limit (default 20, max 50) and an opaque cursor.

#### `mcp__Vercel__get_session`
Retrieves detailed information about a specific session, including its current status, resource configuration, and exposed routes.

#### `mcp__Vercel__create_observability_query`
Run a read-only Vercel observability query for a metric and owner or project scope. Supports time ranges, filters, grouping, aggregation, and result limits. Returns query results without changing project configuration.

#### `mcp__Trello__trelloReadBoard`
Read Trello boards. Supports listing boards the authenticated user is a member of, listing all boards a user can access within a specific workspace (regardless of membership), fetching a single board by ARI or URL, listing labels on a board, listing a board's custom field definitions, and listing a board's action/history.

#### `mcp__Trello__trelloReadCard`
Fetch a Trello card's full details, or list cards across a board or list to surface open work items.
Use this tool when you know the specific board, list, or card you want to inspect.
For keyword-based discovery across all boards/cards, use trelloSearch instead.
Actions:
- "get": fetch a single card by id or card URL (cardIdOrUrl required). Returns core card
  fields, labels (up to 25; truncation signalled via labelsHasMore), checklists (up to 25;
  truncation signalled via checklistsHasMore, each with up to 25 check items; truncation
  signalled via checkItemsHasMore, use trelloReadChecklist for the full list), and comments
  (up to 25; truncation signalled via commentsHasMore).
- "list_by_board": fetch all cards for a board grouped by list (boardIdOrUrl required).
  Response: { lists: [{ id, name, cards: [...] }], hasNextPage, nextCursor }.
  Each page contains up to 5 lists (configurable via limit); each list contains all its cards.
  Filter by card state: "open" (default), "archived", or "all".
  Use cursor/limit to paginate over lists (max 50 lists per page).
- "list_by_list": fetch cards in a Trello list (listId required) with cursor-based pagination.
  Use this when the user asks for cards in a list or all cards from a specific list.
  Response: { cards: [...], pageInfo: { hasNextPage, endCursor } }.
  Filter by card state: "open" (default), "archived", or "all".
  Use cursor/limit to paginate (max 50 cards per page).
- "get_comment": fetch a single comment on a card by its action ID (cardIdOrUrl and commentId required).
  For this action, cardIdOrUrl must be a Trello card ARI so the workspace is explicit for authorization.
  Response: { id, text, createdAt, lastEditedAt, creator, cardId }.
- "list_comments": list comments on a card, newest first (cardIdOrUrl required).
  Response: { comments: [{ id, text, createdAt, lastEditedAt, creator }], pageInfo: { hasNextPage, endCursor } }.
  Use cursor/limit to paginate (default 25, max 50 comments per page).
- "list_attachments": list files and links attached to a card (cardIdOrUrl required).
  Response: { attachments: [{ id, name, fileName, url, mimeType, bytes, createdAt, isUpload, isMalicious }], pageInfo: { hasNextPage, endCursor } }.
  Use cursor/limit to paginate (default 25, max 50 attachments per page).
- "list_custom_field_items": list the custom field values set on a card (cardIdOrUrl required).
  Pairs with trelloReadBoard "list_custom_fields" for the field definitions these values belong to.
  Response: { customFieldItems: [{ id, customField: { id, name, type }, value: { text, number, date, checked, optionId } }], pageInfo: { hasNextPage, endCursor } }.
  Only the value field matching the customField.type is populated (e.g. text fields set value.text). optionId references a customField option for list/dropdown fields.
  Use cursor/limit to paginate (default 25, max 50 items per page).
- "list_activity": list a card's full activity history, newest first (cardIdOrUrl required).
  Unlike "list_comments" this is unfiltered: comments, moves between lists, member add/remove,
  due-date changes, attachments and checklist item state changes all appear in one feed.
  Response: { activity: [{ id, type, displayKey, date, creator, ...typeSpecificFields }], pageInfo: { hasNextPage, endCursor } }.
  Every entry has id, type, displayKey, date and creator. Type-specific fields are present only
  for their own action type and omitted otherwise: commentText/commentLastEditedAt, listBefore/listAfter,
  member, attachment, dueDate, checkItem. Other action types appear with the common fields alone.
  Trello reuses "type" across different edits (a list move and a due-date change are both "updateCard"),
  so branch on "displayKey" or on which type-specific field is present, rather than on "type" alone.
  Same entry shape as trelloReadBoard "list_activity", minus its "card" field.
  Every entry is an action on the card you asked for; name that entity type when you report one.
  Use "list_comments" when the user only wants the discussion; use "list_activity" for
  "what happened to this card" or "who changed this and when".
  Use cursor/limit to paginate (default 25, max 50 entries per page).

Due date timezone handling: Card due dates (due.date) are stored as UTC ISO 8601 timestamps.
For "today" or date-based due-date requests, first call trelloReadMember (get_me) for prefs.timezone and interpret due dates in the user's local time.

#### `mcp__Trello__trelloReadList`
Read Trello lists. Supported actions: "list_by_board" — list the open lists on a board (id, name, position, objectId) with cursor-based pagination (limit defaults to 25, max 50); "get" — return a single list by id, including up to 25 nested cards (id, name).
- "list_activity" — page through open cards currently in a list and return each card's recent activity. Only the cards are paginated (cursor/limit, defaults to 25 cards, max 50); each card returns its 25 most recent activity entries. Use trelloReadCard to get a single card's full history.
  Every entry is an action on the card it is grouped under; name that entity type when you report one.

#### `mcp__Trello__trelloSearch`
Discover Trello boards or cards by keyword across all workspaces. Use this when the user wants to find something by name or content but does not know which board it is on. If the user already knows the board or list they want to browse, use trelloReadCard (list_by_board or list_by_list) instead — it is faster and returns richer grouped results. Supported actions: "search_boards" — search for boards by name, always include each board's `url` verbatim in the response; "search_cards" — search for cards by name/content. Both support optional workspace scoping and cursor-based pagination. Both actions return open (non-archived) results by default. To search archived items instead, include `is:archived` in the query. "search_cards" additionally supports boardIds scoping and qualifiers: label:, board:, list:, member:, due:, has:. For archived/closed cards, use `is:archived` or `is:closed` (they are equivalent for cards only). For archived boards, use `is:archived` only — boards do not support the `is:closed` alias. Due date timezone handling: Trello due-date search qualifiers use UTC boundaries. For "today" or date-based due-date queries, first call trelloReadMember (get_me) for prefs.timezone and account for the user's local timezone.

#### `mcp__Replit__list_apps`
List Replit Apps the user can edit, most recently updated first; `query` optionally filters by matching app titles, surfacing the best matches for the query first. Use this when the user wants to browse or pick from their apps, or when you need a replId but resolve_app_by_name returned found=false because the user gave an approximate name — present the returned titles and let the user choose, then pass the chosen replId to update_app_using_prompt or ask_question. This is a search/list, not the exact resolver: prefer resolve_app_by_name when the user already gave an exact app name. Results can include apps owned by or shared with the user.

#### `mcp__Replit__resolve_app_by_name`
Look up by exact name a Replit App the user can edit and return its replId (UUID) and URL. Use this when the user refers to an app by name (e.g. "update my Todo App", "what does my Recipe Tracker do?") and you don't already have a replId from create_app_from_prompt earlier in this conversation. Pass the result's replId into update_app_using_prompt or ask_question to act on the app. Matching is case-insensitive but exact: this is a name resolver, not a search. If the user gives you an approximate or partial name and this tool returns found=false, call list_apps (optionally with the partial name as the query) and let the user pick from the results rather than guessing. Results can include apps owned by or shared with the user.

#### `mcp__Replit__search_apps`
Search Replit Apps the user can edit (owned or shared with them). query is a BM25-style keyword search over app titles, best matches first; updatedAfter/updatedBefore bound the last-updated time; these combine. Prefer the default recency ordering: only set updatedAfter/updatedBefore when the user explicitly asks to filter by time, since date bounds exclude apps that would otherwise be listed. url resolves a Replit App URL directly to that app and ignores the other filters. With no filters, this returns the user's most recently updated apps. Pass a result's replId to update_app_using_prompt or ask_question to act on that app. <important>This tool is EXPERIMENTAL: prefer it for finding the user's apps, but if it errors or its results do not match what the user described, fall back to resolve_app_by_name (exact name) and list_apps (recent apps).</important>

#### `mcp__Replit__get_publish_status`
Check the publish status of the user's Replit App: whether it has ever been published, the current status of its most recent publish, and the public URL it serves. found=false means the app has never been published; call publish_app to publish it for the first time. When found, 'success' means it is live at the returned url, 'failed' means the last publish did not go through, 'suspended' means the published app is paused and not serving, and anything else means a publish or lifecycle operation is still in progress. Use this to poll every 30 seconds after calling publish_app, or whenever the user asks whether their app is published or what its live URL is. Takes the same replId as publish_app.

#### `mcp__Google_Calendar__list_events`
Returns events on the given calendar matching all specified constraints. Time constraints should not be specified unless requested by the user. For open-ended keyword or topic-based searches on the primary calendar, the search_events tool must be used instead.

#### `mcp__Google_Calendar__get_event`
Returns a single event on the given calendar.

#### `mcp__Google_Calendar__list_calendars`
Returns the calendars this user has access to (their calendar list). Use this tool to resolve calendar identifying data (for example, 'my family calendar') into its corresponding `calendar_id` (email identifier)

#### `mcp__Google_Calendar__search_events`
Searches events on the user's primary calendar using semantic search.

#### `mcp__Gmail__list_drafts`
Lists draft emails from the authenticated user's Gmail account.

This tool can filter drafts based on a query string and supports pagination. It returns a list of drafts, including their IDs and subjects (unless `view` is set to `DRAFT_VIEW_METADATA_ONLY`). `page_token` can be used to paginate the results. To retrieve subsequent pages of results, use the `page_token` returned in the previous response.

The `view` parameter controls which fields are populated in the response. By default (or with `DRAFT_VIEW_FULL`), it returns full content. Use `DRAFT_VIEW_METADATA_ONLY` to exclude sensitive content like subject and body.

#### `mcp__Gmail__get_thread`
Retrieves a specific email thread from the authenticated user's Gmail account, including a list of its messages.

The optional `messageFormat` parameter controls the format of the messages returned. By default (or with `FULL_CONTENT`), it returns the full content of messages. Use `MINIMAL` to include only subject and snippet (excluding body). Use `METADATA_ONLY` to include only basic metadata (message ID, thread ID, labels, timestamp, and size estimate).

#### `mcp__Gmail__get_message`
Retrieves a specific email message from the authenticated user's Gmail account by its unique message ID.

Use this tool to inspect a single, individual email when you already know its message ID. If the user wants to read a specific email in detail, check the exact wording of a message, or examine attachment metadata for a single email, this is the right tool. It is not suitable for retrieving entire conversations or viewing back-and-forth discussion threads; use the 'get_thread' tool instead.
This tool does not support retrieving draft messages. To view drafts, use the 'list_drafts' tool instead.
Key indicators include if the user asks for the full content of a specific message ID returned by a previous search, or if the query asks to inspect a specific individual email rather than an entire thread.
Example user prompts are: "Get the full text of message ID 18f123456789abcd.", "Read the latest message in that thread from Alice.", and "What are the attachment names in the email I just received from HR?" 

The optional `messageFormat` parameter controls the format of the message returned. By default (or with `PLAIN_TEXT`), it returns the plain text body without the HTML body. Use `FULL_CONTENT` when the HTML body is needed. Use `RAW` for raw MIME content. Use `MINIMAL` to include only subject and snippet (excluding body). Use `METADATA_ONLY` to include only basic metadata (message ID, thread ID, labels, timestamp, and size estimate).

#### `mcp__Gmail__search_threads`
Lists email threads from the authenticated user's Gmail account.

This tool can filter threads based on a query string and supports pagination. It returns a list of threads, including their IDs and related messages. Each related message contains details like a snippet of the message body, the subject, the sender, the recipients etc. The `view` parameter controls which fields are populated in the related messages. By default (or with `THREAD_VIEW_MINIMAL`), it includes subject and snippet. Use `THREAD_VIEW_METADATA_ONLY` to exclude subject and snippet. Note that the full message bodies are not returned by this tool; use the 'get_thread' tool with a thread ID to fetch the full message body if needed. Threads with excluded criteria may still appear in the results. This occurs because Gmail identifies matching messages first. For example, if you search for -is:starred, Gmail will find an entire thread if it contains at least one unstarred message, even if other emails in that same conversation are starred.

#### `mcp__Automations__get`
Read one task's saved instructions and context version by automation ID.

#### `mcp__Automations__peek`
Privately look up task automations without displaying the list to the user.

#### `mcp__Automations__list_event_sources`
List connected apps with supported automation events. Call this before discover_webhook_schema, then pass the chosen source's connector_id as connector_type. Call again after connecting or disconnecting an app.

#### `skills__list`
List available skills and their descriptions.

#### `skills__read`
Read an available skill's complete instructions or a supporting file. For listed reference files, append the exact relative path to the skill root URI and read it with this tool. PDF, DOC, DOCX, XLS, XLSX, PPT, and PPTX files bundled under skills://plugins/ return extracted text; PDF text includes source page labels and spreadsheet output may be partial. Other binary formats and binary files outside installed plugin skills are not supported. Only read skill files under skill roots available in this conversation. Only use listed skill URIs; if none exist, do not guess plugin or skill names.

#### `files__list`
List ChatGPT conversation files or browse the user's file library. Supports metadata filters for file types and dates, including the special file type 'folder' for folder-only library listings. Returns file and folder metadata only; use recursive=true for recent files across the whole library, and use files.search for ranked content retrieval. Use the Library surface for prior or persistent files, including files from previous conversations. Common Library call: {"surface":"library","recursive":true,"limit":20}. Use sort='created_at' for upload/creation time, not sort='uploaded_at'. Reuse a cursor only from a response with next_cursor, and repeat the same list request shape except for cursor; do not change surface, library_path, filters, sort, or limit while paginating.

#### `files__search`
Default first choice for broad content questions or when the relevant location is unknown; this is ranked semantic search. Use one top-level search_query array with q strings only; each item may contain q and optional search_title_only. Keep scope, filters, intent, and top_k at the top level. Do not copy legacy file_search.msearch fields such as queries, source_filter, or file_type_filter; do not use web-search fields such as recency, response_length, q2, or q3, and use at most 5 query items. Extra query items are skipped with a warning. q must be nonempty; use files.list for recent-file metadata navigation. Include at least one query equivalent to the user's core question with ambiguous references resolved; use multiple queries or quote exact phrases in double quotes when useful. Defaults to all conversation files, title-and-content search, sort='relevance', and result_format='snippets'. Omit scope only when current-conversation uploads are the intended source. For named or prior files not attached here, set scope.surfaces to ['library']; include 'conversation' too when both sources could matter. Do not force Library for public or API-policy questions, code symbols, or connector-native data when web or another available connector is the better source. Restrict specific files with scope.file_refs using file_id values returned by Files; put Library folder paths in scope.library_folders. These belong in scope, not filters. Omit filters unless narrowing by file types, dates, or generated/uploaded files. Use created_after/created_before for Library upload or creation time. For photos, use image_taken_after/image_taken_before and image_location for EXIF-derived capture time and location; location fields are exact AND constraints, so use the smallest confident constraint. Request include_image_metadata only when the user explicitly asks to see image_taken_at or image_location. Keep a nonempty semantic query even when filters carry the request; use a broad query such as 'photos' when needed. If results are not relevant or complete, refine the query or retry with a higher top_k. Common calls: conversation content {"search_query":[{"q":"quarterly revenue"}],"top_k":5}; Library content {"search_query":[{"q":"quarterly revenue"}],"scope":{"surfaces":["library"]},"top_k":5}; specific conversation file {"search_query":[{"q":"quarterly revenue"}],"scope":{"file_refs":[{"file_id":"file-123"}]}}; Library folder {"search_query":[{"q":"quarterly revenue"}],"scope":{"surfaces":["library"],"library_folders":["/Reports"]}}; photo filters {"search_query":[{"q":"photos"}],"scope":{"surfaces":["library"]},"filters":{"include_file_types":["image"],"image_taken_after":"2008-01-01T00:00:00Z","image_taken_before":"2008-12-31T23:59:59Z","image_location":{"country":"France"}}}.

For visual questions, inspect relevant images before answering. When `image()` is available, emit relevant images and citations from the result `r` in the same `functions.exec` call as retrieval:
```js
for (const result of r.results ?? []) {
  for (const part of result.image_asset_pointers ?? []) {
    if (typeof part === "string") {
      text(part);
    } else if (part?.content_type === "image_asset_pointer" && part.image_url) {
      image(part); text(part.citation_marker);
    }
  }
}
```
`text(...)` alone does not display images. If visual evidence is needed but search has no usable image, use `tools.files__read` to inspect the relevant file or pages.

#### `files__read`
Read a known file or range, or expand a relevant search/find result; do not use as the first step for broad retrieval. Pass one read item per independent file/range, at most 5 items per call. Extra items are skipped with a warning; submit them in separate calls. Supports full-file text windows, context around a visible files.search/list/find/read result, and specific page text/images via mode='pages' with include_images=true. A PDF or document that contains screenshots, scans, figures, or photos is still a PDF or document: never use mode='image_file' for it; use mode='pages' with start_page and include_images=true. Use mode='image_file' only for a standalone native image file returned by a prior Files result, to return pixels plus extracted text. Returns text-only output in every mode when include_images=false is explicit, even if image defaults are enabled. Returns citable line-numbered content and emits next_read/next_start_line/next_start_page when more unread file content remains, plus next_image_read when a separate page-image continuation is available; use its explicit include_images=true call. Common calls: expand a search result {"read":[{"ref_id":"turn1file0","mode":"chunk_context"}]}; read PDF/document pages with embedded images {"read":[{"ref_id":"turn1file0","mode":"pages","start_page":10,"end_page":12,"include_images":true}]}; inspect a standalone native image file (never a PDF/document) {"read":[{"ref_id":"turn1file0","mode":"image_file"}]}.

For visual questions, inspect relevant images before answering. When `image()` is available, emit relevant images and citations from the result `r` in the same `functions.exec` call as retrieval:
```js
for (const result of r.results ?? []) {
  for (const part of result.content ?? []) {
    if (typeof part === "string") {
      text(part);
    } else if (part?.content_type === "image_asset_pointer" && part.image_url) {
      image(part); text(part.citation_marker);
    }
  }
}
```
`text(...)` alone does not display images.

#### `files__find`
Find literal or regex text matches within a known ChatGPT conversation or file-library file. Use a ref/id visible in the conversation or returned by a prior Files result; do not invent a turnNfileM ref. Use only when you know an exact term, phrase, or heading; batch up to five likely exact variants as separate find items, or use a concise regex. The request has one top-level find array; put max_matches on each item, never at the top level, and do not send top-level response_length. Use files.search instead for broad questions, unknown locations, or uncertain wording. Returns text snippets only, not images; after finding relevant text or pages, use files.read to inspect page images. Supports line bounds and page bounds; paginate with match_offset/next_match_offset. Common call: {"find":[{"ref_id":"turn1file0","pattern":"Chapter 5"},{"ref_id":"turn1file0","pattern":"Chapter Five"}]}.

#### `user_settings__get_user_settings`
Return the user's current settings along with descriptions and allowed values. Always call this FIRST to get the set of options available before asking for clarifying information (if needed) and before changing any settings.

## 5. Provider status and permission reconciliation

| Provider/family | Skill/catalog | Action exposure | Connection/read state | Evidence / boundary |
|---|---|---|---|---|
| Native ChatGPT skills | Empty | skills list/read exposed | UNAVAILABLE-IN-RUN | `skills__list=[]` |
| GitHub | No native skill root | 89 actions | **READ-TESTED** | Repo metadata and Issue #19 succeeded |
| Dropbox | No native skill root | 39 actions | **READ-TESTED** | Exact CC-006C metadata and text succeeded |
| Linear | Agent skills empty | 93 actions | **READ-TESTED** | Authenticated workspace + exact project search; no project match |
| Remote Desktop Commander | No native skill root | 30 actions | **READ-TESTED** | Device, config, directory listing and Git state succeeded |
| Hatchable | 57 platform skills; 10 read | 34 actions | **READ-TESTED (catalog/docs only)** | No project resource read |
| Plugin Management | No skill root | 4 actions | **READ-TESTED (metadata only)** | 18 exact app-name permission lookups |
| Trello | No skill root | 15 actions | TOOL-EXPOSED | Permission metadata found; no board/card read |
| Render | No skill root | 48 actions | TOOL-EXPOSED | Permission metadata found; no resource read |
| Neon | No skill root | 141 actions | TOOL-EXPOSED | Permission metadata found; no project/database read |
| Supabase | No skill root | 36 actions | TOOL-EXPOSED | Permission metadata found; no project/database read |
| Vercel | No skill root | 260 actions | TOOL-EXPOSED | Permission metadata found; no project/deployment read |
| Replit | No skill root | 8 actions | TOOL-EXPOSED | Permission metadata found; no app read |
| Webflow | No skill root | 38 actions | TOOL-EXPOSED | Permission metadata found; no site/CMS read |
| Plugin Creator | No skill root | 9 actions | TOOL-EXPOSED | Permission metadata found; no plugin read |
| Automations | No skill root | 7 actions | TOOL-EXPOSED | Permission metadata found; no automation read |
| Todoist | No skill root | 49 actions | **UNAVAILABLE-IN-RUN** | Exact permission lookup says `not_installed`; no task read |
| Gmail | No skill root | 20 actions | **UNAVAILABLE-IN-RUN** | Exact permission lookup says `not_installed`; no email read |
| Google Calendar | No skill root | 10 actions | **UNAVAILABLE-IN-RUN** | Exact permission lookup says `not_installed`; no calendar read |
| Files utility | No provider skill | 11 actions | TOOL-EXPOSED | Not used; not provider account connector |
| User settings | No provider skill | 2 actions | TOOL-EXPOSED | Not used |

Exact app-permission lookups:
- Found / Use my default: GitHub, Dropbox, Linear, Hatchable, Vercel, Trello, Render, Neon, Supabase, Replit, Webflow, Plugin Creator, Automations, Remote Desktop Commander.
- not_installed: Desktop Commander, Todoist, Gmail, Google Calendar.
- **Do not conflate Desktop Commander and Remote Desktop Commander.** The former exact name returned not_installed; the latter was found and its separate device was online.
- `get_app_permissions` reports ChatGPT's global/default permission only; it does not inspect provider OAuth scopes or account admin scopes.

### Operation-level safety notes
- GitHub read candidates: `get_repo`, `fetch_issue`, `fetch_file`, `fetch_pr`, `get_pr_info`, `get_commit_combined_status`, workflow logs/steps/jobs, review lists, issue/PR searches. Comments, labels, assignees, reviews, branch/file updates, reruns, merge and thread resolution excluded.
- Dropbox read candidates: `get_file_metadata`, `fetch`, `list_folder`, `search`, revision list, preview. Upload/create/delete/move/share/Paper edit/comment/restore/signature actions excluded.
- Linear read candidates: `whoami`, project/issue/document/team/comment lists and gets, `list_agent_skills`, search/fetch. Save/comment/status/label/project/diff/review/share mutations excluded.
- Remote Desktop Commander: file/config/directory/process/session/usage reads. `start_process` is a generic shell executor, not intrinsically safe; only exact Git status/HEAD/upstream/diff-check commands were run. Config changes, edits, moves, directory creation, process termination, shutdown and privilege changes excluded.
- Hatchable: `list_skills`/`read_skill` used. Project/file/schema/log/deployment reads exposed but not used; SQL, function/code execution, file writes, project updates, uploads and deploy excluded.
- Render/Neon/Supabase/Vercel: list/get/log/metrics/observability reads exposed; no project mapping/read. SQL, migrations, deployment, environment secrets, credentials, key rotation, DNS/domain, rollback, billing and infrastructure changes excluded.
- Trello/Replit/Webflow: read/search/preview candidates exposed; no resource read. Board/card writes, app create/update/publish, designer/CMS mutation and generic mixed-action operations excluded.
- Todoist/Gmail/Calendar: read candidates exposed but app permission not installed; no reads/reconnect.
- Automations/Plugin Creator: exposed but unrelated resources not enumerated; create/update/run/notify/install excluded.
- Generic SQL, function execution, browser interaction, sandbox command, arbitrary shell, and ambiguous mixed-action tools are not safe merely because exposed.
- Explicit read-only exceptions to name heuristics include Vercel `create_observability_query` and Hatchable `dry_run_deploy`; neither was invoked.

## 6. Low-risk operations used
1. Native `skills__list` (empty).
2. Hatchable `list_skills` (57) and ten `read_skill` guides; Linear `list_agent_skills` (empty).
3. Plugin Management `get_app_permissions` for 18 exact names.
4. GitHub `get_repo` for `suniltnngl-gm/curl-ai-bridge` and `fetch_issue` #19.
5. Dropbox `get_file_metadata` and `fetch` for exact CC-006C ID.
6. Linear `whoami` and `list_projects(query="cURL AI Bridge", limit=10)`.
7. Remote Desktop Commander device list, identity, config, exact directory listings and reviewed Git read commands.
8. One new report artifact using exclusive-create mode and read-back verification.

## 7. Current project evidence

### GitHub
- Repository `suniltnngl-gm/curl-ai-bridge`, ID `1443769540`, private, default branch `main`.
- Issue #19 ID `6221727989`, open, updated `2026-11-18T11:51:30Z`. Its purpose is a G8/G9 tracking register and it explicitly does not authorize merge, deployment, infrastructure changes or implementation. PR/CI status in the body is dated 2026-11-05 and was not treated as current.

### Dropbox
- `/Apps/curl-ai-bridge-cloud/protocol/extensions/cc-006c-cloud-inbox-auth-v1.json`
- ID `id:opctR6uvYWcAAAAAAAAANw`; revision `6608b2b39e65980285971`; server modified `2026-11-18T11:18:22Z`; 1,776 bytes.
- Current content records event authority `coordination-only`, project manager ChatGPT, runtime parent AI_A, and worker execution authority not granted by storage/event.
- EdDSA canonical JSON signature; Ed25519 key pin must be out-of-band; auto-trust cloud-supplied key and private-key transport prohibited.
- Inbox uses bounded keyset polling and durable non-expiring local dedup claim; no remote claims or cloud deletion; invalid events retained; verification before worker handoff; no automatic inference retry.
- Rollout fields say no live assignment/poll, production key, worker dispatch, schedule integration or trusted key pin. No protocol execution occurred.

### Linear
- Authenticated workspace `aidev-tools`, ID `9e912d3a-12b6-4e53-94c7-5bcb9d85d873`.
- Exact project search returned `projects: []`, `hasNextPage: false`. This does not prove no object exists under another team/name/archive/ID; no broader search was made.

### Local Git pre-state
Paths verified by directory listing. No source files read.

| Repository | Branch | HEAD | Ahead/behind | Dirty entries |
|---|---|---|---:|---:|
| `curl-ai-bridge` | `test/ubuntu-self-hosted-runner-smoke` | `b90d2c2b0594ddc0ac517834b45a855aaee8e1cd` | 17 / 0 | 0 |
| `multi-project-workspace` | `master` | `ea96dc95b60b9c6f82dbddc3c6c7c4baf4d5aa05` | 7 / 0 | 4 |

Work-ledger porcelain:
- `M .github/workflows/ci.yml`
- `?? apps/api/test/taskBootstrapCli.test.js`
- `?? reports/`
- `?? scripts/task-bootstrap-register-current.mjs`

Both working and cached `git diff --check` emitted no diagnostics. All pre-existing dirty/untracked files were preserved. The report is a new artifact within the existing untracked `reports/` directory tree.

## 8. Reusable lessons (evidence-tagged)

### Capability discovery and permissions
- **FACT:** tool registry has 945 actions / 21 namespaces; native skill list is empty; Hatchable has 57 separate platform guides. Evidence: current registry and list calls.
- **PROPOSAL:** keep catalog presence, action exposure, ChatGPT app permission, authenticated identity, resource scope, read-tested and write-tested as separate states.
- **FACT:** global Allow low-risk actions is not provider OAuth scope. Evidence: Plugin Management action contract + returned permission metadata.
- **PROPOSAL:** default-deny generic executors and mixed-action tools; allowlist exact operation+arguments, not whole connector.

### Identity, IDs, pagination and provenance
- **FACT:** GitHub issue fetch requires exactly one repo selector; Dropbox file IDs are stable, list cursors are opaque snapshot state and scanning is complete only when `has_more=false`; Linear uses cursor pagination. Evidence: action descriptions and successful calls.
- **FACT:** Dropbox text fetch max file size is 5 MiB and fails rather than returning partial content. Evidence: Dropbox fetch contract.
- **FACT:** Hatchable keyset pagination avoids OFFSET page shifts; use composite cursor for non-unique sort. Evidence: `data/query-with-pagination`.
- **PROPOSAL:** record provider ID, query scope, cursor/snapshot semantics, timestamps and completion flag for every read.

### Auth, session and concurrency
- **FACT:** Hatchable external API connections may be project-scoped or per-user; OAuth state is single-use, 10-minute TTL, and parallel flows use independent state values. Evidence: `integrations/connect-an-external-api`.
- **FACT:** Hatchable MCP access JWT lasts 1 hour; refresh token lifetime is fixed at 30 days from grant and refresh does not extend it. Evidence: `mcp/expose-an-mcp-tool`.
- **UNKNOWN:** OpenCode/Copilot/Hermes/AGY CLI config/session sharing; no config or credential files read.
- **PROPOSAL:** separate provider account, credential owner, project connection, CLI process, invocation and session; default to session isolation.

### Model/tool loop, quota and cost
- **FACT:** Hatchable tool agents use `maxSteps`; default is one step; tool schemas/description guide selection; validate model-generated inputs and return structured outputs. Evidence: `ai/build-an-agent-with-tools`.
- **FACT:** Hatchable AI ledger rollups cache ~60s; null cost means unpriced, not free; `cost_is_complete=false` means incomplete cost evidence. Evidence: `ai/inspect-llm-call-history`.
- **PROPOSAL:** preserve exact model IDs, alias resolution, catalogue revision, invocation contract and validation result. Reject unknown IDs before dispatch where catalogue supports it.
- **UNKNOWN:** cURL AI Bridge CLI quota, free entitlement, billing lanes and cached-token behavior; no inference/quota test performed.

### Retry, timeout, recovery and terminal states
- **FACT:** Hatchable documents 30s CPU, 300s wall clock, 128MB memory, ~60s sync HTTP, ~65s cron, ~310s scheduler, outbound fetch 30s default/55s max and 5s DB statement limits. Hatchable-specific only. Evidence: `meta/platform-constraints`.
- **FACT:** Hatchable streaming guide says errors after first byte require error events; streams hold a connection/function slot and ping every 15s. Evidence: `api/stream-a-response`.
- **FACT:** Desktop Commander synchronous wait capped at 3s; long command returns PID and should be polled. Pending Remote MCP tool calls should be checked by call ID, not by retrying the original side effect. Evidence: action descriptions.
- **PROPOSAL:** distinct states: pending, running, succeeded, failed, cancelled, timed_out, skipped, unknown; retry only after idempotency and terminal state established.

### Security, provider portability and conflicts
- **FACT:** Hatchable webhook verification uses exact raw bytes, constant-time HMAC and optional timestamp replay window; provider-specific header and canonicalization remain adapter-specific. Evidence: `integrations/verify-a-webhook`.
- **FACT / UNKNOWN:** `api/access` says `user` is invalid in MCP, while `mcp/expose-an-mcp-tool` shows `user | member | admin`; unresolved documentation conflict.
- **FACT / UNKNOWN:** `api/stream-a-response` documents `Response.sse`/`res.write`; `meta/platform-constraints` says `res.write` and streaming globals do not exist; stream guide also says the front buffers until handler completion. Progressive delivery unresolved.
- **PROPOSAL:** normalize provider outcomes but preserve provider-specific auth, stream, pagination, webhook and retry semantics.

### Regression-test candidates
- Tool exposed + app not installed => resource read blocked.
- Permission metadata present but no OAuth/resource read => state remains not connected.
- No-match project search => no broad search fallback.
- Opaque cursor pagination; snapshot vs fresh-query behavior; no false completeness.
- Pending command result retrieval does not duplicate original operation.
- Model success + failed task sync => inference succeeded, orchestration incomplete.
- Unknown model ID rejected before dispatch; alias maps to exact provider-native ID.
- Missing quota/unpriced cost remains UNKNOWN, never free.
- Parallel OAuth flows use independent single-use states; expired/replayed state rejected.
- Webhook raw-byte mutation and replay-window failures rejected.
- Read-only checkpoint leaves all project records, Git state and connected systems unchanged.

## 9. cURL AI Bridge architecture implications (proposal only)

Keep distinct records/interfaces for:
1. Provider environment/configuration and credential-owner reference.
2. CLI instance (binary/version, host/device, working directory, config namespace, interactive/headless mode).
3. Invocation (exact model ID, provider-resolved ID, arguments, timeout, correlation ID, result).
4. Session/conversation (owner, backend, isolation policy, explicit sharing relation).
5. Model descriptor (provider-native ID, alias, capabilities, catalogue revision, entitlement/pricing evidence).
6. Orchestration run (task, worker, lease/fencing, retry policy, terminal state).
7. Collaboration delivery (event ID, signature/trust, expiry, inbox/outbox, dedup, delivery status).

Acceptance criteria:
- Multiple supported CLI instances can coexist without config/session collision.
- Shared session requires explicit identity and authorization; isolation is default.
- Unknown provider model identifiers rejected before dispatch when catalogue validation is supported.
- Catalog visibility never implies free entitlement or quota.
- No paid fallback from missing/stale quota.
- Inference success is independent from task synchronization and collaboration delivery.
- Read adapters preserve stable IDs, exact scope, timestamp, cursor state and provenance.
- Generic shell/SQL/function tools require operation-level allowlisting.
- No worker handoff without signature/trust pin, scope, expiry, authorization and dedup checks.

## 10. Coverage gaps and future prerequisites
- No native ChatGPT skill roots were available; catalog coverage is limited to exposed registry.
- Hatchable is the only non-empty platform skill registry discovered; no claim that every external plugin documentation source was inspected.
- No resource reads for Trello, Render, Neon, Supabase, Vercel, Replit, Webflow, Plugin Creator or Automations.
- Todoist/Gmail/Google Calendar were not installed in app permission metadata; no reconnect/elevation attempted.
- Linear project mapping unresolved.
- Hatchable MCP access and streaming conflicts need authoritative clarification.
- CLI session sharing and provider quotas remain unknown.
- Desktop Commander usage showed 12% remaining; remote inspection intentionally bounded.
- No permission denial encountered. No operator action requested. Secrets, credentials and vaults were not read.

## 11. Operations deliberately not attempted
No connected-data writes, comments/messages, issue/task/PR changes, email/calendar changes, deployments, infrastructure/database/schema changes, lease/task-ledger changes, plugin install/connect/disconnect, permission updates, account changes, Git stage/commit/push/merge/rebase/reset/clean/stash, cache reset, model invocation, inference, worker dispatch, paid usage, quota consumption, or secret reads.

## 12. Provenance and artifact
Evidence labels: **FACT** direct current output/action schema/skill text; **HISTORICAL OBSERVATION** prior-run evidence not revalidated; **INFERENCE** reasoned deduction; **PROPOSAL** recommendation not authorized; **UNKNOWN** unavailable or conflicting evidence.

Report path: `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections/plugin-capability-lessons-20261119T194914+0530.md`. Created using Python exclusive-create mode `open(..., "x")`; no existing report can be overwritten. The write process reports byte count and SHA-256; a full read-back and file metadata check follow.


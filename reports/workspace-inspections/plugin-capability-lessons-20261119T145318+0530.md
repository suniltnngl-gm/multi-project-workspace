# cURL AI Bridge — Plugin Capability Lessons

- **Run observed at:** 2026-11-19 14:53:18 +05:30
- **Task boundary:** bounded read-only capability discovery, project-scoped inspection, and one new report artifact only. No implementation or connected-system mutation.
- **Runtime:** ChatGPT tool-enabled session; `functions.exec` exposed the current tool registry. Desktop Commander device `sunilkr-H81` (`6f9a336b-2280-4e52-bcd0-0b1b3426e948`) was online, app version `0.3.4`.
- **Coverage statement:** this report covers the 685 action definitions actually exposed in this runtime and the named app-permission checks performed below. It is not a claim that every possible ChatGPT plugin is installed or that the runtime registry is complete beyond this turn.

## 1. Runtime catalog evidence

### Skill/catalog discovery

| Discovery surface | Observed result | Interpretation |
|---|---|---|
| `skills__list({})` | Empty array (`0` skill roots) | No ChatGPT skill roots were listed; therefore `skills__read` had no permitted URI to read. No skill URI was guessed. |
| `mcp__Hatchable__list_skills({})` | `57` platform skills | A separate Hatchable-native skill registry, not the general ChatGPT plugin skill catalog. |
| `mcp__Linear__list_agent_skills({})` | `agentSkills: []`, `hasNextPage: false` | No Linear agent skills listed for the authenticated workspace. |
| `ALL_TOOLS` enumeration | `685` action definitions across `20` namespaces | This is the current exposed action surface, not proof of installation, authentication, or account access. |

Nine distinct Hatchable skill entry points were read because they directly inform MCP, access control, AI invocation, tool loops, streaming, webhook verification, pagination, usage accounting, and platform constraints:

- `hatchable://platform/skills/mcp/expose-an-mcp-tool`
- `hatchable://platform/skills/api/access`
- `hatchable://platform/skills/ai/add-an-llm-endpoint`
- `hatchable://platform/skills/ai/build-an-agent-with-tools`
- `hatchable://platform/skills/ai/inspect-llm-call-history`
- `hatchable://platform/skills/api/stream-a-response`
- `hatchable://platform/skills/integrations/verify-a-webhook`
- `hatchable://platform/skills/data/query-with-pagination`
- `hatchable://platform/skills/meta/platform-constraints`

No further supporting-file list was returned by those skill reads. The remaining Hatchable registry entries were not read because they were not needed for this bounded cURL AI Bridge review.

### Exposed action inventory

The following counts are exact counts from the runtime enumeration:

| Namespace / provider | Actions | Relevant read-oriented actions exposed (exact names) |
|---|---:|---|
| Remote Desktop Commander | 30 | `list_devices`, `who_am_i`, `get_config`, `read_file`, `read_multiple_files`, `list_directory`, `start_search`, `get_more_search_results`, `list_searches`, `get_file_info`, `list_sessions`, `list_processes`, `get_usage_stats`, `get_recent_tool_calls`, `get_tool_result`, `list_remote_tool_calls` |
| GitHub | 89 | `get_repo`, `fetch_issue`, `fetch_pr`, `fetch_file`, `fetch_blob`, `fetch_commit`, `get_commit_combined_status`, `get_pr_info`, `get_pr_diff`, `list_pull_request_reviews`, `list_pull_request_review_threads`, `search_issues`, `search_prs`, `search_commits`, `compare_commits` |
| Dropbox | 39 | `who_am_i`, `search`, `list_folder`, `fetch`, `file_preview`, `get_file_metadata`, `list_file_revisions`, `list_restore_events`, `list_shared_links`, `paper_read_document`, `paper_get_doc_history`, `paper_list_recent_docs`, `check_job_status` |
| Linear | 93 | `whoami`, `list_projects`, `get_project`, `get_issue`, `list_issues`, `list_comments`, `list_documents`, `get_document`, `list_cycles`, `list_teams`, `get_team`, `search`, `fetch`, `list_agent_skills`, `get_agent_context` |
| Todoist | 49 | `find_projects`, `find_tasks`, `find_tasks_by_date`, `find_completed_tasks`, `find_sections`, `find_comments`, `find_labels`, `find_activity`, `get_project_health`, `get_overview`, `fetch_object`, `search`, `fetch`, `list_workspaces`, `get_user_status` |
| Trello | 15 | `trelloReadBoard`, `trelloReadCard`, `trelloReadChecklist`, `trelloReadInbox`, `trelloReadList`, `trelloReadMember`, `trelloReadPlanner`, `trelloReadWorkspace`, `trelloSearch` |
| Render | 48 | `list_workspaces`, `list_services`, `get_service`, `list_deploys`, `get_deploy`, `list_logs`, `get_metrics`, `list_events`, `get_postgres`, `get_blueprint`, `get_workflow`, `list_workflows`, `get_workflow_run`, `list_workflow_runs` |
| Neon | 141 | `list_organizations`, `list_projects`, `describe_project`, `list_operations`, `get_operation`, `get_project_consumption`, `get_branch_consumption`, `list_branches`, `get_branch`, `get_default_branch`, `compare_database_schema`, `get_database_tables`, `describe_table_schema`, `query_logs`, `query_loki_logs`, `inspect_database` |
| Supabase | 36 | `search_docs`, `list_organizations`, `get_organization`, `list_projects`, `get_project`, `get_cost`, `list_tables`, `list_extensions`, `list_migrations`, `query_logs`, `get_advisors`, `get_project_url`, `list_edge_functions`, `get_edge_function`, `list_branches` |
| Gmail | 20 | `list_drafts`, `get_thread`, `get_message`, `search_threads`, `list_labels`, `get_profile` |
| Google Calendar | 10 | `list_events`, `get_event`, `list_calendars`, `suggest_time`, `search_events`, `get_profile` |
| Replit | 8 | `list_apps`, `resolve_app_by_name`, `search_apps`, `get_publish_status` |
| Webflow | 38 | `data_sites_tool`, `data_pages_tool`, `data_assets_tool`, `data_agent_instructions_tool`, `get_asset_preview`, `webflow_guide_tool`, `webflow_home`; several `data_*` tools are multi-action surfaces and need per-action schema inspection before use |
| Hatchable | 34 | `list_projects`, `get_project`, `list_agent_tasks`, `read_file`, `grep`, `list_files`, `get_schema`, `view_logs`, `list_deployments`, `get_deployment`, `list_functions`, `list_skills`, `read_skill`, `search_documentation`, `dry_run_deploy` |
| Plugin Creator | 9 | `list_owned_personal_plugins`, `get_plugin_metadata`, `get_plugin_files`, `get_owned_plugin_archive`, `get_plugin_sharing`, `list_plugin_releases` |
| Plugin Management | 4 | `get_app_permissions`, `get_plugin_dependencies` |
| Automations | 7 | `get`, `list_event_sources`, `peek` |
| ChatGPT Files host surface | 11 | `search`, `list`, `read`, `find` |
| ChatGPT Skills host surface | 2 | `skills__list`, `skills__read` |
| User Settings host surface | 2 | `user_settings__get_user_settings` |

**Important classification:** action names above are discovery metadata. Some listed tools are multi-action or dual-use. A read-looking namespace does not make every action safe; the exact operation parameter and schema must be inspected before use.

## 1.1 Action descriptions and excluded side-effect surfaces

Descriptions below are concise summaries of the current tool metadata. The exact action identifiers are preserved; full schemas remain authoritative at invocation time.

- **Remote Desktop Commander**
  - `list_devices` — lists authorized devices, online/offline state, IDs, and app versions.
  - `who_am_i` — returns authenticated identity and monthly remote-call usage.
  - `list_directory` — lists files/directories on a selected device with bounded depth.
  - `read_file` / `read_multiple_files` — reads local file content, with line-range support for `read_file`.
  - `get_file_info` — reads file/directory metadata such as size, timestamps, permissions, and line count.
  - `start_process` — starts a terminal command; this is a general execution primitive, not inherently read-only.
  - Excluded: `write_file`, `write_pdf`, `create_directory`, `move_file`, `edit_block`, `set_config_value`, `shutdown`, `kill_process`, `force_terminate`. `start_process` was used only with a bounded read-only command.
- **GitHub**
  - `get_repo` — retrieves repository metadata and repository permission fields.
  - `fetch_issue` — fetches one issue selected by repository plus issue number.
  - `fetch_pr` — fetches pull-request metadata and diff, optionally comments.
  - `get_commit_combined_status` — retrieves combined CI status and individual commit checks.
  - `list_pull_request_reviews` — lists review submissions.
  - `search_issues` — searches a selected repository or, if unfiltered, all repositories visible to the linked account; this run used exact repository selectors rather than broad search.
  - Excluded: `create_issue`, `add_comment_to_issue`, `update_issue`, `create_file`, `update_file`, `delete_file`, `create_branch`, `update_ref`, `merge_pull_request`, `rerun_workflow_job`, review-thread mutations.
- **Dropbox**
  - `search` — searches files/folders by name or content with filters, result limits, and opaque pagination cursor.
  - `list_folder` — lists folder children or descendants; cursor pagination is snapshot-based.
  - `fetch` — extracts full text by exact Dropbox file ID or path; extraction failure is an error rather than partial success.
  - `get_file_metadata` — retrieves file/folder metadata, sharing details, and permissions.
  - `paper_read_document` — reads a Paper document and returns canonical identity/revision/content details.
  - Excluded: `upload_file`, `move`, `delete`, `create_folder`, `create_shared_link`, Paper edits/comments, restore operations, and signature-request creation/sending.
- **Linear**
  - `whoami` — retrieves authenticated user, connected workspace, and connection route.
  - `list_projects` — lists/searches projects with filters and cursor pagination.
  - `get_project` / `get_issue` — fetches one identified project or issue.
  - `list_issues` — lists issues with structured filters.
  - `search` — full-text search across issues, projects, initiatives, and documents.
  - `list_agent_skills` — lists available Linear agent skills.
  - Excluded: `save_issue`, `save_project`, `save_comment`, `delete_comment`, `share_issue`, diff-comment/review mutations, and `merge_diff`.
- **Todoist**
  - `find_projects` — lists or name-searches joined projects; name search returns matching projects without pagination.
  - `find_tasks` — finds active tasks by text/project/section/assignee/filter; default scope is unassigned plus mine.
  - `fetch` / `fetch_object` — fetches a task or project by typed ID.
  - `search` — searches tasks and projects and returns IDs/titles/URLs.
  - Excluded: `add_tasks`, `complete_tasks`, `update_tasks`, `reschedule_tasks`, `delete_object`, comments/reminders/label writes, project and assignment changes.
- **Trello**
  - `trelloReadBoard` — lists or fetches boards and board metadata/history.
  - `trelloReadCard` — fetches a card or lists cards within a known board/list.
  - `trelloSearch` — searches boards/cards across workspaces; broad search was deliberately not used.
  - Excluded: all `trelloWrite*` actions.
- **Render**
  - `list_workspaces` / `list_services` — lists accessible workspaces/services.
  - `list_deploys` — lists deploys for a service.
  - `list_logs` — queries time-bounded, paginated logs.
  - `get_metrics` — retrieves resource time-series metrics.
  - Excluded: service/database creation, blueprint writes/approval, `trigger_deploy`, `run_cron_job`, environment-variable updates, workflow creation/update/cancellation.
- **Neon**
  - `list_projects` / `describe_project` — lists projects and reads project settings/owner/usage.
  - `list_operations` / `get_operation` — reads project operation records.
  - `get_project_consumption` — reads project consumption; documented as plan-dependent.
  - `get_database_tables` / `describe_table_schema` — reads database tables and one table's columns.
  - `query_logs` — reads branch logs with a maximum seven-day window; telemetry may be unavailable.
  - Excluded: `run_sql`, `run_sql_transaction`, project/branch/database/role/endpoint creation or mutation, restore/reset, credential creation/rotation/revocation, connection-string retrieval, and secret/auth changes.
- **Supabase**
  - `list_organizations` / `list_projects` — lists accessible organizations/projects.
  - `get_project` — reads project details and readiness status.
  - `list_tables` — reads table/schema metadata.
  - `query_logs` — documented read-only ClickHouse query against project logs.
  - `get_advisors` — reads database/security advisor findings.
  - Excluded: `execute_sql`, `apply_migration`, project pause/restore/create, branch mutation, function deployment, and other writes.
- **Gmail**
  - `search_threads` — searches email threads with pagination and configurable metadata/full-content view.
  - `get_thread` / `get_message` — reads a known thread/message; full-content mode may expose message bodies.
  - `list_drafts` — lists drafts and supports metadata-only mode.
  - `get_profile` — resolves account identity.
  - Excluded: `create_draft`, `update_draft`, `send_message`, `reply`, `forward`, label changes/creation/deletion. No personal email read was attempted.
- **Google Calendar**
  - `list_events` — lists events matching explicit calendar/time constraints.
  - `search_events` — semantically searches the primary calendar.
  - `get_event` / `list_calendars` — reads a known event or calendar list.
  - Excluded: `create_event`, `update_event`, `delete_event`, `respond_to_event`. No personal calendar read was attempted.
- **Replit**
  - `list_apps` — lists apps the user can edit.
  - `resolve_app_by_name` — resolves an exact app name to a stable ID/URL.
  - `search_apps` — searches owned/shared apps.
  - `get_publish_status` — reads the most recent publish status.
  - Excluded: `create_app_from_prompt`, `update_app_using_prompt`, `publish_app`.
- **Webflow**
  - `data_sites_tool` — multi-action site listing/details/publishing surface.
  - `data_agent_instructions_tool` — multi-action search/read/create/update/delete/move/generate surface for instructions.
  - `get_asset_preview` — reads an image preview for a known asset ID.
  - Excluded: designer/site/CMS/asset writes and publish actions. Multi-action tools must be classified by the requested sub-action, not by the tool name.
- **Hatchable**
  - `list_projects` / `get_project` — lists projects and reads project details.
  - `read_file` / `list_files` — reads a known project's files and file metadata.
  - `view_logs` / `get_schema` — reads logs and database schema.
  - `list_skills` / `read_skill` — lists and reads platform-native how-to guides.
  - `dry_run_deploy` — documented as a dry-run validation surface; not used in this run.
  - Excluded: `deploy`, `write_file`, `write_files`, `patch_file`, `delete_file`, `execute_sql`, `run_function`, uploads, and project changes.
- **Plugin Creator**
  - `list_owned_personal_plugins` — lists owned personal plugins.
  - `get_plugin_metadata`, `get_plugin_files`, `get_owned_plugin_archive`, `list_plugin_releases`, `get_plugin_sharing` — reads metadata, files/archive, release history, and sharing state for an identified plugin.
  - Excluded: `create_plugin`, `update_plugin`, `share_plugin`. No unrelated personal plugin inventory was read.
- **Plugin Management**
  - `get_app_permissions` — reads one named app's global/default and app-specific permission settings.
  - `get_plugin_dependencies` — resolves one plugin's declared canonical dependencies and current user-aware installation state.
  - Excluded: `update_app_permissions`, `uninstall_app`.
- **Automations**
  - `get` — reads one automation's saved instructions/context version.
  - `list_event_sources` — lists connected apps that expose automation events.
  - `peek` — privately looks up automations.
  - Excluded: `create`, `update`, `run_now`, and `notify_parent`.
- **ChatGPT host surfaces**
  - `files__search`, `files__list`, `files__read`, `files__find` — search/list/read/find conversation or Library files.
  - `skills__list`, `skills__read` — list/read available ChatGPT skills; no skill roots were returned.
  - `user_settings__get_user_settings` — reads ChatGPT appearance/personality settings.
  - Excluded: Library mutation/share operations, reference-image create/update/delete, and `user_settings__set_setting`.

## 2. Connection, permission, and read-test reconciliation

The plugin permission inspector reported the global ChatGPT app policy as **“Allow low-risk actions”**. For installed app names it reported **“Use my default”**. This setting is not OAuth scope evidence and does not prove that an account is connected. The inspector's own description says it is not an OAuth/admin-scope inspection tool.

| Family | Current state | Connection/read evidence | Scope and permission notes |
|---|---|---|---|
| GitHub | **READ-TESTED** | `get_repo` and `fetch_issue` succeeded for `suniltnngl-gm/curl-ai-bridge`, issue `#19`. Repository is private. The repository response reported current account permissions `admin`, `maintain`, `pull`, `push`, and `triage`. | Project-scoped read only. App setting inherits global low-risk policy. The broad repository permission response does not authorize any write in this task. |
| Dropbox | **READ-TESTED** | `search` found one `CC-006C` record and `fetch` read it successfully. | Exact file ID and returned namespace path were reused. Search was capped at 5 results. No broad root traversal. App setting inherits global low-risk policy. |
| Linear | **READ-TESTED** | `whoami` succeeded; `list_projects` query `cURL AI Bridge` returned zero projects and `hasNextPage:false`; `list_agent_skills` returned zero. | Connected workspace was `aidev-tools`; no matching project surfaced from this bounded name query. App setting inherits global low-risk policy. |
| Remote Desktop Commander | **READ-TESTED** | Device listing showed `sunilkr-H81` online. `who_am_i` succeeded. A bounded process completed read-only Git status checks for both configured repository paths. | Device connector works. The separate permission lookup for app name “Desktop Commander” returned `not_installed`; this name/namespace mismatch is not reconciled and must not override the successful Remote Desktop Commander evidence. Tool usage response showed **12% remote calls remaining** at identity check. |
| Hatchable | **READ-TESTED — skill registry only** | `list_skills` returned 57 platform skills; nine relevant skill documents were read. | This confirms access to the platform skill registry, not to any cURL AI Bridge Hatchable project. App setting inherits global low-risk policy. |
| Plugin Management | **READ-TESTED — permission metadata only** | `get_app_permissions` succeeded for 16 named app IDs. | Metadata inspection only; not OAuth/admin scopes and not a connected-data read. `get_plugin_dependencies` was not called. |
| Trello | **TOOL-EXPOSED** | Read/write actions are exposed; no board/card read was attempted. | App setting inherits global low-risk policy. No known cURL AI Bridge board ID was available, so no workspace-wide search was run. |
| Render | **TOOL-EXPOSED** | Read/list/log/metric actions are exposed; no project/service discovery was run. | App setting inherits global low-risk policy. No verified cURL AI Bridge service ID; broad account listing was avoided. |
| Neon | **TOOL-EXPOSED** | Project/schema/branch/log/consumption reads are exposed; no project read was attempted. | App setting inherits global low-risk policy. No verified project ID. Consumption API documentation notes plan-dependent access and possible `403`; log queries can return `404` where telemetry is not enabled. |
| Supabase | **TOOL-EXPOSED** | Organization/project/schema/log/advisor reads are exposed; no account-wide project listing was run. | App setting inherits global low-risk policy. No verified cURL AI Bridge project ID. `query_logs` is documented as a read-only ClickHouse query; `execute_sql` and migrations were excluded. |
| Replit | **TOOL-EXPOSED** | App list/search/status reads are exposed; no personal app inventory was read. | App setting inherits global low-risk policy. No exact project/app ID; no broad personal app search. |
| Webflow | **TOOL-EXPOSED** | Site/CMS/pages/assets/instructions tools are exposed; none was invoked. | App setting inherits global low-risk policy. Multi-action `data_*` tools can mix reads and writes; inspect operation and schema first. |
| Plugin Creator | **TOOL-EXPOSED** | Plugin metadata/archive/release reads are exposed; no owned-plugin inventory was read. | App setting inherits global low-risk policy. No exact cURL AI Bridge plugin ID; unrelated personal plugin inventory was avoided. |
| Automations | **TOOL-EXPOSED** | `get`, `list_event_sources`, and `peek` are exposed; no automation was read or run. | App setting inherits global low-risk policy. `run_now`, create/update, and notifications were not attempted. |
| Todoist | **UNAVAILABLE-IN-RUN for account access; tools still exposed** | Permission inspector returned `status:not_installed`; no task/project call was made. | Do not infer current connection from the exposed 49 action definitions or historical observations. |
| Gmail | **UNAVAILABLE-IN-RUN for account access; tools still exposed** | Permission inspector returned `status:not_installed`; no email content was read. | Personal-content scope deliberately excluded. |
| Google Calendar | **UNAVAILABLE-IN-RUN for account access; tools still exposed** | Permission inspector returned `status:not_installed`; no calendar content was read. | Personal-content scope deliberately excluded. |

For Replit, Webflow, Hatchable, Plugin Creator, Automations, Trello, Render, Neon, and Supabase, the permission inspector found the named app and its inherited low-risk setting, but no authenticated project-specific read was performed. Their state is therefore **TOOL-EXPOSED**, not CONNECTED or READ-TESTED.

## 3. Project evidence read this run

### GitHub

- Repository: `suniltnngl-gm/curl-ai-bridge`; private; default branch `main`.
- `get_repo` succeeded.
- Issue `#19` — “Track remaining G8/G9 work, review gates, and roadmap dependencies” — is open; last updated `2026-11-18T11:51:30Z`.
- Issue body explicitly says it is a tracking register and does not authorize merge, deployment, infrastructure changes, or implementation of captured ideas. It records future G9 work as candidates, not authorization. Separately, the Dropbox `CC-006C` protocol record identifies ChatGPT as `project_manager`.

### Dropbox

- Search result: `CC-006C`, Dropbox file ID `id:opctR6uvYWcAAAAAAAAANw`.
- Returned path: `/Apps/curl-ai-bridge-cloud/protocol/extensions/cc-006c-cloud-inbox-auth-v1.json`.
- Server modified: `2026-11-18T11:18:22Z`.
- Read content records `event_authority: coordination-only`, `project_manager: ChatGPT`, `runtime_parent: AI_A`, and `worker_execution_authority: not-granted-by-storage-or-event`.
- It specifies EdDSA/Ed25519 verification, an out-of-band SHA-256 public-key fingerprint pin, bounded keyset polling, durable non-expiring local deduplication claims, verification before worker handoff, no automatic inference retries, no cloud-object deletion, and retention of invalid events as cloud evidence.
- Its rollout fields say no live inbox poll, production signing key, trusted key pin, live assignment, or remote worker dispatch had been performed; schedule integration was not authorized.
- **Metadata drift remains visible:** the GitHub roadmap register identifies ChatGPT as project manager, while this protocol record still names `AI_A` as `runtime_parent`. This is a reconciliation issue, not an authority transfer. Do not rewrite the protocol record in place.

### Linear

- `whoami` succeeded for workspace `aidev-tools`.
- The bounded project-name query returned no cURL AI Bridge project. This is not proof that no related object exists under a different name or workspace.

### Local repositories

Before any repository content read, the following identity/status checks were run. No source files were opened.

| Verified path | Branch | HEAD | Upstream | Behind / ahead | Dirty entries | `git diff --check` / cached check |
|---|---|---|---|---|---:|---|
| `/home/sunilkr/Code/curl-ai-bridge` | `test/ubuntu-self-hosted-runner-smoke` | `1ea0049d8354` | `origin/test/ubuntu-self-hosted-runner-smoke` | 0 / 2 | 56 | No output/errors |
| `/home/sunilkr/Code/multi-project-workspace` | `master` | `e28afe7eca1a` | `origin/master` | 0 / 6 | 5 | No output/errors |

The established report directory `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections/` exists. Dirty and untracked content was not enumerated or changed.

## 4. Read/write/elevated boundaries and limits

### Operations used

- Current tool and skill catalog enumeration.
- Read-only app permission metadata for 16 named app IDs.
- Desktop Commander device/identity reads.
- Bounded read-only Git status, branch, HEAD, upstream, ahead/behind, and whitespace checks on the two verified repositories.
- GitHub repository metadata and issue `#19`.
- Dropbox search and fetch of the exact `CC-006C` file.
- Linear identity, bounded project-name lookup, and agent-skill listing.
- Hatchable platform-skill listing and reads of nine relevant skill documents.

### Operations deliberately not attempted

No issue/PR/task/comment/message/email/calendar changes; no file or database writes outside this one report; no deployment, migration, schema change, workflow dispatch, worker dispatch, model invocation, inference, quota consumption, or paid fallback; no OAuth/connect/reconnect, permission change, elevation prompt, cache reset, credential read, environment-secret read, or account/subscription change. No Git stage/commit/push/merge/rebase/reset/clean/stash/fetch. No Dropbox upload/move/delete/share, Linear save/comment/merge, Todoist/Trello mutation, Render deployment, Neon/Supabase SQL write, or Webflow/Hatchable/Replit project mutation.

### Known documented limits and failure behavior

- **Remote Desktop Commander:** `start_process` is a general command-execution surface, not intrinsically read-only. Its tool description says it waits at most 3 seconds and returns a PID if work continues. This run used only a bounded read-only command. Identity metadata showed 12% remote calls remaining; no further workspace inspection was attempted.
- **Dropbox:** search supports bounded result counts and opaque cursors; `list_folder` supports cursor pagination and snapshot-style results, with a maximum page size of 600. `fetch` has a 5 MiB extraction limit and returns an error rather than partial success if extraction fails. Use returned file IDs/namespace paths unchanged.
- **Linear:** project listing supports cursor pagination and a maximum 50 results per call; the current query had no next page.
- **GitHub:** repository/issue reads succeeded; API rate limits and retry behavior were not established by this run.
- **Neon:** documented project consumption is plan-dependent and may return `403`; log query availability may return `404` when telemetry is not enabled. No project query was attempted.
- **Hatchable MCP:** its skill documents one-hour access JWTs, a 30-day refresh-token window fixed from grant time, project-specific JWT audience, role-filtered tool listing, and revocation invalidating access and refresh tokens. These are Hatchable-specific claims, not cURL AI Bridge protocol guarantees.
- **Hatchable AI:** skill docs describe provider-family aliases (`haiku`, `sonnet`, `opus`, `gpt`, `gpt-mini`, `gemini`, `gemini-flash`, `gemini-pro`), account-level provider-key setup, `setup_required` responses, a default $10/day project spend cap (`ai_spend_limit_reached` until midnight UTC), `finishReason` handling, and a roughly 60-second usage-rollup cache. A null cost is explicitly “unpriced”, not free. These are platform-specific.
- **Hatchable agent loop:** `maxSteps` bounds tool loops; each step is another model invocation. Tool execution errors can be returned to the model, which may choose another path. `ai.streamText` is documented as one model round without automatic tool execution; `generateText` with `execute` and `maxSteps` performs the loop.
- **Hatchable pagination:** the skill recommends keyset cursors, `LIMIT N+1`, unique tie-breakers for non-unique sort keys, and independent authorization filters; cursors are not authorization tokens.
- **Hatchable webhook verification:** the skill documents verification against exact raw request bytes, constant-time comparison, optional signed timestamps/replay window, and explicit failure on missing raw bytes.
- **Hatchable documentation conflicts:** `api/stream-a-response` and `ai/add-an-llm-endpoint` describe streaming/SSE and a buffered-until-handler-finish edge behavior; `meta/platform-constraints` says streaming/SSE handlers cannot be built and that the response is fully buffered. Also, `api/access` says the `user` tier is invalid in `mcp/*.js`, while `mcp/expose-an-mcp-tool` describes user-mode MCP grants and lists `user` as an access value. These same-registry documents conflict. Do not choose one as authoritative or transfer either contract without a versioned platform clarification and runtime evidence.
- **Unknown across untested providers:** connector-specific rate limits, API quotas, retries, timeout/cancellation semantics, account scopes, and failure contracts remain unknown unless stated above. Tool exposure is not proof of those properties.

## 5. Reusable lessons

Each item is tagged and tied to evidence observed above or the named platform skill.

1. **FACT — separate catalog, action exposure, installation, authentication, and successful read.** `skills__list` was empty; `ALL_TOOLS` exposed 685 definitions; the app-permission inspector reported four named apps not installed even though their tool definitions were present; GitHub, Dropbox, Linear, and Remote Desktop Commander reads succeeded. Evidence: runtime catalog, `get_app_permissions`, `get_repo`, `fetch_issue`, Dropbox `search`/`fetch`, Linear `whoami`, Desktop Commander `list_devices`.
2. **PROPOSAL — represent these as independent adapter states:** `catalog_present`, `tool_exposed`, `app_installed`, `authenticated`, `read_scope_verified`, `write_scope_verified`, and `last_verified_at`. Do not collapse them into one `connected` boolean.
3. **FACT — permission policy and provider account permissions are different layers.** ChatGPT app settings said “Allow low-risk actions”; GitHub's repository response separately reported broad repository permissions. Neither changes this task's action allowlist. Evidence: app permission metadata and GitHub `get_repo`.
4. **PROPOSAL — classify every operation, not every connector.** Use `READ`, `WRITE`, `DESTRUCTIVE`, `EXTERNAL_SIDE_EFFECT`, `SECRET_ACCESS`, `EXECUTION`, and `ELEVATED` labels. Default-deny unknown and multi-action operations. Require an explicit dry-run contract before treating validation as non-mutating.
5. **FACT — stable IDs and returned cursors matter.** GitHub issue reads are repository-plus-number scoped; Dropbox returned a stable file ID and namespace path; Linear exposes cursors; Dropbox folder pagination is snapshot-style; Hatchable recommends keyset cursors with unique tie-breakers. Evidence: tool descriptions, exact Dropbox search/fetch result, Linear list-projects schema, `data/query-with-pagination`.
6. **PROPOSAL — adapter requests should carry canonical provider/project/resource IDs, opaque cursor, bounded page size, query filter, and provenance.** Never continue pagination with a cursor from another query or silently switch to a fresh snapshot.
7. **FACT — provider-native skill instructions can be more specific than generic tool metadata.** Hatchable's registry returned 57 entries and its MCP skill describes role checks, OAuth grants, project-specific audience, and revocation. Linear's agent-skill registry returned none. Evidence: Hatchable `list_skills`/`read_skill`; Linear `list_agent_skills`.
8. **FACT — provider-neutral function tools and provider-native tools have different portability.** Hatchable documents a common function-tool schema translated to provider-specific formats, while native search/computer/code tools pass through and bind a handler to a specific provider. Evidence: `ai/build-an-agent-with-tools`.
9. **PROPOSAL — keep a portable tool contract plus explicit provider-native extensions.** Record portability class (`portable`, `provider_extension`, `unknown`) and never disguise a provider-specific feature as universal.
10. **FACT — model aliases are not the same as immutable model IDs.** Hatchable maps family aliases centrally and warns that dated snapshots can deprecate; it also documents account-level provider keys and project-level app secrets as distinct configuration planes. Evidence: `ai/add-an-llm-endpoint`.
11. **PROPOSAL — persist both requested alias and resolved provider/model ID, with provider catalog version and validation timestamp.** Reject unsupported explicit IDs before dispatch when the provider exposes a trustworthy catalogue; preserve exact IDs when reproducibility requires pinning.
12. **FACT — quota, cost, and catalogue visibility are separate.** Hatchable documents account/provider key selection, platform credit exhaustion, a per-project daily spend cap, unpriced calls, and delayed usage rollups. Evidence: `ai/add-an-llm-endpoint`, `ai/inspect-llm-call-history`.
13. **PROPOSAL — model account lane, billing lane, credential owner, and quota bucket separately.** Treat missing quota as `UNKNOWN`, stale as `STALE`, conflicting as `CONFLICTED`, and null price as `UNPRICED`; none means free or dispatchable.
14. **FACT — tool-loop bounds and inference retries are not interchangeable.** `maxSteps` caps model/tool orchestration; each step is another model invocation; errors may be surfaced back to the model; streaming is documented as a single round. Evidence: `ai/build-an-agent-with-tools`.
15. **PROPOSAL — record each invocation, tool step, orchestration task, and synchronization event separately.** A successful model response must not automatically complete a task; a task-sync failure must not rewrite the inference result.
16. **FACT — stream termination can be distinct from HTTP status.** Hatchable's streaming skill documents backpressure, disconnect exceptions, keepalive events, and errors after the first byte; the platform-constraints document conflicts with this. Evidence: `api/stream-a-response`, `meta/platform-constraints`.
17. **PROPOSAL — define explicit terminal states for completed, truncated, refused, timed out, cancelled, disconnected, tool-failed, and synchronization-pending outcomes.** Do not retry ambiguous post-send failures without idempotency evidence.
18. **FACT — webhook verification must bind to the exact signed bytes and replay window.** Evidence: `integrations/verify-a-webhook`.
19. **PROPOSAL — cURL AI Bridge ingress should bind signature, raw payload digest, timestamp/expiry, sender identity, event ID, and deduplication claim before dispatch.** Keep verification separate from authorization to execute.
20. **FACT — tool descriptions are part of the agent's decision surface.** Hatchable requires a name, description, and statically extractable input schema; it validates filename/name correspondence and returns structured tool errors. Evidence: `mcp/expose-an-mcp-tool`.
21. **PROPOSAL — test schemas, names, argument validation, response envelopes, and error mapping as compatibility contracts.** Do not rely on the model to obey a schema without server-side validation.
22. **FACT — session/config sharing was not established for the local CLIs in this run.** No OpenCode, Copilot, Hermes, or AGY CLI session/config read or inference test was performed. Hatchable's project-scoped MCP token audience is not evidence about local CLI session sharing.
23. **PROPOSAL — isolate provider environment, CLI installation/instance, invocation, session/conversation, model selection, and account/quota lane.** Shared sessions/configuration must be an explicit opt-in supported by per-CLI tests, never an inferred default.

## 6. cURL AI Bridge architecture implications

- Keep provider configuration and credential custody separate from CLI installation/instance identity.
- Model each CLI instance independently; allow concurrent interactive/headless instances only after that CLI's process, configuration, and session-sharing semantics are verified.
- Default to isolated sessions/conversations. Shared session state must be explicit, scoped, and auditable.
- Keep model family aliases separate from exact provider model IDs. Record alias resolution and catalogue evidence; validate exact IDs before dispatch when the provider supports it.
- Keep provider identity, credential owner, account lane, quota bucket, billing mode, and usage/cost evidence distinct.
- Define invocation records with stable request ID, provider, CLI instance, model ID, profile/config revision, session ID, timeout/cancellation, tool-call trace, finish reason, usage, cost status, and normalized error class.
- Keep inference result, task lifecycle, collaboration/outbox delivery, and worker-dispatch authorization as independent state machines.
- Treat tool-loop step caps as orchestration bounds, not retry budgets. Keep retries explicit, bounded, idempotent, and failure-class-aware.
- Keep provider-native tools as opt-in extensions with provider-specific schema/response adapters.
- Maintain explicit unknown/unavailable/not-installed/permission-denied states. Do not infer entitlement or spendability from a visible model catalogue.
- Preserve the project rule that storage/event possession does not grant worker execution authority; CC-006C explicitly records coordination-only authority and no worker execution grant.

## 7. Regression-test candidates (proposal only)

1. Empty ChatGPT skill catalog while provider-native skill catalogs exist; ensure the registry reports separate sources.
2. Tool definition exposed while app reports `not_installed`; ensure no implicit connection or invocation.
3. App permission “Allow low-risk” with a write/destructive action; ensure operation-level policy still blocks it.
4. Exact project/resource scoping and stable-ID resolution; reject ambiguous display-name-only references.
5. Cursor pagination across changing snapshots; reject cursor/query mismatch and verify no duplicates/skips with keyset tie-breakers.
6. MCP role and audience isolation; test member/admin/user separation, expiry, revocation, and replay against another project audience.
7. Alias-to-exact-model resolution; reject unknown/stale IDs and retain the resolution evidence.
8. Quota states `UNKNOWN`, `STALE`, `CONFLICTED`, `UNPRICED`, exhausted, and verified-free; ensure no paid fallback or dispatch on unknown evidence.
9. Tool-loop `maxSteps`, provider error, refusal, truncation/`finishReason:length`, and no accidental retry amplification.
10. Stream disconnect, post-first-byte error, timeout, cancellation, backpressure, and final-state persistence; resolve the Hatchable documentation conflict before using that platform's stream behavior as an oracle.
11. HMAC verification against raw bytes, tampered payload, stale timestamp, duplicate event ID, and invalid-event evidence retention.
12. Separate inference completion from task completion and collaboration delivery; inject sync failure after successful inference and verify states remain distinct.
13. Provider-native tool extension must not leak into the portable function-tool contract.
14. Verify report generation uses exclusive create semantics and never overwrites a pre-existing report.

## 8. Coverage gaps and later operator decisions

- No general ChatGPT plugin catalog beyond the current action registry and named app-permission lookups was available. The runtime list may be broader than installed apps.
- No ChatGPT skill roots were listed. Hatchable had a separate 57-entry platform registry; only nine relevant entries were read. Linear agent skills were empty.
- No cURL AI Bridge project object was found in the bounded Linear project-name query.
- No Trello board, Render service, Neon project, Supabase project, Replit app, Webflow site, or Hatchable project was read because no verified project-scoped resource ID was available and broad account enumeration was outside scope.
- Gmail and Google Calendar content were not inspected; their named apps reported `not_installed`.
- Todoist tools were exposed but its named app reported `not_installed`; no task read was attempted.
- Local conversation/collaboration stores, SQLite runtime, provider CLI sessions/configuration, quota ledgers, and worker processes were not inspected in this plugin-capability run.
- GitHub/Dropbox/Linear rate limits, retry behavior, and full provider scopes remain unknown where not documented above.
- No operator elevation, approval, OAuth, connection, or permission action was requested or initiated. Any future connection or permission change remains an operator-controlled decision.
- The `AI_A` `runtime_parent` field in CC-006C should be handled only through a separately authorized, versioned reconciliation successor; do not mutate the existing protocol record.
- Hatchable's streaming documentation conflict requires authoritative platform clarification before implementation reliance.

## 9. Report artifact and final disposition

- **Artifact path:** `/home/sunilkr/Code/multi-project-workspace/reports/workspace-inspections/plugin-capability-lessons-20261119T145318+0530.md`
- **Creation contract:** exclusive create (`O_CREAT | O_EXCL`); no overwrite path is used.
- **Verification:** after creation, read back the exact bytes and verify equality; record file size, line count, and SHA-256 in the run response. The digest is not embedded in this file because doing so would change the file being hashed.

- **Discovery:** bounded catalog and capability review completed.
- **Implementation:** not authorized and not performed.
- **External mutations:** none.
- **Existing repository changes:** preserved.
- **Report:** this is an observational checkpoint, not proof of exhaustive plugin coverage and not an authorization record.

// Objective: Load the workspace env file exactly once, before any module that reads process.env at import time.
// Requirements: Be the first import of every entry that composes the API; fill only missing keys so shell overrides win; do nothing when no env file exists.
// Decisions: A side-effect module guarantees ESM dependency order - app.js importing it first means route modules and localAiPrompt.js evaluate after the file is loaded, which a loadWorkspaceEnv() call in a module body cannot guarantee because imports evaluate first.
// Relevant Files: apps/api/src/env.js, apps/api/src/app.js, apps/api/src/routes/util.js, apps/api/src/routes/aiDrafts.js, apps/api/src/localAiPrompt.js, scripts/env.mjs
// Important Context: User file. Scripts and tests may still call loadWorkspaceEnv directly with a custom env/envFile.
// Work State: Completed: Added as task #63; Active: None; Blocked: None; Next Move: Maintain as needed.
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'

loadWorkspaceEnv()

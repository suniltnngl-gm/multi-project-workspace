// Objective: Share request validators, text limits, and id parsing across route groups.
// Requirements: Validate the same fields with the same messages as the pre-split app.js; read env-based limits after the workspace env file loads.
// Decisions: One util module because task, file, and folder validators share the limit tables; the shared env module is imported before the constants read process.env, so MAX_TASK_* overrides apply without every route loading the file.
// Relevant Files: apps/api/src/routes/util.js, apps/api/src/routes/tasks.js, apps/api/src/routes/files.js, apps/api/src/routes/folders.js, apps/api/src/routes/aiDrafts.js
// Important Context: User file. Imported by every route group that validates request bodies.
// Work State: Completed: Extracted from app.js as task #45; env loading uses the shared env module as task #63; Active: None; Blocked: None; Next Move: Maintain as needed.
import '../env.js'

export const MAX_TITLE_LENGTH = Number(process.env.MAX_TASK_TITLE_LENGTH ?? 200)
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_TASK_DESCRIPTION_LENGTH ?? 2000)
export const MAX_PROJECT_LENGTH = Number(process.env.MAX_TASK_PROJECT_LENGTH ?? 80)
const MAX_ACCEPTANCE_CRITERIA_LENGTH = Number(process.env.MAX_TASK_ACCEPTANCE_CRITERIA_LENGTH ?? 2000)
const MAX_PLANNING_TEXT_LENGTH = Number(process.env.MAX_TASK_PLANNING_TEXT_LENGTH ?? 2000)
const PLANNING_TEXT_FIELDS = [
  'objectives', 'requirements', 'decisions', 'relevant_files', 'important_context',
  'work_completed', 'work_active', 'work_blocked', 'next_move'
]
export const TASK_TEXT_LIMITS = {
  description: MAX_DESCRIPTION_LENGTH,
  acceptance_criteria: MAX_ACCEPTANCE_CRITERIA_LENGTH,
  ...Object.fromEntries(
    PLANNING_TEXT_FIELDS.map((field) => [field, MAX_PLANNING_TEXT_LENGTH])
  )
}
export const USER_FILE_TEXT_FIELDS = [
  'objective', 'requirements', 'decisions', 'relevant_files', 'important_context'
]
const USER_FILE_TEXT_LIMITS = Object.fromEntries(
  USER_FILE_TEXT_FIELDS.map((field) => [field, MAX_PLANNING_TEXT_LENGTH])
)
const USER_FILE_TEXT_LABELS = {
  objective: 'Objective',
  requirements: 'Requirements',
  decisions: 'Decisions',
  relevant_files: 'Relevant files',
  important_context: 'Important context',
  work_completed: 'Work completed',
  work_active: 'Active work',
  work_blocked: 'Blocked work',
  next_move: 'Next move'
}
export const TASK_TEXT_LABELS = {
  description: 'Description',
  acceptance_criteria: 'Acceptance criteria',
  objectives: 'Objectives',
  requirements: 'Requirements',
  decisions: 'Decisions',
  relevant_files: 'Relevant files',
  important_context: 'Important context',
  work_completed: 'Work completed',
  work_active: 'Active work',
  work_blocked: 'Blocked work',
  next_move: 'Next move'
}
export const TASK_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done'])
export const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
export const TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])

export function isValidText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength
}

export function validateTaskInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set([
    'title', 'description', 'completed', 'project', 'status', 'priority',
    'task_type', 'acceptance_criteria', ...PLANNING_TEXT_FIELDS
  ])
  // Drafting provenance is recorded at creation only and is never editable
  // afterwards, mirroring the worktree link.
  if (!partial) allowedFields.add('source_job_id')
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported task field.'
  }

  if (
    body.source_job_id !== undefined &&
    (!isValidText(body.source_job_id, 100) || !body.source_job_id.trim())
  ) {
    return 'Source job must be a non-empty job ID of at most 100 characters.'
  }

  if (!partial || Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return 'Title must be a non-empty string.'
    }
    if (body.title.trim().length > MAX_TITLE_LENGTH) {
      return `Title must be at most ${MAX_TITLE_LENGTH} characters.`
    }
  }

  if (Object.hasOwn(body, 'completed') && typeof body.completed !== 'boolean') {
    return 'Completed must be a boolean.'
  }

  if (Object.hasOwn(body, 'status') && !TASK_STATUSES.has(body.status)) {
    return `Status must be one of: ${[...TASK_STATUSES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'completed') && Object.hasOwn(body, 'status')) {
    const statusIsDone = body.status === 'done'
    if (body.completed !== statusIsDone) {
      return 'Completed must match the selected status.'
    }
  }
  if (Object.hasOwn(body, 'priority') && !TASK_PRIORITIES.has(body.priority)) {
    return `Priority must be one of: ${[...TASK_PRIORITIES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'task_type') && !TASK_TYPES.has(body.task_type)) {
    return `Task type must be one of: ${[...TASK_TYPES].join(', ')}.`
  }
  if (Object.hasOwn(body, 'project')) {
    if (typeof body.project !== 'string' || !body.project.trim()) {
      return 'Project must be a non-empty string.'
    }
    if (body.project.trim().length > MAX_PROJECT_LENGTH) {
      return `Project must be at most ${MAX_PROJECT_LENGTH} characters.`
    }
  }
  for (const [field, maxLength] of Object.entries(TASK_TEXT_LIMITS)) {
    if (!Object.hasOwn(body, field)) continue
    if (typeof body[field] !== 'string') {
      return `${TASK_TEXT_LABELS[field]} must be a string.`
    }
    if (body[field].length > maxLength) {
      return `${TASK_TEXT_LABELS[field]} must be at most ${maxLength} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

export function validateUserFileInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set(['path', ...USER_FILE_TEXT_FIELDS])
  // The repository scope is chosen at creation and never edited afterwards.
  if (!partial) allowedFields.add('repository')
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported user-file field.'
  }

  if (!partial && Object.hasOwn(body, 'repository')) {
    if (typeof body.repository !== 'string' || !body.repository.trim()) {
      return 'Repository must be a non-empty repository name.'
    }
    if (body.repository.trim().length > 100) {
      return 'Repository must be at most 100 characters.'
    }
  }

  if (!partial || Object.hasOwn(body, 'path')) {
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return 'Path must be a non-empty string.'
    }
    if (body.path.trim().length > 500) {
      return 'Path must be at most 500 characters.'
    }
  }

  for (const [field, maxLength] of Object.entries(USER_FILE_TEXT_LIMITS)) {
    if (!Object.hasOwn(body, field)) continue
    if (typeof body[field] !== 'string') {
      return `${USER_FILE_TEXT_LABELS[field]} must be a string.`
    }
    if (body[field].length > maxLength) {
      return `${USER_FILE_TEXT_LABELS[field]} must be at most ${maxLength} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

export function validateFolderInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const allowedFields = new Set(['path', 'objective'])
  // The repository scope is chosen at creation and never edited afterwards.
  if (!partial) allowedFields.add('repository')
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return 'Request includes an unsupported folder field.'
  }

  if (!partial && Object.hasOwn(body, 'repository')) {
    if (typeof body.repository !== 'string' || !body.repository.trim()) {
      return 'Repository must be a non-empty repository name.'
    }
    if (body.repository.trim().length > 100) {
      return 'Repository must be at most 100 characters.'
    }
  }

  if (!partial || Object.hasOwn(body, 'path')) {
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return 'Path must be a non-empty string.'
    }
    if (body.path.trim().length > 500) {
      return 'Path must be at most 500 characters.'
    }
  }

  if (Object.hasOwn(body, 'objective')) {
    if (typeof body.objective !== 'string') {
      return 'Objective must be a string.'
    }
    if (body.objective.length > MAX_PLANNING_TEXT_LENGTH) {
      return `Objective must be at most ${MAX_PLANNING_TEXT_LENGTH} characters.`
    }
  }

  if (partial && Object.keys(body).length === 0) {
    return 'Provide at least one field to update.'
  }

  return null
}

export function parseId(value) {
  if (!/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

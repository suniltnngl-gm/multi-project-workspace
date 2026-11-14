// Objective: Build bounded AI prompts, hydrate 1-hop user_files/folders/session registers, backfill blank task registers, and compact agent session summaries.
// Requirements: Keep prompt sizes and token budgets bounded; expand relevant_files 1-hop and ancestor folders.objective without raw file bodies; persist blank task registers before runs; prioritize Session summary and work-state registers within maxChars.
// Decisions: Keep prompt formatting and context hydration deterministic so agents start with compact registers instead of guessing or loading raw source files; compact completed exchanges back into ai_sessions via recordAgentSessionExchange.
// Relevant Files: apps/api/src/localAiPrompt.js, apps/api/src/swarmRunner.js, apps/api/src/routes/aiDrafts.js, apps/api/src/db/userFiles.js, apps/api/src/db/folders.js, apps/api/src/db/aiSessions.js
// Important Context: User file. Shared prompt builder, register backfill, and context-hydration helper for swarm and draft routes.
// Work State: Completed: Bounded prompt builder (#51/#63), 1-hop register resolver, backfillTaskRegisters, formatAgentContextBlock, recordAgentSessionExchange; Active: None; Blocked: None; Next Move: Maintain as needed.
const MAX_USER_PROMPT_CHARS = Number(process.env.MAX_AI_PROMPT_CHARS ?? 2200)
const SESSION_SUMMARY_MAX_CHARS = Number(process.env.MAX_AI_SESSION_SUMMARY_CHARS ?? 400)
const DETAILED_ROUTE_THRESHOLD = 600
const BRIEF_MAX_TOKENS = 180
const DETAILED_MAX_TOKENS = 300
const PROMPT_TEXT_FIELDS = [
  ['objectives', 'Objectives'],
  ['requirements', 'Requirements'],
  ['description', 'Description'],
  ['acceptance_criteria', 'Acceptance criteria'],
  ['decisions', 'Decisions'],
  ['relevant_files', 'Relevant files'],
  ['important_context', 'Important context'],
  ['work_completed', 'Work completed'],
  ['work_active', 'Active work'],
  ['work_blocked', 'Blocked work'],
  ['next_move', 'Next move']
]

function truncateText(value, maxLength) {
  const text = value.trim()
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  if (maxLength === 1) return '…'
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function formatUserPrompt(task, values, sessionSummary = '') {
  const lines = [
    `Task: ${task.title.trim()}`,
    `Project: ${task.project.trim()}`,
    `Type: ${task.task_type.trim()}`
  ]
  for (const [field, label] of PROMPT_TEXT_FIELDS) {
    lines.push(`${label}:`, values[field] || '(not provided)')
  }
  if (sessionSummary) {
    lines.push('Session context:', truncateText(sessionSummary, SESSION_SUMMARY_MAX_CHARS))
  }
  return lines.join('\n')
}

function boundFieldValues(task, contentBudget) {
  const values = Object.fromEntries(
    PROMPT_TEXT_FIELDS.map(([field]) => [field, (task[field] ?? '').trim()])
  )
  const totalLength = Object.values(values).reduce((sum, value) => sum + value.length, 0)
  if (totalLength <= contentBudget) {
    return { values, wasTruncated: false }
  }

  const populatedFields = PROMPT_TEXT_FIELDS
    .map(([field]) => field)
    .filter((field) => values[field].length > 0)
  const bounded = { ...values }
  let remaining = contentBudget

  for (const [index, field] of populatedFields.entries()) {
    const fieldsLeft = populatedFields.length - index
    const proportional = Math.floor((contentBudget * values[field].length) / totalLength)
    const budget = fieldsLeft === 1
      ? remaining
      : Math.max(1, Math.min(proportional, remaining - (fieldsLeft - 1)))
    const text = truncateText(values[field], budget)
    bounded[field] = text
    remaining -= text.length
  }

  return { values: bounded, wasTruncated: true }
}

export function buildTaskPrompt(task, { sessionSummary = '' } = {}) {
  const emptyValues = Object.fromEntries(PROMPT_TEXT_FIELDS.map(([field]) => [field, '']))
  const summary = sessionSummary.trim()
  const contentBudget = Math.max(
    0,
    MAX_USER_PROMPT_CHARS - formatUserPrompt(task, emptyValues, summary).length
  )
  const { values, wasTruncated } = boundFieldValues(task, contentBudget)
  const userPrompt = formatUserPrompt(task, values, summary)
  const providedLength = PROMPT_TEXT_FIELDS.reduce(
    (sum, [field]) => sum + (task[field] ?? '').trim().length,
    0
  )
  const route = providedLength <= DETAILED_ROUTE_THRESHOLD ? 'brief' : 'detailed'
  const systemPrompt = route === 'brief'
    ? 'Refine this software task concisely. Return only JSON with string fields "description" and "acceptance_criteria". Preserve intent and supplied objectives, requirements, decisions, files, and context; do not invent requirements or claim work is done. Use 1-3 specific, verifiable criteria. State assumptions briefly when needed.'
    : 'Refine this software task while preserving its supplied objectives, requirements, decisions, files, and context. Return only JSON with string fields "description" and "acceptance_criteria". Do not invent requirements or claim work is done. Keep the description concise and criteria specific and verifiable, as a short numbered list. State assumptions briefly when needed.'

  return {
    route,
    wasTruncated,
    maxTokens: route === 'brief' ? BRIEF_MAX_TOKENS : DETAILED_MAX_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  }
}

function normalizeRepoPath(pathValue) {
  return String(pathValue ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function splitFileRefs(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[\n,;]+/)
  const seen = new Set()
  const out = []
  for (const entry of rawList) {
    for (const part of String(entry ?? '').trim().split(/\s+/)) {
      const normalized = normalizeRepoPath(part)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

function matchUserFile(ref, allFiles, byExactPath) {
  if (byExactPath.has(ref)) return byExactPath.get(ref)
  const suffixMatches = allFiles.filter((file) => (
    file.path === ref || file.path.endsWith(`/${ref}`)
  ))
  return suffixMatches.length === 1 ? suffixMatches[0] : null
}

function ancestorFolderPaths(filePaths) {
  const dirs = new Set()
  for (const filePath of filePaths) {
    const parts = normalizeRepoPath(filePath).split('/').filter(Boolean)
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      dirs.add(parts.slice(0, depth).join('/'))
    }
  }
  return [...dirs]
}

export function resolveFileAndFolderRegisters(
  database,
  fileRefs = [],
  { maxFiles = 8, expandRelevant = true } = {}
) {
  const initialPaths = splitFileRefs(fileRefs)
  const rawFiles = typeof database?.listUserFiles === 'function'
    ? database.listUserFiles().filter((file) => !file.missingAt)
    : []
  const byExactPath = new Map(rawFiles.map((file) => [normalizeRepoPath(file.path), file]))

  const matched = []
  const seenFilePaths = new Set()
  for (const ref of initialPaths) {
    if (matched.length >= maxFiles) break
    const found = matchUserFile(ref, rawFiles, byExactPath)
    if (found && !seenFilePaths.has(found.path)) {
      seenFilePaths.add(found.path)
      matched.push(found)
    }
  }

  if (expandRelevant) {
    const firstHop = [...matched]
    for (const file of firstHop) {
      for (const extraRef of splitFileRefs(file.relevant_files)) {
        if (matched.length >= maxFiles) break
        const found = matchUserFile(extraRef, rawFiles, byExactPath)
        if (found && !seenFilePaths.has(found.path)) {
          seenFilePaths.add(found.path)
          matched.push(found)
        }
      }
    }
  }

  const expandedPaths = [...new Set([...initialPaths, ...matched.map((file) => file.path)])]

  const fileRegisters = matched
    .map((file) => ({
      path: file.path,
      objective: String(file.objective ?? '').trim(),
      requirements: String(file.requirements ?? '').trim(),
      decisions: String(file.decisions ?? '').trim(),
      relevant_files: String(file.relevant_files ?? '').trim(),
      important_context: String(file.important_context ?? '').trim()
    }))
    .filter((entry) => (
      entry.objective || entry.requirements || entry.decisions || entry.relevant_files || entry.important_context
    ))

  const allFolders = typeof database?.listFolders === 'function' ? database.listFolders() : []
  const folderMap = new Map(allFolders.map((folder) => [normalizeRepoPath(folder.path), folder]))
  const folderRegisters = []
  const seenFolders = new Set()
  for (const dir of ancestorFolderPaths(expandedPaths)) {
    const folder = folderMap.get(dir)
    const objective = String(folder?.objective ?? '').trim()
    if (folder && objective && !seenFolders.has(folder.path)) {
      seenFolders.add(folder.path)
      folderRegisters.push({ path: folder.path, objective })
    }
  }

  const joinParts = (items) => items.filter(Boolean).join('\n')
  const mergedRegisters = {
    objectives: joinParts([
      ...folderRegisters.map((folder) => `${folder.path}: ${folder.objective}`),
      ...fileRegisters.filter((file) => file.objective).map((file) => `${file.path}: ${file.objective}`)
    ]),
    requirements: joinParts(
      fileRegisters.filter((file) => file.requirements).map((file) => `${file.path}: ${file.requirements}`)
    ),
    decisions: joinParts(
      fileRegisters.filter((file) => file.decisions).map((file) => `${file.path}: ${file.decisions}`)
    ),
    relevant_files: expandedPaths.join(', '),
    important_context: joinParts(
      fileRegisters
        .filter((file) => file.important_context)
        .map((file) => `${file.path}: ${file.important_context}`)
    )
  }

  return { files: expandedPaths, fileRegisters, folderRegisters, mergedRegisters }
}

const BACKFILL_FIELDS = [
  'objectives',
  'requirements',
  'decisions',
  'relevant_files',
  'important_context'
]

export function backfillTaskRegisters(database, task = {}, { extraFiles = [], persist = false } = {}) {
  const initialRefs = [...splitFileRefs(task?.relevant_files), ...splitFileRefs(extraFiles)]
  const resolved = resolveFileAndFolderRegisters(database, initialRefs)
  if (resolved.fileRegisters.length === 0 && resolved.folderRegisters.length === 0) {
    return {
      task,
      backfilledFields: [],
      fileRegisters: [],
      folderRegisters: [],
      files: splitFileRefs(initialRefs)
    }
  }

  const nextTask = { ...task }
  const updates = {}
  const backfilledFields = []
  for (const field of BACKFILL_FIELDS) {
    if (!String(task?.[field] ?? '').trim() && resolved.mergedRegisters[field]) {
      const bounded = truncateText(resolved.mergedRegisters[field], 2000)
      nextTask[field] = bounded
      updates[field] = bounded
      backfilledFields.push(field)
    }
  }

  let finalTask = nextTask
  if (persist && task?.id && backfilledFields.length > 0 && typeof database?.updateTask === 'function') {
    finalTask = database.updateTask(task.id, updates) ?? nextTask
  }

  return {
    task: finalTask,
    backfilledFields,
    fileRegisters: resolved.fileRegisters,
    folderRegisters: resolved.folderRegisters,
    files: resolved.files
  }
}

export function resolveTaskSessionContext(database, { taskId = null, sessionId = null } = {}) {
  if (!database || typeof database.getAiSession !== 'function') {
    return { session: null, sessionSummary: '' }
  }
  let session = null
  if (sessionId !== null && sessionId !== undefined && sessionId !== '') {
    session = database.getAiSession(Number(sessionId))
  } else if (taskId !== null && taskId !== undefined && typeof database.listAiSessions === 'function') {
    const numericTaskId = Number(taskId)
    const match = database.listAiSessions().find((entry) => Number(entry.taskId) === numericTaskId)
    if (match) session = database.getAiSession(match.id)
  }
  return {
    session: session ?? null,
    sessionSummary: String(session?.summary ?? '').trim()
  }
}

export function formatAgentContextBlock({
  task = null,
  fileRegisters = [],
  folderRegisters = [],
  sessionSummary = '',
  maxChars = 1200
} = {}) {
  const lines = []
  if (sessionSummary && String(sessionSummary).trim()) {
    lines.push(`Session summary: ${truncateText(String(sessionSummary), 300)}`)
  }
  if (task && typeof task === 'object') {
    const taskFields = [
      ['work_completed', 'Work completed'],
      ['work_active', 'Active work'],
      ['next_move', 'Next move'],
      ['requirements', 'Requirements'],
      ['decisions', 'Decisions'],
      ['important_context', 'Important context']
    ]
    for (const [field, label] of taskFields) {
      const value = String(task[field] ?? '').trim()
      if (value) lines.push(`${label}: ${truncateText(value, 220)}`)
    }
  }
  for (const folder of folderRegisters) {
    if (folder.objective) {
      lines.push(`Folder ${folder.path}: ${truncateText(folder.objective, 180)}`)
    }
  }
  for (const file of fileRegisters) {
    const parts = []
    if (file.objective) parts.push(`objective=${truncateText(file.objective, 120)}`)
    if (file.decisions) parts.push(`decisions=${truncateText(file.decisions, 120)}`)
    if (file.requirements) parts.push(`requirements=${truncateText(file.requirements, 120)}`)
    if (file.relevant_files) parts.push(`refs=${truncateText(file.relevant_files, 120)}`)
    if (file.important_context) parts.push(`context=${truncateText(file.important_context, 120)}`)
    if (parts.length > 0) lines.push(`File ${file.path}: ${parts.join('; ')}`)
  }
  if (lines.length === 0) return ''
  return truncateText(lines.join('\n'), maxChars)
}

export function recordAgentSessionExchange(
  database,
  {
    taskId = null,
    sessionId = null,
    title = '',
    userContent = '',
    assistantContent = '',
    compactThreshold = 6
  } = {}
) {
  if (
    !database
    || typeof database.getAiSession !== 'function'
    || typeof database.addAiMessage !== 'function'
  ) {
    return null
  }
  let { session } = resolveTaskSessionContext(database, { taskId, sessionId })
  if (!session && taskId !== null && taskId !== undefined && typeof database.createAiSession === 'function') {
    const sessionTitle = String(title || `Task #${taskId} context`).trim().slice(0, 200)
    session = database.createAiSession({ taskId: Number(taskId), title: sessionTitle })
  }
  if (!session) return null

  const cleanUser = String(userContent ?? '').trim()
  const cleanAssistant = String(assistantContent ?? '').trim()
  let updated = session
  if (cleanUser) {
    updated = database.addAiMessage(session.id, { role: 'user', content: cleanUser.slice(0, 2000) }) ?? updated
  }
  if (cleanAssistant) {
    updated = database.addAiMessage(session.id, { role: 'assistant', content: cleanAssistant.slice(0, 2000) }) ?? updated
  }

  if (
    typeof database.compactAiSession === 'function'
    && (
      !String(updated.summary ?? '').trim()
      || (Array.isArray(updated.messages) && updated.messages.length >= compactThreshold)
    )
  ) {
    const prev = String(updated.summary ?? '').trim()
    const addition = cleanAssistant || cleanUser
    const nextSummary = prev && addition && !prev.includes(addition.slice(0, 60))
      ? truncateText(`${prev}\n${addition}`, 1500)
      : truncateText(addition || prev, 1500)
    if (nextSummary) {
      updated = database.compactAiSession(session.id, nextSummary) ?? updated
    }
  }
  return updated
}

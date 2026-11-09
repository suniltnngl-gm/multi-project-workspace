const MAX_USER_PROMPT_CHARS = Number(process.env.MAX_AI_PROMPT_CHARS ?? 2200)
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

function formatUserPrompt(task, values) {
  const lines = [
    `Task: ${task.title.trim()}`,
    `Project: ${task.project.trim()}`,
    `Type: ${task.task_type.trim()}`
  ]
  for (const [field, label] of PROMPT_TEXT_FIELDS) {
    lines.push(`${label}:`, values[field] || '(not provided)')
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

export function buildTaskPrompt(task) {
  const emptyValues = Object.fromEntries(PROMPT_TEXT_FIELDS.map(([field]) => [field, '']))
  const contentBudget = Math.max(
    0,
    MAX_USER_PROMPT_CHARS - formatUserPrompt(task, emptyValues).length
  )
  const { values, wasTruncated } = boundFieldValues(task, contentBudget)
  const userPrompt = formatUserPrompt(task, values)
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

const MAX_USER_PROMPT_CHARS = 2200
const DETAILED_ROUTE_THRESHOLD = 600
const BRIEF_MAX_TOKENS = 180
const DETAILED_MAX_TOKENS = 300

function truncateText(value, maxLength) {
  const text = value.trim()
  if (text.length <= maxLength) return text
  if (maxLength <= 1) return '…'
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function formatUserPrompt(task, description, acceptanceCriteria) {
  return [
    `Task: ${task.title.trim()}`,
    `Project: ${task.project.trim()}`,
    `Type: ${task.task_type.trim()}`,
    'Description:',
    description || '(not provided)',
    'Acceptance criteria:',
    acceptanceCriteria || '(not provided)'
  ].join('\n')
}

export function buildTaskPrompt(task) {
  const description = task.description.trim()
  const acceptanceCriteria = task.acceptance_criteria.trim()
  const contentBudget = Math.max(
    0,
    MAX_USER_PROMPT_CHARS - formatUserPrompt(task, '', '').length
  )
  const providedLength = description.length + acceptanceCriteria.length
  const wasTruncated = providedLength > contentBudget
  let descriptionBudget = description.length
  let criteriaBudget = acceptanceCriteria.length

  if (wasTruncated) {
    if (description && acceptanceCriteria) {
      descriptionBudget = Math.floor(contentBudget * description.length / providedLength)
      criteriaBudget = contentBudget - descriptionBudget
    } else if (description) {
      descriptionBudget = contentBudget
    } else {
      criteriaBudget = contentBudget
    }
  }

  const boundedDescription = truncateText(description, descriptionBudget)
  const boundedCriteria = truncateText(acceptanceCriteria, criteriaBudget)
  const userPrompt = formatUserPrompt(task, boundedDescription, boundedCriteria)
  const route = providedLength <= DETAILED_ROUTE_THRESHOLD ? 'brief' : 'detailed'
  const systemPrompt = route === 'brief'
    ? 'Refine this software task concisely. Return only JSON with string fields "description" and "acceptance_criteria". Preserve intent, do not invent requirements or claim work is done. Use 1-3 specific, verifiable criteria. State assumptions briefly when needed.'
    : 'Refine this software task while preserving its supplied constraints. Return only JSON with string fields "description" and "acceptance_criteria". Do not invent requirements or claim work is done. Keep the description concise and criteria specific and verifiable, as a short numbered list. State assumptions briefly when needed.'

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

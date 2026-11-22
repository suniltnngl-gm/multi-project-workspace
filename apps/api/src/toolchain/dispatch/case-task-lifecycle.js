/**
 * Case <-> Task lifecycle (SP-009):
 * - Single option (<= 1): creates a `task` (state: `queued`) ready for execution.
 * - Multiple options (> 1): creates a `case` (state: `open_case`) awaiting option selection.
 * - Selecting 1 option promotes a `case` -> `task`.
 * - Discovering multiple options during execution demotes a `task` -> `case`.
 */

function nowIso() {
  return new Date().toISOString()
}

function normalizeOptions(options = []) {
  return (Array.isArray(options) ? options : [])
    .filter(Boolean)
    .map((opt, idx) => (typeof opt === 'string'
      ? { id: `opt-${idx + 1}`, label: opt }
      : { id: String(opt.id || `opt-${idx + 1}`), label: String(opt.label || opt.id || `opt-${idx + 1}`), ...opt }))
}

export function createWorkItem({ id, title, options = [], priority = 'P2', costTier = 'daily' }) {
  const normalized = normalizeOptions(options)
  if (normalized.length > 1) {
    return {
      id,
      title,
      kind: 'case',
      state: 'open_case',
      priority,
      costTier,
      options: normalized,
      selectedOption: null,
      history: [{ event: 'created_as_case', optionCount: normalized.length, at: nowIso() }]
    }
  }
  return {
    id,
    title,
    kind: 'task',
    state: 'queued',
    priority,
    costTier,
    options: normalized,
    selectedOption: normalized[0] || null,
    history: [{ event: 'created_as_task', optionCount: normalized.length, at: nowIso() }]
  }
}

export function promoteCaseToTask(item, optionId, { reason = null } = {}) {
  if (item?.kind !== 'case') {
    throw new Error(`cannot_promote_non_case:${item?.id}:${item?.kind}`)
  }
  const chosen = (item.options || []).find((o) => o.id === optionId)
  if (!chosen) {
    throw new Error(`invalid_case_option:${item.id}:${optionId}`)
  }
  return {
    ...item,
    kind: 'task',
    state: 'queued',
    selectedOption: chosen,
    history: [...(item.history || []), { event: 'promoted_to_task', optionId: chosen.id, reason, at: nowIso() }]
  }
}

export function demoteTaskToCase(item, newOptions, { reason = null } = {}) {
  if (item?.kind !== 'task') {
    throw new Error(`cannot_demote_non_task:${item?.id}:${item?.kind}`)
  }
  const normalized = normalizeOptions(newOptions)
  if (normalized.length < 2) {
    throw new Error(`demote_requires_multiple_options:${item.id}:${normalized.length}`)
  }
  return {
    ...item,
    kind: 'case',
    state: 'open_case',
    options: normalized,
    selectedOption: null,
    history: [...(item.history || []), { event: 'demoted_to_case', optionCount: normalized.length, reason, at: nowIso() }]
  }
}

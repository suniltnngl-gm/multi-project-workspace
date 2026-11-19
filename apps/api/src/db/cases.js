// Objective: Own the Case Registry domain: multi-option decision records, verifiable provenance, discussion trails, and atomic promotion into the Task Board.
// Requirements: Keep Case Registry strictly decision-only (grants_execution_authority: false); enforce R1-R6 and C1-C5 fail-closed invariants; use one normalization pipeline for both request_sha256 and persisted task payloads.
// Decisions: Additive SQLite tables store cases, options, append-only evidence/discussion/promotions/events; managed-project promotions share the caller's connection and delegate to registerTaskAtCurrentGeneration inside one BEGIN IMMEDIATE transaction; lazy statement preparation supports read-only CLI inspection.
// Relevant Files: apps/api/src/db/cases.js, apps/api/src/db/migrations.js, apps/api/src/database.js, apps/api/src/db/taskBootstrap.js, apps/api/src/db/tasks.js, schemas/case-record.schema.json, scripts/case-registry.mjs
// Important Context: User file. Composed into createDatabase; never grants execution authority or acquires writer leases.
// Work State: Phase 1 implementation under frozen Case Registry Design Contract v1.0 + C5 Addendum.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export const CASE_ID_PATTERN = /^[A-Z][A-Z0-9]{1,7}-C-[0-9]{3,}$/
export const MAX_PROMOTION_BATCH_TASKS = 25
export const MAX_EVIDENCE_VERIFY_BYTES = 10 * 1024 * 1024
export const CASE_AUTHORITY = Object.freeze({
  authority: 'decision-only',
  grants_execution_authority: false
})

const DEFAULT_TRUST_NOTE = 'Byte identity is distinct from trustworthiness and does not grant execution or requirement authority.'
const VALID_STATUSES = new Set([
  'open', 'investigating', 'discussing', 'decision_ready',
  'decided', 'promoted', 'deferred', 'rejected', 'closed'
])
const VALID_ACTOR_ROLES = new Set(['operator', 'assistant', 'reviewer', 'auditor', 'system'])
const VALID_ENTRY_TYPES = new Set([
  'comment', 'finding', 'question', 'objection', 'recommendation', 'disposition_note'
])
const VALID_SOURCE_TYPES = new Set([
  'git_commit', 'workspace_file', 'test_run', 'command_output',
  'sqlite_query', 'audit_report', 'external_reference'
])
const VALID_HASH_STATUSES = new Set(['verified', 'unverified_claimed', 'unhashed', 'not_applicable'])
const VALID_TASK_COUNTS = new Set(['none', 'one', 'multiple'])
const VALID_GOVERNANCE_MODES = new Set([
  'standard_task_promotion',
  'no_task_required',
  'requires_separate_governance_mechanism'
])
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])
const VALID_TASK_TYPES = new Set(['feature', 'bug', 'chore', 'test', 'docs'])
const FROZEN_OPTION_STATUSES = new Set(['decided', 'promoted', 'closed'])
const PRE_DECISION_STATUSES = new Set(['open', 'investigating', 'discussing', 'decision_ready'])
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const MULTILINE_TASK_FIELDS = [
  'description', 'acceptance_criteria', 'objectives', 'requirements',
  'decisions', 'relevant_files', 'important_context', 'work_completed',
  'work_active', 'work_blocked', 'next_move'
]
const PROMOTION_TASK_FIELDS = new Set([
  'project', 'title', 'priority', 'task_type', ...MULTILINE_TASK_FIELDS, 'id', 'status'
])

const TRANSITION_ALLOWLIST = Object.freeze({
  open: new Set(['investigating', 'discussing', 'deferred', 'rejected', 'closed']),
  investigating: new Set(['discussing', 'decision_ready', 'deferred', 'rejected']),
  discussing: new Set(['investigating', 'decision_ready', 'deferred', 'rejected']),
  decision_ready: new Set(['investigating', 'discussing', 'deferred', 'rejected']),
  decided: new Set(['deferred', 'closed']),
  promoted: new Set(['closed']),
  deferred: new Set(['open', 'investigating', 'discussing', 'closed']),
  rejected: new Set(['closed']),
  closed: new Set()
})

function assertWellFormedString(value, invalidCode, unicodeCode = 'case_invalid_unicode', nulCode = 'case_invalid_control_char') {
  if (typeof value !== 'string') throw new Error(invalidCode)
  if (!value.isWellFormed()) throw new Error(unicodeCode)
  if (value.includes('\u0000')) throw new Error(nulCode)
  return value.normalize('NFC')
}

function assertSingleLineExact(value, invalidCode, maxLen, { whitespaceCode = 'case_exact_field_whitespace', controlCode = 'case_invalid_control_char', unicodeCode = 'case_invalid_unicode' } = {}) {
  const nfc = assertWellFormedString(value, invalidCode, unicodeCode, controlCode)
  if (nfc.includes('\r') || nfc.includes('\n')) throw new Error(controlCode)
  if (nfc !== nfc.trim()) throw new Error(whitespaceCode)
  if (!nfc || (maxLen !== undefined && nfc.length > maxLen)) throw new Error(invalidCode)
  return nfc
}

function normalizeSingleLineTrimmed(value, missingCode, maxLen, { controlCode = 'case_invalid_control_char', unicodeCode = 'case_invalid_unicode' } = {}) {
  const nfc = assertWellFormedString(value, missingCode, unicodeCode, controlCode)
  if (nfc.includes('\r') || nfc.includes('\n')) throw new Error(controlCode)
  const trimmed = nfc.trim()
  if (!trimmed || (maxLen !== undefined && trimmed.length > maxLen)) throw new Error(missingCode)
  return trimmed
}

function normalizeMultilineText(value, invalidCode, maxLen, tooLongCode) {
  if (value === undefined) return ''
  const nfc = assertWellFormedString(value, invalidCode, 'case_promotion_invalid_unicode', 'case_promotion_invalid_control_char')
  const normalized = nfc.replace(/\r\n?/g, '\n')
  if (maxLen !== undefined && normalized.length > maxLen) throw new Error(tooLongCode)
  return normalized
}

export function assertValidCaseId(caseId) {
  const nfc = assertSingleLineExact(caseId, 'case_id_invalid', 32, {
    whitespaceCode: 'case_id_invalid',
    controlCode: 'case_id_invalid'
  })
  if (nfc.length < 8 || !CASE_ID_PATTERN.test(nfc)) throw new Error('case_id_invalid')
  return nfc
}

function assertActor(actorId, actorRole) {
  const id = normalizeSingleLineTrimmed(actorId, 'case_actor_id_required', 100)
  if (typeof actorRole !== 'string' || !VALID_ACTOR_ROLES.has(actorRole)) {
    throw new Error('case_actor_role_invalid')
  }
  return { actorId: id, actorRole }
}

function assertVersion(expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('case_expected_version_invalid')
  }
  return expectedVersion
}

function assertPromotionExpectedGeneration(managed, expectedGeneration) {
  if (managed) {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new Error('case_promotion_expected_generation_required')
    }
    return expectedGeneration
  }
  if (expectedGeneration !== undefined && expectedGeneration !== null) {
    throw new Error('case_promotion_expected_generation_unexpected')
  }
  return null
}

function assertStringArray(items, code) {
  if (items === undefined) return []
  if (!Array.isArray(items)) throw new Error(code)
  return items.map((item) => normalizeSingleLineTrimmed(item, code, 1000))
}

function assertIsoTimestamp(value, code) {
  const nfc = assertSingleLineExact(value, code, 64)
  if (!ISO_TIMESTAMP_PATTERN.test(nfc) || Number.isNaN(Date.parse(nfc))) throw new Error(code)
  return nfc
}

function readVerifiedFileBytes(filePath) {
  const raw = assertSingleLineExact(filePath, 'case_evidence_verify_file_invalid', 1000)
  const resolved = resolve(raw)
  if (!existsSync(resolved)) throw new Error('case_evidence_verify_file_missing')
  const stat = lstatSync(resolved)
  if (stat.isSymbolicLink() || realpathSync(resolved) !== resolved) {
    throw new Error('case_evidence_verify_file_symlink_rejected')
  }
  if (!stat.isFile()) throw new Error('case_evidence_verify_file_not_regular')
  if (stat.size > MAX_EVIDENCE_VERIFY_BYTES) throw new Error('case_evidence_verify_file_too_large')
  return readFileSync(resolved)
}

/**
 * RFC 8785 / JCS-compatible recursive sorted-key JSON serializer.
 * Object keys are ordered lexicographically by UTF-16 code units; array element order is preserved.
 */
export function canonicalSerializeJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('case_promotion_non_finite_number')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('case_promotion_invalid_unicode')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalSerializeJson(item))).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalSerializeJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error('case_promotion_unsupported_value')
}

/**
 * Single shared C5 normalization pipeline for both request_sha256 computation
 * and persisted task/promotion payloads (preventing hash-vs-storage drift).
 */
export function normalizePromotionPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('case_promotion_payload_invalid')
  }
  const exactOpts = {
    whitespaceCode: 'case_promotion_exact_field_whitespace',
    controlCode: 'case_promotion_invalid_control_char',
    unicodeCode: 'case_promotion_invalid_unicode'
  }
  const trimOpts = {
    controlCode: 'case_promotion_invalid_control_char',
    unicodeCode: 'case_promotion_invalid_unicode'
  }
  const caseId = assertSingleLineExact(input.case_id, 'case_id_invalid', 32, exactOpts)
  if (caseId.length < 8 || !CASE_ID_PATTERN.test(caseId)) throw new Error('case_id_invalid')

  const projectId = assertSingleLineExact(input.project_id, 'case_project_id_invalid', 100, exactOpts)
  const selectedOptionKey = assertSingleLineExact(input.selected_option_key, 'case_selected_option_invalid', 32, exactOpts)
  const authorizationRef = normalizeSingleLineTrimmed(
    input.authorization_ref,
    'case_promotion_authorization_ref_required',
    500,
    trimOpts
  )

  let expectedGeneration = null
  if (input.expected_generation !== null && input.expected_generation !== undefined) {
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) {
      throw new Error('case_promotion_expected_generation_invalid')
    }
    expectedGeneration = input.expected_generation
  }

  if (!Array.isArray(input.tasks)) throw new Error('case_promotion_tasks_invalid')
  if (input.tasks.length < 1) throw new Error('case_promotion_tasks_empty')
  if (input.tasks.length > MAX_PROMOTION_BATCH_TASKS) throw new Error('case_promotion_tasks_too_many')

  const normalizedTasks = input.tasks.map((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error('case_promotion_task_invalid')
    }
    if (task.id !== undefined && task.id !== null) {
      throw new Error('case_promotion_existing_task_id_rejected')
    }
    if (task.status !== undefined && task.status !== null) {
      throw new Error('case_promotion_task_status_forbidden')
    }
    for (const key of Object.keys(task)) {
      if (!PROMOTION_TASK_FIELDS.has(key)) {
        throw new Error('case_promotion_task_field_unknown')
      }
    }
    const project = assertSingleLineExact(task.project, 'case_promotion_task_project_required', 100, exactOpts)
    const title = normalizeSingleLineTrimmed(task.title, 'case_promotion_task_title_required', 200, trimOpts)
    const priority = task.priority === undefined
      ? 'medium'
      : assertSingleLineExact(task.priority, 'case_promotion_task_priority_invalid', 16, exactOpts)
    if (!VALID_PRIORITIES.has(priority)) throw new Error('case_promotion_task_priority_invalid')

    const taskType = task.task_type === undefined
      ? 'feature'
      : assertSingleLineExact(task.task_type, 'case_promotion_task_type_invalid', 16, exactOpts)
    if (!VALID_TASK_TYPES.has(taskType)) throw new Error('case_promotion_task_type_invalid')

    const normalizedTask = {
      project,
      title,
      priority,
      task_type: taskType
    }
    for (const field of MULTILINE_TASK_FIELDS) {
      normalizedTask[field] = normalizeMultilineText(
        task[field],
        'case_promotion_task_field_invalid',
        16000,
        'case_promotion_task_field_too_long'
      )
    }
    return normalizedTask
  })

  return {
    case_id: caseId,
    project_id: projectId,
    selected_option_key: selectedOptionKey,
    authorization_ref: authorizationRef,
    expected_generation: expectedGeneration,
    tasks: normalizedTasks
  }
}

export function fingerprintPromotionPayload(normalizedPayload) {
  const canonicalJson = canonicalSerializeJson(normalizedPayload)
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
  const sha256 = createHash('sha256').update(canonicalBytes).digest('hex')
  return { canonicalJson, canonicalBytes, sha256 }
}

export function createCasesStore(connection, { tasks, registerTaskAtCurrentGeneration, clock = () => Date.now() } = {}) {
  const statements = new Map()
  const prep = (_key, sql) => {
    let stmt = statements.get(sql)
    if (!stmt) {
      stmt = connection.prepare(sql)
      statements.set(sql, stmt)
    }
    return stmt
  }

  function hasPromotions(caseId) {
    return Boolean(prep('hasPromotions', 'SELECT 1 FROM case_promotions WHERE case_id = ? LIMIT 1').get(caseId))
  }

  function isManagedProject(projectId) {
    if (projectId === 'curl-ai-bridge') return true
    return Boolean(
      prep('hasLeaseState', 'SELECT 1 FROM project_writer_lease_state WHERE project_id = ?').get(projectId)
    )
  }

  function toOption(row) {
    return {
      option_key: row.option_key,
      title: row.title,
      summary: row.summary,
      consequences: JSON.parse(row.consequences_json),
      risks: JSON.parse(row.risks_json),
      prerequisites: JSON.parse(row.prerequisites_json),
      expected_task_count: row.expected_task_count,
      governance_mode: row.governance_mode,
      created_at: row.created_at,
      deprecated_at: row.deprecated_at
    }
  }

  function toEvidence(row) {
    return {
      evidence_id: row.evidence_id,
      source_type: row.source_type,
      source_repo: row.source_repo,
      source_ref: row.source_ref,
      summary: row.summary,
      artifact_sha256: row.artifact_sha256,
      hash_status: row.hash_status,
      authority_level: row.authority_level,
      trust_note: row.trust_note,
      observed_at: row.observed_at,
      recorded_by: row.recorded_by,
      recorded_at: row.recorded_at,
      metadata: JSON.parse(row.metadata_json)
    }
  }

  function toDiscussion(row) {
    return {
      entry_id: row.entry_id,
      author_id: row.author_id,
      author_role: row.author_role,
      entry_type: row.entry_type,
      body: row.body,
      evidence_refs: JSON.parse(row.evidence_refs_json),
      created_at: row.created_at
    }
  }

  function toPromotionRecord(row) {
    return {
      ...CASE_AUTHORITY,
      promotion_id: row.promotion_id,
      batch_id: row.batch_id,
      task_index: row.task_index,
      task_id: row.task_id,
      project_id: row.project_id,
      registration_mode: row.registration_mode,
      fencing_generation: row.fencing_generation,
      bootstrap_event_id: row.bootstrap_event_id,
      authorization_ref: row.authorization_ref,
      batch_idempotency_key: row.batch_idempotency_key,
      item_idempotency_key: row.item_idempotency_key,
      request_sha256: row.request_sha256,
      promoted_by: row.promoted_by,
      promoted_at: row.promoted_at
    }
  }

  function hydrateCase(caseId) {
    const row = prep('getCase', 'SELECT * FROM cases WHERE case_id = ?').get(caseId)
    if (!row) return null
    const options = prep(
      'listOptions',
      'SELECT * FROM case_options WHERE case_id = ? ORDER BY id ASC'
    ).all(caseId).map(toOption)
    const evidence = prep(
      'listEvidence',
      'SELECT * FROM case_evidence WHERE case_id = ? ORDER BY observed_at ASC, evidence_id ASC'
    ).all(caseId).map(toEvidence)
    const discussion = prep(
      'listDiscussion',
      'SELECT * FROM case_discussion WHERE case_id = ? ORDER BY created_at ASC, entry_id ASC'
    ).all(caseId).map(toDiscussion)
    const promotionRows = prep(
      'listPromotions',
      'SELECT * FROM case_promotions WHERE case_id = ? ORDER BY task_index ASC'
    ).all(caseId)

    return {
      schema_version: '1.0',
      ...CASE_AUTHORITY,
      case_id: row.case_id,
      project_id: row.project_id,
      title: row.title,
      problem_statement: row.problem_statement,
      status: row.status,
      version: row.version,
      options,
      evidence,
      discussion,
      recommendation: row.recommendation_option_key ? {
        option_key: row.recommendation_option_key,
        rationale: row.recommendation_rationale,
        recommended_by: row.recommended_by,
        recommended_at: row.recommended_at
      } : null,
      decision: row.selected_option_key ? {
        selected_option: row.selected_option_key,
        decision_rationale: row.decision_rationale,
        decided_by: row.decided_by,
        decided_at: row.decided_at,
        decision_authorization_ref: row.decision_authorization_ref,
        decision_idempotency_key: row.decision_idempotency_key
      } : null,
      promotion: {
        ...CASE_AUTHORITY,
        promoted: promotionRows.length > 0,
        batch_id: promotionRows.length ? promotionRows[0].batch_id : null,
        authorization_ref: promotionRows.length ? promotionRows[0].authorization_ref : null,
        batch_idempotency_key: promotionRows.length ? promotionRows[0].batch_idempotency_key : null,
        request_sha256: promotionRows.length ? promotionRows[0].request_sha256 : null,
        promoted_by: promotionRows.length ? promotionRows[0].promoted_by : null,
        promoted_at: promotionRows.length ? promotionRows[0].promoted_at : null,
        records: promotionRows.map(toPromotionRecord)
      },
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }

  function appendEvent({
    caseId,
    eventType,
    fromStatus = null,
    toStatus = null,
    actorId,
    actorRole,
    authorizationRef = null,
    idempotencyKey = null,
    payload = {},
    occurredAt
  }) {
    prep('insertEvent', `
      INSERT INTO case_events
        (event_id, case_id, event_type, from_status, to_status, actor_id, actor_role, authorization_ref, idempotency_key, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      caseId,
      eventType,
      fromStatus,
      toStatus,
      actorId,
      actorRole,
      authorizationRef,
      idempotencyKey,
      JSON.stringify(payload),
      occurredAt
    )
  }

  function getCaseRowOrThrow(caseId) {
    const id = assertValidCaseId(caseId)
    const row = prep('getCase', 'SELECT * FROM cases WHERE case_id = ?').get(id)
    if (!row) throw new Error('case_not_found')
    return row
  }

  const createCaseTx = connection.transaction((input) => {
    const caseId = assertValidCaseId(input?.caseId)
    const projectId = assertSingleLineExact(input?.projectId, 'case_project_id_invalid', 100)
    const title = normalizeSingleLineTrimmed(input?.title, 'case_title_required', 200)
    const problemStatement = assertWellFormedString(input?.problemStatement, 'case_problem_statement_required')
      .replace(/\r\n?/g, '\n')
    if (!problemStatement.trim() || problemStatement.length > 8000) {
      throw new Error('case_problem_statement_required')
    }
    const { actorId, actorRole } = assertActor(input?.actorId ?? 'operator', input?.actorRole ?? 'operator')
    if (prep('getCaseExists', 'SELECT case_id FROM cases WHERE case_id = ?').get(caseId)) {
      throw new Error('case_already_exists')
    }
    const now = new Date(clock()).toISOString()
    prep('insertCase', `
      INSERT INTO cases
        (case_id, project_id, title, problem_statement, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', 1, ?, ?)
    `).run(caseId, projectId, title, problemStatement, now, now)
    appendEvent({
      caseId,
      eventType: 'created',
      fromStatus: null,
      toStatus: 'open',
      actorId,
      actorRole,
      payload: { project_id: projectId, title },
      occurredAt: now
    })
    return hydrateCase(caseId)
  })

  const addCaseOptionTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    const expectedVersion = assertVersion(input?.expectedVersion)
    if (row.status === 'promoted' || hasPromotions(row.case_id)) {
      throw new Error('case_already_promoted_immutable')
    }
    if (row.status === 'closed') throw new Error('case_closed_immutable')
    if (FROZEN_OPTION_STATUSES.has(row.status)) {
      throw new Error('case_options_frozen_after_decision')
    }
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const optionKey = assertSingleLineExact(input?.optionKey, 'case_option_key_invalid', 32)
    const title = normalizeSingleLineTrimmed(input?.title, 'case_option_title_required', 200)
    const summary = assertWellFormedString(input?.summary, 'case_option_summary_required').replace(/\r\n?/g, '\n')
    if (!summary.trim() || summary.length > 4000) throw new Error('case_option_summary_required')
    const consequences = assertStringArray(input?.consequences, 'case_option_consequences_invalid')
    const risks = assertStringArray(input?.risks, 'case_option_risks_invalid')
    const prerequisites = assertStringArray(input?.prerequisites, 'case_option_prerequisites_invalid')
    const expectedTaskCount = input?.expectedTaskCount ?? 'one'
    const governanceMode = input?.governanceMode ?? 'standard_task_promotion'
    if (typeof expectedTaskCount !== 'string' || !VALID_TASK_COUNTS.has(expectedTaskCount)) {
      throw new Error('case_option_expected_task_count_invalid')
    }
    if (typeof governanceMode !== 'string' || !VALID_GOVERNANCE_MODES.has(governanceMode)) {
      throw new Error('case_option_governance_mode_invalid')
    }
    if (
      (governanceMode === 'no_task_required' && expectedTaskCount !== 'none') ||
      (governanceMode === 'standard_task_promotion' && expectedTaskCount === 'none')
    ) {
      throw new Error('case_option_mode_count_mismatch')
    }
    if (prep('getOption', 'SELECT id FROM case_options WHERE case_id = ? AND option_key = ?').get(row.case_id, optionKey)) {
      throw new Error('case_option_duplicate')
    }

    const now = new Date(clock()).toISOString()
    prep('insertOption', `
      INSERT INTO case_options
        (case_id, option_key, title, summary, consequences_json, risks_json, prerequisites_json, expected_task_count, governance_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.case_id,
      optionKey,
      title,
      summary,
      JSON.stringify(consequences),
      JSON.stringify(risks),
      JSON.stringify(prerequisites),
      expectedTaskCount,
      governanceMode,
      now
    )
    const updated = prep('bumpCaseVersion', `
      UPDATE cases SET version = version + 1, updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(now, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    appendEvent({
      caseId: row.case_id,
      eventType: 'option_added',
      fromStatus: row.status,
      toStatus: row.status,
      actorId,
      actorRole,
      payload: { option_key: optionKey, governance_mode: governanceMode, expected_task_count: expectedTaskCount },
      occurredAt: now
    })
    return hydrateCase(row.case_id)
  })

  const deprecateCaseOptionTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    const expectedVersion = assertVersion(input?.expectedVersion)
    if (row.status === 'promoted' || hasPromotions(row.case_id)) {
      throw new Error('case_already_promoted_immutable')
    }
    if (row.status === 'closed') throw new Error('case_closed_immutable')
    if (FROZEN_OPTION_STATUSES.has(row.status)) {
      throw new Error('case_options_frozen_after_decision')
    }
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const optionKey = assertSingleLineExact(input?.optionKey, 'case_option_key_invalid', 32)
    const option = prep('getOptionFull', 'SELECT * FROM case_options WHERE case_id = ? AND option_key = ?').get(row.case_id, optionKey)
    if (!option) throw new Error('case_option_not_found')
    if (option.deprecated_at !== null) throw new Error('case_option_already_deprecated')

    if (row.status === 'decision_ready') {
      const activeCount = prep(
        'countActiveOptions',
        'SELECT count(*) AS count FROM case_options WHERE case_id = ? AND deprecated_at IS NULL'
      ).get(row.case_id).count
      if (activeCount - 1 < 2) throw new Error('case_decision_ready_requires_two_options')
    }

    const now = new Date(clock()).toISOString()
    prep('deprecateOption', 'UPDATE case_options SET deprecated_at = ? WHERE case_id = ? AND option_key = ?')
      .run(now, row.case_id, optionKey)
    const updated = prep('bumpCaseVersion', `
      UPDATE cases SET version = version + 1, updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(now, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    appendEvent({
      caseId: row.case_id,
      eventType: 'option_deprecated',
      fromStatus: row.status,
      toStatus: row.status,
      actorId,
      actorRole,
      payload: { option_key: optionKey },
      occurredAt: now
    })
    return hydrateCase(row.case_id)
  })

  const addCaseEvidenceTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    if (row.status === 'closed') throw new Error('case_closed_immutable')
    const { actorId, actorRole } = assertActor(input?.recordedBy, input?.actorRole ?? 'auditor')
    if (typeof input?.sourceType !== 'string' || !VALID_SOURCE_TYPES.has(input.sourceType)) {
      throw new Error('case_evidence_source_type_invalid')
    }
    const sourceRepo = input?.sourceRepo === undefined
      ? ''
      : assertWellFormedString(input.sourceRepo, 'case_evidence_source_repo_invalid').trim()
    if (sourceRepo.includes('\r') || sourceRepo.includes('\n')) throw new Error('case_invalid_control_char')
    const sourceRef = normalizeSingleLineTrimmed(input?.sourceRef, 'case_evidence_source_ref_required', 500)
    const summary = assertWellFormedString(input?.summary, 'case_evidence_summary_required').replace(/\r\n?/g, '\n')
    if (!summary.trim() || summary.length > 4000) throw new Error('case_evidence_summary_required')
    const observedAt = assertIsoTimestamp(input?.observedAt, 'case_evidence_observed_at_invalid')

    const hashStatus = input?.hashStatus
    if (typeof hashStatus !== 'string' || !VALID_HASH_STATUSES.has(hashStatus)) {
      throw new Error('case_evidence_hash_status_invalid')
    }

    let artifactSha256 = input?.artifactSha256 ?? null
    if (artifactSha256 !== null) {
      artifactSha256 = assertSingleLineExact(artifactSha256, 'case_evidence_sha256_invalid', 64)
      if (!SHA256_HEX_PATTERN.test(artifactSha256)) throw new Error('case_evidence_sha256_invalid')
    }
    if ((hashStatus === 'unhashed' || hashStatus === 'not_applicable') && artifactSha256 !== null) {
      throw new Error('case_evidence_hash_status_invalid')
    }
    if ((hashStatus === 'verified' || hashStatus === 'unverified_claimed') && artifactSha256 === null) {
      throw new Error('case_evidence_sha256_invalid')
    }

    const baseMeta = input?.metadata === undefined ? {} : input.metadata
    if (!baseMeta || typeof baseMeta !== 'object' || Array.isArray(baseMeta)) {
      throw new Error('case_evidence_metadata_invalid')
    }
    const metadata = { ...baseMeta }

    // C3: verified hash requires accessible artifact bytes verified by the Case Registry itself.
    if (hashStatus === 'verified') {
      let bytes = null
      if (input?.artifactBytes !== undefined) {
        if (!Buffer.isBuffer(input.artifactBytes) && !(input.artifactBytes instanceof Uint8Array)) {
          throw new Error('case_evidence_verification_source_invalid')
        }
        if (input.artifactBytes.byteLength > MAX_EVIDENCE_VERIFY_BYTES) {
          throw new Error('case_evidence_verify_file_too_large')
        }
        bytes = Buffer.from(input.artifactBytes)
      } else if (input?.verifyFilePath !== undefined && input.verifyFilePath !== null) {
        bytes = readVerifiedFileBytes(input.verifyFilePath)
      } else {
        throw new Error('case_evidence_verification_source_required')
      }
      const computedHex = createHash('sha256').update(bytes).digest('hex')
      const matches = timingSafeEqual(Buffer.from(computedHex, 'hex'), Buffer.from(artifactSha256, 'hex'))
      if (!matches) throw new Error('case_evidence_sha256_mismatch')
      metadata.verified_bytes = bytes.byteLength
    }

    const trustNote = input?.trustNote === undefined
      ? DEFAULT_TRUST_NOTE
      : normalizeSingleLineTrimmed(input.trustNote, 'case_evidence_trust_note_invalid', 500)
    const now = new Date(clock()).toISOString()
    const evidenceId = randomUUID()
    prep('insertEvidence', `
      INSERT INTO case_evidence
        (evidence_id, case_id, source_type, source_repo, source_ref, summary, artifact_sha256, hash_status, authority_level, trust_note, observed_at, recorded_by, recorded_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'informational', ?, ?, ?, ?, ?)
    `).run(
      evidenceId,
      row.case_id,
      input.sourceType,
      sourceRepo,
      sourceRef,
      summary,
      artifactSha256,
      hashStatus,
      trustNote,
      observedAt,
      actorId,
      now,
      JSON.stringify(metadata)
    )
    appendEvent({
      caseId: row.case_id,
      eventType: 'evidence_added',
      fromStatus: row.status,
      toStatus: row.status,
      actorId,
      actorRole,
      payload: { evidence_id: evidenceId, source_type: input.sourceType, hash_status: hashStatus },
      occurredAt: now
    })
    return { case: hydrateCase(row.case_id), evidence_id: evidenceId }
  })

  const addCaseDiscussionTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    if (row.status === 'closed') throw new Error('case_closed_immutable')
    const { actorId, actorRole } = assertActor(input?.authorId, input?.authorRole)
    if (typeof input?.entryType !== 'string' || !VALID_ENTRY_TYPES.has(input.entryType)) {
      throw new Error('case_discussion_entry_type_invalid')
    }
    const body = assertWellFormedString(input?.body, 'case_discussion_body_required').replace(/\r\n?/g, '\n')
    if (!body.trim() || body.length > 8000) throw new Error('case_discussion_body_required')
    const evidenceRefs = assertStringArray(input?.evidenceRefs, 'case_discussion_evidence_refs_invalid')
    for (const refId of evidenceRefs) {
      const exists = prep(
        'getEvidenceById',
        'SELECT evidence_id FROM case_evidence WHERE case_id = ? AND evidence_id = ?'
      ).get(row.case_id, refId)
      if (!exists) throw new Error('case_evidence_ref_not_found')
    }
    const now = new Date(clock()).toISOString()
    const entryId = randomUUID()
    prep('insertDiscussion', `
      INSERT INTO case_discussion
        (entry_id, case_id, author_id, author_role, entry_type, body, evidence_refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entryId, row.case_id, actorId, actorRole, input.entryType, body, JSON.stringify(evidenceRefs), now)
    appendEvent({
      caseId: row.case_id,
      eventType: 'discussion_added',
      fromStatus: row.status,
      toStatus: row.status,
      actorId,
      actorRole,
      payload: { entry_id: entryId, entry_type: input.entryType },
      occurredAt: now
    })
    return { case: hydrateCase(row.case_id), entry_id: entryId }
  })

  const setCaseRecommendationTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    const expectedVersion = assertVersion(input?.expectedVersion)
    if (!PRE_DECISION_STATUSES.has(row.status)) {
      throw new Error('case_recommendation_not_allowed_in_status')
    }
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')
    const optionKey = assertSingleLineExact(input?.optionKey, 'case_option_key_invalid', 32)
    const option = prep(
      'getActiveOption',
      'SELECT option_key FROM case_options WHERE case_id = ? AND option_key = ? AND deprecated_at IS NULL'
    ).get(row.case_id, optionKey)
    if (!option) throw new Error('case_option_not_found_or_deprecated')
    const rationale = assertWellFormedString(input?.rationale, 'case_recommendation_rationale_required')
      .replace(/\r\n?/g, '\n')
    if (!rationale.trim() || rationale.length > 4000) throw new Error('case_recommendation_rationale_required')
    const now = new Date(clock()).toISOString()
    const updated = prep('updateRecommendation', `
      UPDATE cases
      SET recommendation_option_key = ?, recommendation_rationale = ?, recommended_by = ?, recommended_at = ?,
          version = version + 1, updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(optionKey, rationale, actorId, now, now, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    appendEvent({
      caseId: row.case_id,
      eventType: 'recommendation_set',
      fromStatus: row.status,
      toStatus: row.status,
      actorId,
      actorRole,
      payload: { option_key: optionKey },
      occurredAt: now
    })
    return hydrateCase(row.case_id)
  })

  const transitionCaseTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    const toStatus = input?.toStatus
    if (toStatus === 'decided') throw new Error('case_transition_use_decide_operation')
    if (toStatus === 'promoted') throw new Error('case_transition_use_promote_operation')
    if (row.status === 'decided' && toStatus === 'discussing') {
      throw new Error('case_transition_use_reopen_operation')
    }
    if (typeof toStatus !== 'string' || !VALID_STATUSES.has(toStatus)) {
      throw new Error('case_status_invalid')
    }
    const expectedVersion = assertVersion(input?.expectedVersion)
    const allowed = TRANSITION_ALLOWLIST[row.status]
    if (!allowed || !allowed.has(toStatus)) {
      throw new Error('case_transition_not_allowed')
    }
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const requiresOperatorAndRationale =
      row.status === 'deferred' || toStatus === 'deferred' || toStatus === 'rejected' || toStatus === 'closed'
    const rationale = input?.rationale === undefined
      ? ''
      : assertWellFormedString(input.rationale, 'case_transition_rationale_invalid').replace(/\r\n?/g, '\n')
    if (requiresOperatorAndRationale) {
      if (actorRole !== 'operator') throw new Error('case_transition_operator_required')
      if (!rationale.trim()) throw new Error('case_transition_rationale_required')
    }

    if (toStatus === 'decision_ready') {
      if (!row.problem_statement || !row.problem_statement.trim()) {
        throw new Error('case_decision_ready_requires_problem_statement')
      }
      const activeOptionsCount = prep(
        'countActiveOptions',
        'SELECT count(*) AS count FROM case_options WHERE case_id = ? AND deprecated_at IS NULL'
      ).get(row.case_id).count
      if (activeOptionsCount < 2) throw new Error('case_decision_ready_requires_two_options')
      const evidenceCount = prep(
        'countEvidence',
        'SELECT count(*) AS count FROM case_evidence WHERE case_id = ?'
      ).get(row.case_id).count
      if (evidenceCount < 1) throw new Error('case_decision_ready_requires_evidence')
    }

    const now = new Date(clock()).toISOString()
    const updated = prep('updateCaseStatus', `
      UPDATE cases SET status = ?, version = version + 1, updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(toStatus, now, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    const eventType = ['deferred', 'rejected', 'closed'].includes(toStatus) ? toStatus : 'status_changed'
    appendEvent({
      caseId: row.case_id,
      eventType,
      fromStatus: row.status,
      toStatus,
      actorId,
      actorRole,
      payload: rationale.trim() ? { rationale } : {},
      occurredAt: now
    })
    return hydrateCase(row.case_id)
  })

  const decideCaseTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    if (actorRole !== 'operator') throw new Error('case_decision_operator_required')
    const selectedOption = assertSingleLineExact(input?.selectedOption, 'case_option_key_invalid', 32)
    const decisionRationale = assertWellFormedString(input?.decisionRationale, 'case_decision_rationale_required')
      .replace(/\r\n?/g, '\n')
    if (!decisionRationale.trim() || decisionRationale.length > 4000) {
      throw new Error('case_decision_rationale_required')
    }
    const decisionAuthRef = normalizeSingleLineTrimmed(
      input?.decisionAuthorizationRef,
      'case_decision_authorization_ref_required',
      500
    )
    const idempotencyKey = assertSingleLineExact(
      input?.idempotencyKey,
      'case_decision_idempotency_key_required',
      128
    )
    const expectedVersion = assertVersion(input?.expectedVersion)

    if (row.decision_idempotency_key === idempotencyKey && (row.status === 'decided' || row.status === 'promoted')) {
      if (
        row.selected_option_key === selectedOption &&
        row.decision_rationale === decisionRationale &&
        row.decision_authorization_ref === decisionAuthRef &&
        row.decided_by === actorId
      ) {
        return { case: hydrateCase(row.case_id), replayed: true }
      }
      throw new Error('case_decision_idempotency_conflict')
    }

    if (prep('eventByIdemKey', 'SELECT event_id FROM case_events WHERE idempotency_key = ?').get(idempotencyKey)) {
      throw new Error('case_decision_idempotency_conflict')
    }
    if (prep('decisionByIdemKey', 'SELECT case_id FROM cases WHERE decision_idempotency_key = ?').get(idempotencyKey)) {
      throw new Error('case_decision_idempotency_conflict')
    }
    if (row.status === 'promoted' || hasPromotions(row.case_id)) {
      throw new Error('case_already_promoted_immutable')
    }
    if (row.status !== 'decision_ready') throw new Error('case_not_decision_ready')
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const option = prep(
      'getActiveOption',
      'SELECT option_key FROM case_options WHERE case_id = ? AND option_key = ? AND deprecated_at IS NULL'
    ).get(row.case_id, selectedOption)
    if (!option) throw new Error('case_option_not_found_or_deprecated')

    const now = new Date(clock()).toISOString()
    const updated = prep('decideCase', `
      UPDATE cases
      SET status = 'decided',
          selected_option_key = ?,
          decision_rationale = ?,
          decided_by = ?,
          decided_at = ?,
          decision_authorization_ref = ?,
          decision_idempotency_key = ?,
          version = version + 1,
          updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(
      selectedOption,
      decisionRationale,
      actorId,
      now,
      decisionAuthRef,
      idempotencyKey,
      now,
      row.case_id,
      expectedVersion
    )
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    appendEvent({
      caseId: row.case_id,
      eventType: 'decided',
      fromStatus: 'decision_ready',
      toStatus: 'decided',
      actorId,
      actorRole,
      authorizationRef: decisionAuthRef,
      idempotencyKey,
      payload: { selected_option: selectedOption },
      occurredAt: now
    })
    return { case: hydrateCase(row.case_id), replayed: false }
  })

  const reopenCaseTx = connection.transaction((input) => {
    const row = getCaseRowOrThrow(input?.caseId)
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    if (actorRole !== 'operator') throw new Error('case_reopen_operator_required')
    const rationale = assertWellFormedString(input?.rationale, 'case_reopen_rationale_required')
      .replace(/\r\n?/g, '\n')
    if (!rationale.trim() || rationale.length > 4000) throw new Error('case_reopen_rationale_required')
    const expectedVersion = assertVersion(input?.expectedVersion)

    if (row.status === 'promoted' || hasPromotions(row.case_id)) {
      throw new Error('case_already_promoted_immutable')
    }
    if (row.status !== 'decided') throw new Error('case_not_decided')
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const now = new Date(clock()).toISOString()
    const updated = prep('reopenCase', `
      UPDATE cases
      SET status = 'discussing',
          selected_option_key = NULL,
          decision_rationale = NULL,
          decided_by = NULL,
          decided_at = NULL,
          decision_authorization_ref = NULL,
          decision_idempotency_key = NULL,
          version = version + 1,
          updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(now, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')
    appendEvent({
      caseId: row.case_id,
      eventType: 'reopened',
      fromStatus: 'decided',
      toStatus: 'discussing',
      actorId,
      actorRole,
      payload: {
        rationale,
        previous_decision: {
          selected_option: row.selected_option_key,
          decision_rationale: row.decision_rationale,
          decided_by: row.decided_by,
          decided_at: row.decided_at,
          decision_authorization_ref: row.decision_authorization_ref,
          decision_idempotency_key: row.decision_idempotency_key
        }
      },
      occurredAt: now
    })
    return hydrateCase(row.case_id)
  })

  const promoteCaseTx = connection.transaction((input) => {
    const { actorId, actorRole } = assertActor(input?.actorId, input?.actorRole)
    if (actorRole !== 'operator') throw new Error('case_promotion_operator_required')

    const idempotencyKey = assertSingleLineExact(
      input?.idempotencyKey,
      'case_promotion_idempotency_key_required',
      128,
      {
        whitespaceCode: 'case_promotion_idempotency_key_invalid',
        controlCode: 'case_promotion_invalid_control_char',
        unicodeCode: 'case_promotion_invalid_unicode'
      }
    )
    const row = getCaseRowOrThrow(input?.caseId)
    const managed = isManagedProject(row.project_id)

    // Idempotent batch replay check runs before version/status gates so safe retries succeed after promoted=true.
    const existingBatch = prep(
      'promotionsByBatchKey',
      'SELECT * FROM case_promotions WHERE batch_idempotency_key = ? ORDER BY task_index ASC'
    ).all(idempotencyKey)
    if (existingBatch.length > 0) {
      if (existingBatch[0].case_id !== row.case_id) {
        throw new Error('case_promotion_idempotency_conflict')
      }
      const replayExpectedGeneration = assertPromotionExpectedGeneration(managed, input?.expectedGeneration)
      const normalized = normalizePromotionPayload({
        case_id: row.case_id,
        project_id: row.project_id,
        selected_option_key: existingBatch[0].selected_option_key,
        authorization_ref: input?.authorizationRef,
        expected_generation: replayExpectedGeneration,
        tasks: input?.tasks
      })
      const { sha256 } = fingerprintPromotionPayload(normalized)
      if (existingBatch[0].request_sha256 !== sha256) {
        throw new Error('case_promotion_idempotency_conflict')
      }
      return {
        ...CASE_AUTHORITY,
        case_id: row.case_id,
        batch_id: existingBatch[0].batch_id,
        batch_idempotency_key: existingBatch[0].batch_idempotency_key,
        request_sha256: existingBatch[0].request_sha256,
        authorization_ref: existingBatch[0].authorization_ref,
        promoted_by: existingBatch[0].promoted_by,
        promoted_at: existingBatch[0].promoted_at,
        records: existingBatch.map(toPromotionRecord),
        replayed: true
      }
    }

    // R2: decision and promotion must use distinct idempotency keys.
    if (
      row.decision_idempotency_key === idempotencyKey ||
      prep(
        'decidedEventByIdemKey',
        "SELECT event_id FROM case_events WHERE case_id = ? AND event_type = 'decided' AND idempotency_key = ?"
      ).get(row.case_id, idempotencyKey)
    ) {
      throw new Error('case_promotion_requires_distinct_idempotency_key')
    }
    if (prep('eventByIdemKey', 'SELECT event_id FROM case_events WHERE idempotency_key = ?').get(idempotencyKey)) {
      throw new Error('case_promotion_idempotency_conflict')
    }

    if (row.status === 'promoted' || hasPromotions(row.case_id)) {
      throw new Error('case_already_promoted_immutable')
    }
    if (row.status !== 'decided') throw new Error('case_not_decided')

    const expectedVersion = assertVersion(input?.expectedVersion)
    if (row.version !== expectedVersion) throw new Error('case_version_conflict')

    const option = prep(
      'getOptionFull',
      'SELECT * FROM case_options WHERE case_id = ? AND option_key = ?'
    ).get(row.case_id, row.selected_option_key)
    if (!option) throw new Error('case_option_not_found')

    // R3: Options requiring a separate governance mechanism can be decided, never promoted here.
    if (option.governance_mode === 'requires_separate_governance_mechanism') {
      throw new Error('case_option_requires_separate_governance_mechanism')
    }
    // C2: Enforce all three expected_task_count modes.
    if (option.governance_mode === 'no_task_required' || option.expected_task_count === 'none') {
      throw new Error('case_option_no_task_promotion')
    }
    if (!Array.isArray(input?.tasks)) throw new Error('case_promotion_tasks_invalid')
    if (option.expected_task_count === 'one' && input.tasks.length !== 1) {
      throw new Error('case_option_task_count_mismatch')
    }
    if (
      option.expected_task_count === 'multiple' &&
      (input.tasks.length < 2 || input.tasks.length > MAX_PROMOTION_BATCH_TASKS)
    ) {
      throw new Error('case_option_task_count_mismatch')
    }

    const expectedGeneration = assertPromotionExpectedGeneration(managed, input?.expectedGeneration)

    // Single C5 normalization pipeline builds the exact payload used for BOTH hashing and persistence.
    const normalized = normalizePromotionPayload({
      case_id: row.case_id,
      project_id: row.project_id,
      selected_option_key: row.selected_option_key,
      authorization_ref: input?.authorizationRef,
      expected_generation: expectedGeneration,
      tasks: input.tasks
    })

    // R6: Cross-project promotion is disabled in Phase 1.
    for (const taskPayload of normalized.tasks) {
      if (taskPayload.project !== row.project_id) {
        throw new Error('case_promotion_cross_project_disabled')
      }
    }

    const { sha256: requestSha256 } = fingerprintPromotionPayload(normalized)
    const createdEntries = []

    if (managed) {
      if (row.project_id !== 'curl-ai-bridge') {
        throw new Error('case_promotion_managed_bootstrap_unsupported')
      }
      if (typeof registerTaskAtCurrentGeneration !== 'function') {
        throw new Error('case_promotion_bootstrap_unavailable')
      }
      for (let index = 0; index < normalized.tasks.length; index += 1) {
        const itemIdempotencyKey = `${idempotencyKey}#${index}`
        const reg = registerTaskAtCurrentGeneration({
          task: normalized.tasks[index],
          authorizationRef: normalized.authorization_ref,
          idempotencyKey: itemIdempotencyKey,
          expectedGeneration: normalized.expected_generation
        })
        if (reg.replayed) {
          throw new Error('case_promotion_bootstrap_key_collision')
        }
        createdEntries.push({
          taskIndex: index,
          taskId: reg.taskId,
          projectId: normalized.tasks[index].project,
          registrationMode: 'current_generation_bootstrap',
          fencingGeneration: reg.fencingGeneration,
          bootstrapEventId: reg.eventId,
          itemIdempotencyKey
        })
      }
    } else {
      if (!tasks || typeof tasks.createTask !== 'function') {
        throw new Error('case_promotion_tasks_store_unavailable')
      }
      for (let index = 0; index < normalized.tasks.length; index += 1) {
        const itemIdempotencyKey = `${idempotencyKey}#${index}`
        const created = tasks.createTask(normalized.tasks[index])
        createdEntries.push({
          taskIndex: index,
          taskId: created.id,
          projectId: normalized.tasks[index].project,
          registrationMode: 'direct_unmanaged_task',
          fencingGeneration: null,
          bootstrapEventId: null,
          itemIdempotencyKey
        })
      }
    }

    const batchId = randomUUID()
    const promotedAt = new Date(clock()).toISOString()
    const insertPromotionStmt = prep('insertPromotion', `
      INSERT INTO case_promotions
        (promotion_id, batch_id, case_id, selected_option_key, task_index, task_id, project_id, registration_mode, fencing_generation, bootstrap_event_id, authorization_ref, batch_idempotency_key, item_idempotency_key, request_sha256, promoted_by, promoted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const entry of createdEntries) {
      insertPromotionStmt.run(
        randomUUID(),
        batchId,
        row.case_id,
        normalized.selected_option_key,
        entry.taskIndex,
        entry.taskId,
        entry.projectId,
        entry.registrationMode,
        entry.fencingGeneration,
        entry.bootstrapEventId,
        normalized.authorization_ref,
        idempotencyKey,
        entry.itemIdempotencyKey,
        requestSha256,
        actorId,
        promotedAt
      )
    }

    appendEvent({
      caseId: row.case_id,
      eventType: 'promotion_recorded',
      fromStatus: 'decided',
      toStatus: 'promoted',
      actorId,
      actorRole,
      authorizationRef: normalized.authorization_ref,
      idempotencyKey,
      payload: {
        batch_id: batchId,
        request_sha256: requestSha256,
        task_ids: createdEntries.map((item) => item.taskId)
      },
      occurredAt: promotedAt
    })

    const updated = prep('promoteCase', `
      UPDATE cases SET status = 'promoted', version = version + 1, updated_at = ?
      WHERE case_id = ? AND version = ?
    `).run(promotedAt, row.case_id, expectedVersion)
    if (updated.changes !== 1) throw new Error('case_version_conflict')

    const records = prep(
      'promotionsByBatchKey',
      'SELECT * FROM case_promotions WHERE batch_idempotency_key = ? ORDER BY task_index ASC'
    ).all(idempotencyKey).map(toPromotionRecord)

    return {
      ...CASE_AUTHORITY,
      case_id: row.case_id,
      batch_id: batchId,
      batch_idempotency_key: idempotencyKey,
      request_sha256: requestSha256,
      authorization_ref: normalized.authorization_ref,
      promoted_by: actorId,
      promoted_at: promotedAt,
      records,
      replayed: false
    }
  })

  return {
    createCase(input) {
      return createCaseTx.immediate(input)
    },
    listCases({ projectId, status } = {}) {
      const clauses = []
      const params = []
      if (projectId !== undefined) {
        clauses.push('project_id = ?')
        params.push(assertSingleLineExact(projectId, 'case_project_id_invalid', 100))
      }
      if (status !== undefined) {
        if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
          throw new Error('case_status_invalid')
        }
        clauses.push('status = ?')
        params.push(status)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = connection
        .prepare(`SELECT case_id FROM cases ${where} ORDER BY updated_at DESC, case_id ASC`)
        .all(...params)
      return rows.map((row) => hydrateCase(row.case_id))
    },
    getCase(caseId) {
      const id = assertValidCaseId(caseId)
      return hydrateCase(id)
    },
    exportCase(caseId) {
      const id = assertValidCaseId(caseId)
      return hydrateCase(id)
    },
    listCaseEvents(caseId) {
      const row = getCaseRowOrThrow(caseId)
      return prep(
        'listEvents',
        'SELECT * FROM case_events WHERE case_id = ? ORDER BY occurred_at ASC, event_id ASC'
      ).all(row.case_id).map((event) => ({
        event_id: event.event_id,
        case_id: event.case_id,
        event_type: event.event_type,
        from_status: event.from_status,
        to_status: event.to_status,
        actor_id: event.actor_id,
        actor_role: event.actor_role,
        authorization_ref: event.authorization_ref,
        idempotency_key: event.idempotency_key,
        payload: JSON.parse(event.payload_json),
        occurred_at: event.occurred_at
      }))
    },
    addCaseOption(input) {
      return addCaseOptionTx.immediate(input)
    },
    deprecateCaseOption(input) {
      return deprecateCaseOptionTx.immediate(input)
    },
    addCaseEvidence(input) {
      return addCaseEvidenceTx.immediate(input)
    },
    addCaseDiscussion(input) {
      return addCaseDiscussionTx.immediate(input)
    },
    setCaseRecommendation(input) {
      return setCaseRecommendationTx.immediate(input)
    },
    transitionCase(input) {
      return transitionCaseTx.immediate(input)
    },
    decideCase(input) {
      return decideCaseTx.immediate(input)
    },
    reopenCase(input) {
      return reopenCaseTx.immediate(input)
    },
    promoteCase(input) {
      return promoteCaseTx.immediate(input)
    }
  }
}

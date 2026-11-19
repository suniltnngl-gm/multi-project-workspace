import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const SWARM_PLAN_VERSION = 'swarm-plan-v1'
export const REQUIRED_PLAN_SECTIONS = Object.freeze([
  'planningEvidence',
  'acceptanceCriteria',
  'dependencies',
  'allowlist',
  'protectedExclusions',
  'reversibilityAndBudget',
  'verificationPlan'
])

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue(value[key])
    }
    return out
  }
  return value
}

export function computeReadinessFingerprint({ taskId, actor, plan }) {
  const payload = JSON.stringify(canonicalValue({ taskId, actor: actor.trim(), plan }))
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonEmptySection(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function defaultEvidenceChecker(ref, baseDir) {
  if (typeof ref === 'string') {
    if (!ref.trim()) return false
    const target = isAbsolute(ref) ? ref : (baseDir ? resolve(baseDir, ref) : ref)
    return existsSync(target)
  }
  if (ref && typeof ref === 'object' && isNonEmptyString(ref.path)) {
    const target = isAbsolute(ref.path) ? ref.path : (baseDir ? resolve(baseDir, ref.path) : ref.path)
    return existsSync(target)
  }
  return false
}

export function validateSwarmPlanRecord(plan, { currentAnchors, evidenceChecker = defaultEvidenceChecker, baseDir } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('task_readiness_plan_required')
  }
  if (plan.version !== SWARM_PLAN_VERSION) {
    throw new Error('task_readiness_plan_version_invalid')
  }
  if (plan.reviewed !== true) {
    throw new Error('task_readiness_plan_not_reviewed')
  }
  if (!isNonEmptyString(plan.reviewer)) {
    throw new Error('task_readiness_reviewer_required')
  }

  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!isNonEmptySection(plan[section])) {
      throw new Error(`task_readiness_section_missing:${section}`)
    }
  }

  if (!Array.isArray(plan.evidenceRefs) || plan.evidenceRefs.length === 0) {
    throw new Error('task_readiness_evidence_required')
  }
  for (const ref of plan.evidenceRefs) {
    const label = typeof ref === 'string' ? ref : (ref && typeof ref === 'object' ? ref.path : String(ref))
    if (!isNonEmptyString(label) || !evidenceChecker(ref, baseDir)) {
      throw new Error(`task_readiness_evidence_missing:${label || 'unknown'}`)
    }
  }

  if (!Array.isArray(plan.repositoryAnchors) || plan.repositoryAnchors.length === 0) {
    throw new Error('task_readiness_anchors_required')
  }
  const anchorMap = new Map()
  if (Array.isArray(currentAnchors)) {
    for (const anchor of currentAnchors) {
      if (anchor && Number.isInteger(anchor.repositoryId)) {
        anchorMap.set(anchor.repositoryId, anchor)
      }
    }
  } else if (currentAnchors instanceof Map) {
    for (const [k, v] of currentAnchors.entries()) {
      anchorMap.set(k, v)
    }
  }

  for (const anchor of plan.repositoryAnchors) {
    if (!anchor || !Number.isInteger(anchor.repositoryId) || !isNonEmptyString(anchor.headCommit)) {
      throw new Error('task_readiness_anchor_invalid')
    }
    if (anchorMap.size > 0) {
      const current = anchorMap.get(anchor.repositoryId)
      if (!current) {
        throw new Error(`task_readiness_anchor_unknown:${anchor.repositoryId}`)
      }
      if (current.headCommit !== anchor.headCommit) {
        throw new Error(`task_readiness_anchor_stale:${anchor.repositoryId}`)
      }
      if (isNonEmptyString(anchor.branch) && isNonEmptyString(current.branch) && current.branch !== anchor.branch) {
        throw new Error(`task_readiness_anchor_branch_stale:${anchor.repositoryId}`)
      }
    }
  }

  return {
    version: SWARM_PLAN_VERSION,
    reviewed: true,
    reviewer: plan.reviewer.trim(),
    evidenceCount: plan.evidenceRefs.length,
    repositoryAnchors: plan.repositoryAnchors.map((a) => ({
      repositoryId: a.repositoryId,
      headCommit: a.headCommit.trim(),
      ...(isNonEmptyString(a.branch) ? { branch: a.branch.trim() } : {})
    }))
  }
}

export function createTaskReadinessStore(connection, { clock = () => Date.now(), evidenceChecker = defaultEvidenceChecker } = {}) {
  const recordTxn = connection.transaction((input) => {
    const {
      taskId,
      expectedUpdatedAt,
      idempotencyKey,
      actor,
      plan,
      currentAnchors,
      baseDir
    } = input ?? {}

    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      throw new Error('task_readiness_task_id_invalid')
    }
    if (!isNonEmptyString(expectedUpdatedAt)) {
      throw new Error('task_readiness_expected_updated_at_required')
    }
    if (!isNonEmptyString(idempotencyKey)) {
      throw new Error('task_readiness_idempotency_key_required')
    }
    if (!isNonEmptyString(actor)) {
      throw new Error('task_readiness_actor_required')
    }

    const normalizedKey = idempotencyKey.trim()
    const eventField = `${SWARM_PLAN_VERSION}:${normalizedKey}`

    const validatedPlan = validateSwarmPlanRecord(plan, {
      currentAnchors,
      evidenceChecker,
      baseDir
    })
    const payloadHash = computeReadinessFingerprint({ taskId, actor, plan })

    const existingEvent = connection.prepare(`
      SELECT id, task_id, new_value, created_at
      FROM task_events
      WHERE task_id = ? AND action = 'readiness_recorded' AND field = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(taskId, eventField)

    if (existingEvent) {
      let parsed = {}
      try {
        parsed = JSON.parse(existingEvent.new_value || '{}')
      } catch {
        parsed = {}
      }
      if (!parsed.payloadHash || parsed.payloadHash !== payloadHash) {
        throw new Error('task_readiness_idempotency_conflict')
      }
      return {
        taskId,
        status: 'blocked',
        workBlockedPreserved: true,
        updatedAt: parsed.recordedAt || existingEvent.created_at,
        previousUpdatedAt: parsed.previousUpdatedAt || expectedUpdatedAt,
        idempotencyKey: normalizedKey,
        payloadHash,
        planVersion: SWARM_PLAN_VERSION,
        state: 'complete',
        disposition: 'ready_for_serialized_implementation',
        eventId: existingEvent.id,
        replayed: true,
        authorityGranted: false,
        leaseAcquired: false
      }
    }

    const task = connection.prepare(
      'SELECT id, status, work_blocked, important_context, updated_at FROM tasks WHERE id = ?'
    ).get(taskId)
    if (!task) {
      throw new Error('task_readiness_task_not_found')
    }
    if (task.status !== 'blocked') {
      throw new Error('task_readiness_task_not_blocked')
    }
    if (task.updated_at !== expectedUpdatedAt) {
      throw new Error('task_readiness_cas_conflict')
    }

    const now = new Date(clock()).toISOString()
    const marker = [
      `[${SWARM_PLAN_VERSION}]`,
      'state=complete',
      'disposition=ready_for_serialized_implementation',
      `idempotency_key=${normalizedKey}`,
      `reviewer=${validatedPlan.reviewer}`,
      `actor=${actor.trim()}`,
      `recorded_at=${now}`,
      'authority=none'
    ].join(' ')

    const priorContext = typeof task.important_context === 'string' ? task.important_context : ''
    const nextContext = priorContext.trim() ? `${priorContext.trimEnd()}\n${marker}` : marker

    const updateResult = connection.prepare(`
      UPDATE tasks
      SET important_context = ?, updated_at = ?
      WHERE id = ? AND updated_at = ? AND status = 'blocked'
    `).run(nextContext, now, taskId, expectedUpdatedAt)

    if (updateResult.changes !== 1) {
      throw new Error('task_readiness_cas_conflict')
    }

    const provenance = {
      planVersion: SWARM_PLAN_VERSION,
      state: 'complete',
      disposition: 'ready_for_serialized_implementation',
      idempotencyKey: normalizedKey,
      payloadHash,
      actor: actor.trim(),
      reviewer: validatedPlan.reviewer,
      previousUpdatedAt: expectedUpdatedAt,
      recordedAt: now,
      evidenceCount: validatedPlan.evidenceCount,
      repositoryAnchors: validatedPlan.repositoryAnchors,
      authorityGranted: false,
      leaseAcquired: false
    }

    const eventResult = connection.prepare(`
      INSERT INTO task_events (task_id, action, field, old_value, new_value, created_at)
      VALUES (?, 'readiness_recorded', ?, ?, ?, ?)
    `).run(taskId, eventField, priorContext, JSON.stringify(provenance), now)

    return {
      taskId,
      status: 'blocked',
      workBlockedPreserved: true,
      updatedAt: now,
      previousUpdatedAt: expectedUpdatedAt,
      idempotencyKey: normalizedKey,
      payloadHash,
      planVersion: SWARM_PLAN_VERSION,
      state: 'complete',
      disposition: 'ready_for_serialized_implementation',
      eventId: Number(eventResult.lastInsertRowid),
      replayed: false,
      authorityGranted: false,
      leaseAcquired: false
    }
  })

  function recordTaskReadiness(input) {
    return recordTxn.immediate(input)
  }

  return { recordTaskReadiness }
}

/**
 * AUTH-001 S1+S2 (#304) — Parent-Delegated Authorization Engine (Rev8), first slice.
 *
 * S1 — Protected authority state: the operator identity and its delegation schema
 * live in a single JSON document under the state root, written only through
 * `protectedWriteFile` (checksum-backed, atomic last-edit undoable). Fail closed:
 * a missing or corrupt authority file authorizes nobody.
 *
 * S2 — Mechanical authorization evaluator: a deterministic, zero-LLM policy check.
 * Given an action class and subject, returns { authorized, reason }. The operator
 * identity is authorized for everything; every other subject needs an active,
 * unexpired delegation whose actionClass and resourceScope cover the request.
 * No exceptions, no fuzzy matching, no LLM anywhere.
 */
import { existsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { protectedWriteFile } from './mutation-guard.js'
import { statePaths } from '../../../../../scripts/swarm-state-paths.mjs'

export const AUTHORITY_SCHEMA = 'auth-authority/v1'

export const ACTION_CLASSES = Object.freeze(['read', 'register', 'mutate', 'publish', 'admin'])
const CLASS_RANK = Object.freeze({ read: 0, register: 1, mutate: 2, publish: 3, admin: 4 })

/** Resolve the canonical authority state path under the state root. */
export function authorityStatePath(env = process.env) {
  return `${statePaths(env).root}/identity/authority-state.json`
}

/**
 * Load the authority state. Returns { ok: true, authority, path } or
 * { ok: false, reason, path }. Fail closed: missing/corrupt/mismatched-schema
 * state authorizes nobody.
 */
export function loadAuthorityState({ authorityPath = null, env = process.env, readFileImpl = fsReadFileSync } = {}) {
  const path = authorityPath || authorityStatePath(env)
  if (!path || !existsSync(path)) return { ok: false, reason: 'authority_state_missing', path }
  let doc = null
  try {
    doc = JSON.parse(readFileImpl(path, 'utf8'))
  } catch {
    return { ok: false, reason: 'authority_state_corrupt', path }
  }
  if (!doc || doc.schema !== AUTHORITY_SCHEMA) return { ok: false, reason: 'authority_state_schema_mismatch', path }
  if (!doc.operator || typeof doc.operator.id !== 'string' || !doc.operator.id.trim()) {
    return { ok: false, reason: 'authority_state_operator_missing', path }
  }
  return { ok: true, authority: doc, path }
}

/**
 * Bootstrap the operator identity (S1). Only succeeds when no authority state
 * exists yet — the operator bootstrap is a one-time, local, explicit act.
 * Every delegation references the operator id; there is no other root of trust.
 */
export function bootstrapOperator({ operatorId, authorityPath = null, env = process.env, delegations = [] } = {}) {
  const path = authorityPath || authorityStatePath(env)
  if (!operatorId || typeof operatorId !== 'string' || !operatorId.trim()) throw new Error('operator_id_required')
  if (existsSync(path)) throw new Error('authority_state_already_exists')
  const authority = {
    schema: AUTHORITY_SCHEMA,
    operator: { id: operatorId.trim(), bootstrappedAt: new Date().toISOString() },
    delegations
  }
  const written = protectedWriteFile(path, `${JSON.stringify(authority, null, 2)}\n`)
  return { ok: true, path, authority, backupPath: written.backupPath }
}

/**
 * Grant a delegation (S1 mutation, protected write). Delegation shape:
 * { subjectId, actionClass, resourceScope (string prefix; '*' = all), expiresAt (ISO) }.
 */
export function grantDelegation({ subjectId, actionClass, resourceScope = '*', expiresAt = null, authorityPath = null, env = process.env } = {}) {
  if (!subjectId || typeof subjectId !== 'string' || !subjectId.trim()) throw new Error('subject_id_required')
  if (!ACTION_CLASSES.includes(actionClass)) throw new Error(`invalid_action_class:${actionClass}`)
  const loaded = loadAuthorityState({ authorityPath, env })
  if (!loaded.ok) throw new Error(loaded.reason)
  const authority = loaded.authority
  authority.delegations = (Array.isArray(authority.delegations) ? authority.delegations : []).filter((d) => d.subjectId !== subjectId.trim())
  authority.delegations.push({
    subjectId: subjectId.trim(),
    actionClass,
    resourceScope: String(resourceScope || '*'),
    expiresAt,
    grantedAt: new Date().toISOString()
  })
  const written = protectedWriteFile(loaded.path, `${JSON.stringify(authority, null, 2)}\n`)
  return { ok: true, authority, backupPath: written.backupPath }
}

/**
 * S2 — mechanical authorization verdict. Deterministic; never throws.
 * Checks, in order: operator identity -> delegation existence -> action class
 * (ranked: granted class must cover the requested class) -> resource scope
 * (prefix match; '*' covers all) -> expiry (active at `now`).
 */
export function evaluateAuthorization({
  subjectId,
  actionClass = 'read',
  resource = null,
  now = new Date(),
  authorityPath = null,
  env = process.env,
  readFileImpl = fsReadFileSync
} = {}) {
  const loaded = loadAuthorityState({ authorityPath, env, readFileImpl })
  if (!loaded.ok) return { authorized: false, reason: loaded.reason, subjectId: subjectId || null }

  const subject = String(subjectId || '').trim()
  if (!subject) return { authorized: false, reason: 'subject_required', subjectId: null }

  // The operator is the root of trust: full authority, no expiry.
  if (subject === loaded.authority.operator.id) {
    return { authorized: true, reason: 'operator_identity', subjectId: subject, actionClass }
  }

  const requested = CLASS_RANK[actionClass] ?? -1
  if (requested < 0) return { authorized: false, reason: `invalid_action_class:${actionClass}`, subjectId: subject }

  const delegations = Array.isArray(loaded.authority.delegations) ? loaded.authority.delegations : []
  const match = delegations.find((d) => d.subjectId === subject)
  if (!match) return { authorized: false, reason: 'no_delegation', subjectId: subject, actionClass }

  const granted = CLASS_RANK[match.actionClass] ?? -1
  if (granted < requested) {
    return { authorized: false, reason: `action_class_insufficient:${match.actionClass}`, subjectId: subject, actionClass }
  }

  if (resource && match.resourceScope !== '*') {
    const scope = String(match.resourceScope || '')
    if (!resource.startsWith(scope)) {
      return { authorized: false, reason: 'resource_scope_mismatch', subjectId: subject, actionClass, resource }
    }
  }

  if (match.expiresAt) {
    const exp = Date.parse(match.expiresAt)
    const at = now instanceof Date ? now.getTime() : Date.parse(now)
    if (!Number.isFinite(exp) || at >= exp) {
      return { authorized: false, reason: 'delegation_expired', subjectId: subject, actionClass, expiresAt: match.expiresAt }
    }
  }

  return { authorized: true, reason: 'delegation_active', subjectId: subject, actionClass }
}

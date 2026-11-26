// AUTH-001 (Rev8) — Parent-Delegated Authorization Engine.
// Mechanical evaluator: decides, from a normalized delegation reference, whether
// a requested permission is granted. This is the rule ledger that the rest of the
// engine (authorityState, execution sessions, lease routing) consults.
//
// Reference shape (see schemas/authorization-reference.schema.json):
//   { ref, level, permissionClass, scope, source, provenanceClass, grantedBy, expiresAt }
// Level ordering (lower = lower privilege): A0 < A1 < A2.
// Permission class ordering (READ < PROPOSE < MUTATE).

export const VALID_LEVELS = ['A0', 'A1', 'A2'];
export const VALID_PERMISSION_CLASSES = ['READ', 'PROPOSE', 'MUTATE'];
export const VALID_SOURCES = ['operator', 'policy', 'system'];
export const VALID_PROVENANCE = ['authenticated', 'claimed_external', 'operator_direct', 'system'];

export const LEVEL_ORDER = { 'A0': 0, 'A1': 1, 'A2': 2 };
export const PC_ORDER = { 'READ': 0, 'PROPOSE': 1, 'MUTATE': 2 };

export function isValidLevel(level) {
  return VALID_LEVELS.includes(level);
}
export function isValidPermissionClass(pc) {
  return VALID_PERMISSION_CLASSES.includes(pc);
}
export function isValidSource(source) {
  return VALID_SOURCES.includes(source);
}
export function isValidProvenance(provenance) {
  return VALID_PROVENANCE.includes(provenance);
}

/**
 * Normalize (and validate) a raw delegation reference into a canonical shape.
 * Throws on structurally invalid input so callers fail closed.
 */
export function normalizeReference(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('authorization_reference_required');
  }
  const id = typeof ref.ref === 'string' ? ref.ref : '';
  if (id.length === 0) throw new Error('authorization_ref_required');
  if (!isValidLevel(ref.level)) throw new Error(`invalid_level:${String(ref.level)}`);
  if (!isValidPermissionClass(ref.permissionClass)) {
    throw new Error(`invalid_permission_class:${String(ref.permissionClass)}`);
  }
  if (!Array.isArray(ref.scope) || ref.scope.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new Error('scope_must_be_non_empty_array_of_strings');
  }
  if (!isValidSource(ref.source)) throw new Error(`invalid_source:${String(ref.source)}`);
  if (!isValidProvenance(ref.provenanceClass)) {
    throw new Error(`invalid_provenance:${String(ref.provenanceClass)}`);
  }
  return {
    ref: id,
    level: ref.level,
    permissionClass: ref.permissionClass,
    scope: ref.scope.slice(),
    source: ref.source,
    provenanceClass: ref.provenanceClass,
    grantedBy: typeof ref.grantedBy === 'string' ? ref.grantedBy : null,
    expiresAt: typeof ref.expiresAt === 'string' ? ref.expiresAt : null,
  };
}

/**
 * Evaluate whether a normalized reference grants a requested permission.
 *
 * Rules (in order):
 *   1. Requested level must not exceed the delegation's level.
 *   2. Requested permission class must not exceed the delegation's class.
 *   3. Every requested scope must be present in the delegation's scope.
 *   4. The reference must not be expired (expiresAt <= now fails).
 */
export function evaluate({
  ref,
  requestedLevel,
  requestedPermissionClass,
  requestedScope,
  nowMs = Date.now(),
}) {
  if (!ref || typeof ref !== 'object') return { allowed: false, reason: 'reference_required' };
  if (!isValidLevel(requestedLevel)) return { allowed: false, reason: 'invalid_requested_level' };
  if (!isValidPermissionClass(requestedPermissionClass)) {
    return { allowed: false, reason: 'invalid_requested_permission_class' };
  }
  if (!Array.isArray(requestedScope) || requestedScope.some((s) => typeof s !== 'string')) {
    return { allowed: false, reason: 'requested_scope_invalid' };
  }

  if (LEVEL_ORDER[requestedLevel] > LEVEL_ORDER[ref.level]) {
    return { allowed: false, reason: 'level_too_high' };
  }
  if (PC_ORDER[requestedPermissionClass] > PC_ORDER[ref.permissionClass]) {
    return { allowed: false, reason: 'permission_too_high' };
  }
  for (const s of requestedScope) {
    if (!ref.scope.includes(s)) return { allowed: false, reason: 'scope_not_granted' };
  }
  if (ref.expiresAt && nowMs > Date.parse(ref.expiresAt)) {
    return { allowed: false, reason: 'reference_expired' };
  }
  return { allowed: true, reason: 'granted' };
}

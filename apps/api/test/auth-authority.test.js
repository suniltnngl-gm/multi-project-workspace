import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTHORITY_SCHEMA,
  ACTION_CLASSES,
  authorityStatePath,
  loadAuthorityState,
  bootstrapOperator,
  grantDelegation,
  evaluateAuthorization,
  issueSupervisorSession,
  activeSupervisorSessions,
  authorizeThenAcquireLease,
  grantAuthorization,
  operatorAuthorizationGate
} from '../src/toolchain/dispatch/auth-authority.js'

function freshEnv() {
  const root = mkdtempSync(join(tmpdir(), 'auth001-'))
  return { root, env: { SWARM_STATE_DIR: root } }
}

test('S1: bootstrap is one-time, protected, and fail-closed afterwards', () => {
  const { root, env } = freshEnv()
  try {
    const path = authorityStatePath(env)
    assert.match(path, /identity\/authority-state\.json$/)
    assert.ok(!existsSync(path))

    // Fail closed before bootstrap: nothing is authorized.
    assert.equal(loadAuthorityState({ env }).ok, false)
    assert.equal(evaluateAuthorization({ subjectId: 'sibling-1', env }).authorized, false)

    const boot = bootstrapOperator({ operatorId: 'sunilkr', env })
    assert.equal(boot.ok, true)
    assert.ok(existsSync(path))
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema, AUTHORITY_SCHEMA)
    // Overwrites are protected: a delegation grant leaves a lean backup.
    grantDelegation({ subjectId: 'probe', actionClass: 'read', env })
    assert.ok(existsSync(path), 'state persisted through protected write')

    // One-time: a second bootstrap is refused.
    assert.throws(() => bootstrapOperator({ operatorId: 'other', env }), /already_exists/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S2: operator is the root of trust; delegations are ranked, scoped, expiring', () => {
  const { root, env } = freshEnv()
  try {
    bootstrapOperator({ operatorId: 'sunilkr', env })

    // Operator: authorized for everything, incl. admin.
    assert.equal(evaluateAuthorization({ subjectId: 'sunilkr', actionClass: 'admin', env }).authorized, true)
    assert.equal(evaluateAuthorization({ subjectId: 'sunilkr', actionClass: 'admin', env }).reason, 'operator_identity')

    // Unknown subject: no delegation, fail closed.
    const noDelegation = evaluateAuthorization({ subjectId: 'relay-agent', actionClass: 'mutate', env })
    assert.equal(noDelegation.authorized, false)
    assert.equal(noDelegation.reason, 'no_delegation')

    // Grant a read-only delegation scoped to a prefix.
    grantDelegation({ subjectId: 'relay-agent', actionClass: 'read', resourceScope: '/reports/', expiresAt: '2099-01-01T00:00:00Z', env })
    assert.equal(evaluateAuthorization({ subjectId: 'relay-agent', actionClass: 'read', resource: '/reports/x.json', env }).authorized, true)
    assert.equal(evaluateAuthorization({ subjectId: 'relay-agent', actionClass: 'read', resource: '/queue/x.json', env }).reason, 'resource_scope_mismatch')
    // Ranked classes: a read delegation does NOT cover mutate.
    assert.equal(evaluateAuthorization({ subjectId: 'relay-agent', actionClass: 'mutate', env }).reason, 'action_class_insufficient:read')

    // Expiry is enforced mechanically.
    grantDelegation({ subjectId: 'temp-agent', actionClass: 'register', expiresAt: '2020-01-01T00:00:00Z', env })
    const expired = evaluateAuthorization({ subjectId: 'temp-agent', actionClass: 'register', env })
    assert.equal(expired.authorized, false)
    assert.equal(expired.reason, 'delegation_expired')

    // '*' scope covers any resource.
    grantDelegation({ subjectId: 'supervisor', actionClass: 'admin', resourceScope: '*', env })
    assert.equal(evaluateAuthorization({ subjectId: 'supervisor', actionClass: 'admin', resource: '/anything/at/all', env }).authorized, true)

    // Re-grant replaces (no duplicate rows per subject).
    grantDelegation({ subjectId: 'relay-agent', actionClass: 'mutate', resourceScope: '*', env })
    const doc = JSON.parse(readFileSync(authorityStatePath(env), 'utf8'))
    assert.equal(doc.delegations.filter((d) => d.subjectId === 'relay-agent').length, 1)
    assert.equal(ACTION_CLASSES.length, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S2: corrupt or schema-mismatched authority state authorizes nobody', () => {
  const { root, env } = freshEnv()
  try {
    const path = authorityStatePath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'not json at all {{{')
    assert.equal(loadAuthorityState({ env }).reason, 'authority_state_corrupt')
    assert.equal(evaluateAuthorization({ subjectId: 'sunilkr', actionClass: 'admin', env }).authorized, false, 'even the operator id fails closed on corrupt state')

    writeFileSync(path, JSON.stringify({ schema: 'wrong/v9', operator: { id: 'sunilkr' } }))
    assert.equal(loadAuthorityState({ env }).reason, 'authority_state_schema_mismatch')
    assert.equal(evaluateAuthorization({ subjectId: 'sunilkr', actionClass: 'admin', env }).authorized, false)

    // Missing operator id inside an otherwise valid doc: fail closed.
    writeFileSync(path, JSON.stringify({ schema: AUTHORITY_SCHEMA, operator: {}, delegations: [] }))
    assert.equal(evaluateAuthorization({ subjectId: 'anyone', actionClass: 'read', env }).reason, 'authority_state_operator_missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S3: supervisor sessions — admin-gated issuance, mechanical expiry', () => {
  const { root, env } = freshEnv()
  try {
    bootstrapOperator({ operatorId: 'sunilkr', env })
    grantDelegation({ subjectId: 'overseer', actionClass: 'admin', env })

    // Unauthorized issuer: no session, fail closed.
    const denied = issueSupervisorSession({ subjectId: 'worker', issuedBy: 'mallory', env })
    assert.equal(denied.ok, false)
    assert.match(denied.reason, /issuer_unauthorized/)

    // Non-admin delegated subject cannot issue either.
    grantDelegation({ subjectId: 'reader', actionClass: 'read', env })
    assert.equal(issueSupervisorSession({ subjectId: 'worker', issuedBy: 'reader', env }).ok, false)

    // Operator-issued session is active then expires mechanically.
    // Fail closed: a subject with no delegation cannot be issued a session.
    assert.equal(issueSupervisorSession({ subjectId: 'ghost-worker', issuedBy: 'sunilkr', env }).ok, false)
    grantDelegation({ subjectId: 'worker', actionClass: 'mutate', env })
    const s1 = issueSupervisorSession({ subjectId: 'worker', actionClass: 'mutate', ttlMs: 1000, issuedBy: 'sunilkr', now: new Date('2026-01-01T00:00:00Z'), env })
    assert.equal(s1.ok, true)
    assert.match(s1.session.sessionId, /^sup-/)
    assert.equal(s1.session.issuedBy, 'sunilkr')

    const activeNow = activeSupervisorSessions({ now: new Date('2026-01-01T00:00:00.500Z'), env })
    assert.equal(activeNow.active.length, 1)
    assert.equal(activeNow.expiredCount, 0)
    const activeLater = activeSupervisorSessions({ now: new Date('2026-01-01T00:02:00Z'), env })
    assert.equal(activeLater.active.length, 0)
    assert.equal(activeLater.expiredCount, 1)

    // Admin-delegated subject can issue too (subject still needs its own delegation).
    grantDelegation({ subjectId: 'worker2', actionClass: 'mutate', env })
    const s2 = issueSupervisorSession({ subjectId: 'worker2', issuedBy: 'overseer', env })
    assert.equal(s2.ok, true)
    assert.equal(s2.session.issuedBy, 'overseer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S4: atomic auth-to-lease — denied subjects never reach the lease', async () => {
  const { root, env } = freshEnv()
  try {
    bootstrapOperator({ operatorId: 'sunilkr', env })
    let leaseCalls = 0
    const acquire = (verdict) => { leaseCalls++; return { ok: true, runId: 'lease-1' } }

    // Denied: acquire is never invoked.
    const denied = await authorizeThenAcquireLease({ subjectId: 'ghost', actionClass: 'mutate', acquire, env })
    assert.equal(denied.ok, false)
    assert.equal(denied.leaseAcquired, false)
    assert.equal(leaseCalls, 0, 'denied subject must not touch the lease')

    // Operator: verdict then lease in one atomic call.
    const granted = await authorizeThenAcquireLease({ subjectId: 'sunilkr', actionClass: 'mutate', resource: '/queue/x', acquire, env })
    assert.equal(granted.ok, true)
    assert.equal(granted.authorized, true)
    assert.equal(granted.leaseAcquired, true)
    assert.equal(granted.lease.runId, 'lease-1')
    assert.equal(leaseCalls, 1)

    // Scope check inside the bridge: wrong resource denies before acquire.
    grantDelegation({ subjectId: 'scoped', actionClass: 'mutate', resourceScope: '/reports/', env })
    const outOfScope = await authorizeThenAcquireLease({ subjectId: 'scoped', actionClass: 'mutate', resource: '/queue/y', acquire, env })
    assert.equal(outOfScope.authorized, false)
    assert.equal(leaseCalls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S5: operator authorization gate — recorded grant or no-go, mechanically', () => {
  const { root, env } = freshEnv()
  try {
    // No authority state: gate refuses.
    assert.equal(operatorAuthorizationGate({ action: 'implement:auth001', env }).authorized, false)

    bootstrapOperator({ operatorId: 'sunilkr', env })

    // Exceptional action without a recorded grant: no-go, even for the operator id.
    const noGrant = operatorAuthorizationGate({ action: 'implement:auth001', env })
    assert.equal(noGrant.authorized, false)
    assert.equal(noGrant.reason, 'operator_grant_required')

    // Non-operator cannot record a grant (fail closed).
    grantDelegation({ subjectId: 'clerk', actionClass: 'mutate', env })
    assert.equal(grantAuthorization({ action: 'x', grantedBy: 'clerk', env }).ok, false)

    // Operator records the grant; gate opens; resource scoping applies.
    assert.equal(grantAuthorization({ action: 'implement:auth001', grantedBy: 'sunilkr', env }).ok, true)
    const open = operatorAuthorizationGate({ action: 'implement:auth001', env })
    assert.equal(open.authorized, true)
    assert.equal(open.reason, 'operator_grant_active')
    assert.equal(operatorAuthorizationGate({ action: 'implement:other-thing', env }).authorized, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

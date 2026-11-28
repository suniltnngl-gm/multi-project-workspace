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
  evaluateAuthorization
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

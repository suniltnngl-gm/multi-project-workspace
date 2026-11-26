import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeReference,
  evaluate,
  isValidLevel,
  isValidPermissionClass,
  VALID_LEVELS,
  VALID_PERMISSION_CLASSES,
  LEVEL_ORDER,
} from '../src/authorityPolicy.js'

const now = Date.parse('2026-11-26T00:00:00.000Z')

function ref(overrides = {}) {
  return {
    ref: 'AUTH-REF-0001',
    level: 'A2',
    permissionClass: 'MUTATE',
    scope: ['reboot', 'deploy', 'config/rotate'],
    source: 'policy',
    provenanceClass: 'authenticated',
    grantedBy: 'parent-1',
    ...overrides,
  }
}

test('constants', () => {
  assert.equal(VALID_LEVELS.length, 3)
  assert.equal(VALID_PERMISSION_CLASSES.length, 3)
  assert.equal(LEVEL_ORDER.A0, 0)
  assert.equal(LEVEL_ORDER.A2, 2)
})

test('isValidLevel', () => {
  assert.equal(isValidLevel('A0'), true)
  assert.equal(isValidLevel('A2'), true)
  assert.equal(isValidLevel('A3'), false)
  assert.equal(isValidLevel('B0'), false)
})

test('isValidPermissionClass', () => {
  assert.equal(isValidPermissionClass('READ'), true)
  assert.equal(isValidPermissionClass('MUTATE'), true)
  assert.equal(isValidPermissionClass('WRITE'), false)
})

test('normalizeReference rejects invalid input and returns normalized', () => {
  assert.throws(() => normalizeReference(null), /authorization_reference_required/)
  assert.throws(() => normalizeReference({}), /ref|required/i)
  const out = normalizeReference(ref())
  assert.equal(out.level, 'A2')
  assert.equal(out.scope[0], 'reboot')
  assert.deepEqual(out.scope, ['reboot', 'deploy', 'config/rotate'])
})

test('evaluate: full delegation grants the requested permission', () => {
  const r = normalizeReference(ref({ level: 'A2', permissionClass: 'MUTATE' }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A1',
    requestedPermissionClass: 'PROPOSE',
    requestedScope: ['deploy'],
    nowMs: now,
  })
  assert.equal(got.allowed, true)
  assert.equal(got.reason, 'granted')
})

test('evaluate: requested level above delegation level is denied', () => {
  const r = normalizeReference(ref({ level: 'A1' }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A2',
    requestedPermissionClass: 'READ',
    requestedScope: ['reboot'],
    nowMs: now,
  })
  assert.equal(got.allowed, false)
  assert.equal(got.reason, 'level_too_high')
})

test('evaluate: requested permission class above delegation class is denied', () => {
  const r = normalizeReference(ref({ permissionClass: 'PROPOSE' }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A0',
    requestedPermissionClass: 'MUTATE',
    requestedScope: ['reboot'],
    nowMs: now,
  })
  assert.equal(got.allowed, false)
  assert.equal(got.reason, 'permission_too_high')
})

test('evaluate: scope not in delegation is denied', () => {
  const r = normalizeReference(ref({ scope: ['reboot', 'deploy'] }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A0',
    requestedPermissionClass: 'READ',
    requestedScope: ['config/rotate'],
    nowMs: now,
  })
  assert.equal(got.allowed, false)
  assert.equal(got.reason, 'scope_not_granted')
})

test('evaluate: expired reference is denied', () => {
  const r = normalizeReference(ref({ expiresAt: '2026-11-26T00:00:00.000Z' }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A0',
    requestedPermissionClass: 'READ',
    requestedScope: ['reboot'],
    nowMs: now + 1,
  })
  assert.equal(got.allowed, false)
  assert.equal(got.reason, 'reference_expired')
})

test('evaluate: non-expired reference is not rejected for expiry', () => {
  const r = normalizeReference(ref({ expiresAt: '2028-01-01T00:00:00.000Z' }))
  const got = evaluate({
    ref: r,
    requestedLevel: 'A0',
    requestedPermissionClass: 'READ',
    requestedScope: ['reboot'],
    nowMs: now,
  })
  assert.equal(got.allowed, true)
})

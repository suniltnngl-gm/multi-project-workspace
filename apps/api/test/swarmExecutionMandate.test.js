import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')
const mandatePath = join(root, 'docs/swarm-execution-mandate.md')
const schemaPath = join(root, 'schemas/swarm-execution-ledger.schema.json')

const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
const mandate = await readFile(mandatePath, 'utf8')

const requiredGateCriteria = [
  'planning_evidence_architecture',
  'acceptance_criteria',
  'dependencies_downstream',
  'exact_allowlist',
  'protected_exclusions',
  'reversibility_risk',
  'verification_plan'
]

function validGate(gate) {
  return gate?.version === 'swarm-plan-v1' &&
    gate.state === 'complete' &&
    gate.disposition === 'ready_for_serialized_implementation' &&
    Array.isArray(gate.records) &&
    gate.records.length === 7 &&
    new Set(gate.records.map((record) => record.criterion)).size === 7 &&
    requiredGateCriteria.every((criterion) => {
      const record = gate.records.find((item) => item.criterion === criterion)
      return record?.status === 'complete' && record.reviewed === true &&
        Array.isArray(record.evidence_refs) && record.evidence_refs.length > 0
    })
}

function createLeaseCoordinator() {
  let generation = 0
  let current = null
  return {
    acquire(identity, now = 1000, ttl = 100) {
      if (current && current.status === 'active' && current.expiresAt > now) {
        return { ok: false, reason: 'writer_lease_conflict' }
      }
      generation += 1
      current = { ...identity, generation, acquiredAt: now, expiresAt: now + ttl, status: 'active' }
      return { ok: true, lease: { ...current } }
    },
    assertCurrent(lease, now = 1000) {
      return Boolean(current && current.status === 'active' &&
        current.expiresAt > now && lease?.generation === current.generation &&
        lease?.leaseId === current.leaseId && lease?.workerId === current.workerId)
    },
    cancel(lease) {
      if (!this.assertCurrent(lease)) return false
      current = { ...current, status: 'revoked' }
      return true
    },
    snapshot() { return current && { ...current } }
  }
}

test('schema is Draft 2020-12, closed at the ledger root, and defines all mandatory domains', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  for (const key of [
    'execution', 'scope', 'authority', 'planning_gate', 'dependencies',
    'risks', 'evidence', 'proposals', 'handoff', 'events'
  ]) assert.ok(schema.required.includes(key), `missing required ledger field: ${key}`)
  for (const key of [
    'execution', 'scope', 'authority', 'planningGate', 'gateRecord',
    'dependency', 'risk', 'evidence', 'proposal', 'lease', 'handoff', 'event'
  ]) assert.ok(schema.$defs[key], `missing schema definition: ${key}`)
  assert.equal(schema.$defs.lease.properties.fencing_generation.minimum, 1)
  assert.equal(schema.$defs.authority.properties.budget_usd.maximum, 0)
  assert.equal(schema.$defs.authority.properties.external_egress.const, false)
})

test('seven-point planning gate requires exactly seven distinct reviewed evidence-backed records', () => {
  const records = requiredGateCriteria.map((criterion) => ({
    criterion, status: 'complete', reviewed: true, evidence_refs: [`evidence:${criterion}`]
  }))
  const gate = {
    version: 'swarm-plan-v1',
    state: 'complete',
    disposition: 'ready_for_serialized_implementation',
    records
  }
  assert.equal(validGate(gate), true)
  assert.equal(validGate({ ...gate, records: records.slice(0, 6) }), false)
  assert.equal(validGate({ ...gate, records: records.map((r, i) => i ? r : { ...r, reviewed: false }) }), false)
  assert.equal(validGate({ ...gate, records: records.map((r, i) => i ? r : { ...r, evidence_refs: [] }) }), false)
  assert.equal(validGate({ ...gate, records: [...records, records[0]] }), false)
})

test('single-writer coordinator rejects overlap and fences expired generations', () => {
  const coordinator = createLeaseCoordinator()
  const first = coordinator.acquire({ leaseId: 'lease-1', workerId: 'worker-a' }, 1000, 50)
  assert.equal(first.ok, true)
  const overlap = coordinator.acquire({ leaseId: 'lease-2', workerId: 'worker-b' }, 1010, 50)
  assert.deepEqual(overlap, { ok: false, reason: 'writer_lease_conflict' })
  assert.equal(coordinator.assertCurrent(first.lease, 1011), true)
  assert.equal(coordinator.assertCurrent(first.lease, 1050), false)
  const successor = coordinator.acquire({ leaseId: 'lease-2', workerId: 'worker-b' }, 1051, 50)
  assert.equal(successor.ok, true)
  assert.equal(successor.lease.generation, first.lease.generation + 1)
  assert.equal(coordinator.assertCurrent(first.lease, 1052), false)
  assert.equal(coordinator.assertCurrent(successor.lease, 1052), true)
})

test('cancellation revokes the current lease and blocks subsequent writes', () => {
  const coordinator = createLeaseCoordinator()
  const acquired = coordinator.acquire({ leaseId: 'lease-cancel', workerId: 'worker-c' })
  assert.equal(coordinator.cancel(acquired.lease), true)
  assert.equal(coordinator.assertCurrent(acquired.lease), false)
  assert.equal(coordinator.snapshot().status, 'revoked')
})

test('mandate distinguishes parallel proposals from serialized mutation and defines all seven gate points', () => {
  for (const phrase of [
    'Parallel lane', 'Serialized lane', 'fencing_generation', 'BEGIN IMMEDIATE',
    'idempotency key', 'expected task `updated_at`', 'swarm-plan-v1',
    'Protected exclusions', 'Budget ceiling is **$0.00**',
    'External egress is **prohibited**', 'do not themselves install or enforce a runtime distributed lock'
  ]) assert.ok(mandate.includes(phrase), `mandate missing invariant: ${phrase}`)
  for (const phrase of [
    'Planning evidence and architecture', 'Acceptance criteria',
    'Dependencies and downstream disposition', 'Exact implementation allowlist',
    'Protected exclusions', 'Reversibility and risk', 'Verification plan'
  ]) assert.ok(mandate.includes(phrase), `mandate missing gate criterion: ${phrase}`)
})

test('Task #141 allowlist is exact and Bridge, CI, runtime and deployment are excluded', () => {
  for (const path of [
    'docs/swarm-execution-mandate.md',
    'schemas/swarm-execution-ledger.schema.json',
    'apps/api/test/swarmExecutionMandate.test.js'
  ]) assert.ok(mandate.includes(path))
  assert.match(mandate, /The Bridge repository has no allowlisted files/)
  assert.match(mandate, /\.github\/workflows\/ci\.yml/)
  assert.match(mandate, /Runtime\/source code, task CLI, database schema\/migrations/)
})

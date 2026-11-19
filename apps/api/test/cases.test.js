import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDatabase } from '../src/database.js'
import {
  CASE_AUTHORITY,
  MAX_PROMOTION_BATCH_TASKS,
  canonicalSerializeJson,
  createCasesStore,
  fingerprintPromotionPayload,
  normalizePromotionPayload
} from '../src/db/cases.js'
import { assertSchema, validateSchema } from '../../../scripts/workspace-schema.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = join(ROOT, 'scripts', 'case-registry.mjs')
const CASE_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schemas', 'case-record.schema.json'), 'utf8'))

const FIXED_CLOCK_MS = Date.parse('2026-11-19T12:00:00.000Z')

function setupFixture({ generation = 45, activeLease = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'case-registry-test-'))
  const databasePath = join(dir, 'workspace.sqlite')
  const db = createDatabase(databasePath)
  db.db.prepare(
    'INSERT OR REPLACE INTO project_writer_lease_state (project_id, fencing_generation, current_lease_id, updated_at) VALUES (?, ?, ?, ?)'
  ).run('curl-ai-bridge', generation, null, new Date(FIXED_CLOCK_MS).toISOString())
  if (activeLease) {
    const now = new Date(FIXED_CLOCK_MS).toISOString()
    db.db.prepare(`
      INSERT INTO project_writer_leases
        (lease_id, project_id, task_id, run_id, worker_id, owner_id, repositories_json, allowlist_json, allowlist_sha256, binding_sha256, authorization_ref, fencing_generation, acquired_at, heartbeat_at, expires_at, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'lease-active-test',
      'curl-ai-bridge',
      1,
      'run-1',
      'worker-1',
      'owner-1',
      '[]',
      '{"files":[],"mutations":[]}',
      'a'.repeat(64),
      'b'.repeat(64),
      'auth:active-lease-test',
      generation,
      now,
      now,
      new Date(FIXED_CLOCK_MS + 60000).toISOString(),
      'active',
      'active-lease-idem-1'
    )
  }
  const store = createCasesStore(db.db, {
    tasks: db,
    registerTaskAtCurrentGeneration: db.registerTaskAtCurrentGeneration,
    clock: () => FIXED_CLOCK_MS
  })
  return {
    dir,
    databasePath,
    db,
    store,
    close() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function seedReadyCase(store, {
  caseId = 'CAB-C-001',
  projectId = 'curl-ai-bridge',
  options = [
    {
      optionKey: 'A1',
      title: 'Register blocked task and inspect provenance',
      summary: 'Use current-generation bootstrap registration.',
      expectedTaskCount: 'one',
      governanceMode: 'standard_task_promotion'
    },
    {
      optionKey: 'HOLD',
      title: 'Defer until #160 lands',
      summary: 'Wait for readiness and mapping fix.',
      expectedTaskCount: 'none',
      governanceMode: 'no_task_required'
    }
  ]
} = {}) {
  let c = store.createCase({
    caseId,
    projectId,
    title: 'Validation Repair Governance Path',
    problemStatement: 'Decide between A1, A2, and Hold.'
  })
  for (const opt of options) {
    c = store.addCaseOption({
      caseId,
      ...opt,
      actorId: 'operator',
      actorRole: 'operator',
      expectedVersion: c.version
    })
  }
  const ev = store.addCaseEvidence({
    caseId,
    sourceType: 'audit_report',
    sourceRepo: projectId,
    sourceRef: 'audit:post-agy-check',
    summary: 'Post-AGY audit confirmed F1 and F3 findings.',
    artifactSha256: null,
    hashStatus: 'unhashed',
    observedAt: '2026-11-19T11:30:00.000Z',
    recordedBy: 'auditor-1',
    actorRole: 'auditor'
  })
  c = ev.case
  c = store.transitionCase({
    caseId,
    toStatus: 'investigating',
    actorId: 'auditor-1',
    actorRole: 'auditor',
    expectedVersion: c.version
  })
  c = store.transitionCase({
    caseId,
    toStatus: 'decision_ready',
    actorId: 'auditor-1',
    actorRole: 'auditor',
    expectedVersion: c.version
  })
  return { caseRecord: c, evidenceId: ev.evidence_id }
}

function runCli(databasePath, args, stdinInput) {
  return spawnSync(process.execPath, [CLI, ...args, ...(databasePath ? ['--database', databasePath] : [])], {
    input: stdinInput,
    encoding: 'utf8'
  })
}

test('C1: strict case_id format enforced across store, schema, CLI, and SQLite CHECK', () => {
  const f = setupFixture()
  try {
    const valid1 = f.store.createCase({
      caseId: 'CAB-C-001',
      projectId: 'curl-ai-bridge',
      title: 'Valid 3-char prefix',
      problemStatement: 'Problem 1'
    })
    const valid2 = f.store.createCase({
      caseId: 'MPW2-C-0123',
      projectId: 'workspace',
      title: 'Valid alnum 4-char suffix',
      problemStatement: 'Problem 2'
    })
    assert.equal(valid1.case_id, 'CAB-C-001')
    const valid3 = f.store.createCase({
      caseId: 'AB-C-001',
      projectId: 'workspace',
      title: 'Minimum valid case id',
      problemStatement: 'Minimum valid identifier length'
    })
    assert.equal(valid2.case_id, 'MPW2-C-0123')
    assert.equal(valid3.case_id, 'AB-C-001')
    assertSchema(valid1, CASE_SCHEMA, 'valid1')
    assertSchema(valid2, CASE_SCHEMA, 'valid2')
    assertSchema(valid3, CASE_SCHEMA, 'valid3')

    const malformedIds = [
      'A-C-001',
      'cab-C-001',
      '1AB-C-001',
      'CAB-C-01',
      'CAB-C-001-C-002',
      'CA_B-C-001',
      'ABCDEFGHI-C-001',
      ' CAB-C-001 '
    ]

    for (const badId of malformedIds) {
      assert.throws(
        () => f.store.createCase({ caseId: badId, projectId: 'workspace', title: 'Bad', problemStatement: 'P' }),
        /case_id_invalid/
      )
      assert.throws(
        () => f.db.db.prepare(
          "INSERT INTO cases (case_id, project_id, title, problem_statement, status, version, created_at, updated_at) VALUES (?, 'workspace', 'Bad', 'P', 'open', 1, '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z')"
        ).run(badId),
        /CHECK constraint failed/
      )
      const badDoc = { ...valid1, case_id: badId }
      assert.ok(validateSchema(badDoc, CASE_SCHEMA).length > 0, `schema should reject ${badId}`)

      const cliRes = runCli(f.databasePath, [
        'create', '--case-id', badId, '--project', 'workspace', '--title', 'Bad'
      ], 'Problem text')
      assert.equal(cliRes.status, 2)
      assert.match(cliRes.stderr, /case_id_invalid/)
    }
  } finally {
    f.close()
  }
})

test('R1 & C4: option freeze, generic transition guard, reopen before promotion, and permanent post-promotion immutability', () => {
  const f = setupFixture()
  try {
    let c = f.store.createCase({
      caseId: 'CAB-C-010',
      projectId: 'curl-ai-bridge',
      title: 'Option lifecycle test',
      problemStatement: 'Evaluate option freezing.'
    })
    c = f.store.addCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O1', title: 'Opt 1', summary: 'One task',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.addCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O2', title: 'Opt 2', summary: 'Another option',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.addCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O3', title: 'Opt 3', summary: 'To deprecate',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.deprecateCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O3', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'investigating', actorId: 'rev', actorRole: 'reviewer', expectedVersion: c.version
    })

    // Needs >= 1 evidence before decision_ready.
    assert.throws(() => f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'decision_ready', actorId: 'rev', actorRole: 'reviewer', expectedVersion: c.version
    }), /case_decision_ready_requires_evidence/)

    c = f.store.addCaseEvidence({
      caseId: 'CAB-C-010', sourceType: 'audit_report', sourceRef: 'audit:1',
      summary: 'Evidence 1', hashStatus: 'not_applicable', observedAt: '2026-11-19T12:00:00.000Z',
      recordedBy: 'auditor-1', actorRole: 'auditor'
    }).case

    c = f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'decision_ready', actorId: 'rev', actorRole: 'reviewer', expectedVersion: c.version
    })

    // Cannot deprecate below 2 active options in decision_ready.
    assert.throws(() => f.store.deprecateCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O2', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    }), /case_decision_ready_requires_two_options/)

    // C4: generic transitionCase forbids decided / promoted directly.
    assert.throws(() => f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'decided', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    }), /case_transition_use_decide_operation/)
    assert.throws(() => f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'promoted', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    }), /case_transition_use_promote_operation/)

    const decidedRes = f.store.decideCase({
      caseId: 'CAB-C-010',
      selectedOption: 'O1',
      decisionRationale: 'First decision.',
      decisionAuthorizationRef: 'decision-ref:1',
      idempotencyKey: 'decide-k1',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: c.version
    })
    c = decidedRes.case
    assert.equal(c.status, 'decided')

    // C4: generic transitionCase forbids decided -> discussing.
    assert.throws(() => f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'discussing', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    }), /case_transition_use_reopen_operation/)

    // R1: options frozen in decided state (store + SQLite trigger).
    assert.throws(() => f.store.addCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O4', title: 'Late', summary: 'Nope',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    }), /case_options_frozen_after_decision/)
    assert.throws(() => f.db.db.prepare(
      "INSERT INTO case_options (case_id, option_key, title, summary, created_at) VALUES ('CAB-C-010', 'O4', 'Raw', 'Raw', '2026-11-19T12:00:00.000Z')"
    ).run(), /case options are frozen/)
    assert.throws(() => f.db.db.prepare(
      "UPDATE case_options SET summary = 'Tampered' WHERE case_id = 'CAB-C-010' AND option_key = 'O1'"
    ).run(), /case options are frozen/)
    assert.throws(() => f.db.db.prepare(
      "DELETE FROM case_options WHERE case_id = 'CAB-C-010'"
    ).run(), /case options cannot be deleted/)

    // Operator reopen succeeds before promotion, preserving prior decision in case_events.
    assert.throws(() => f.store.reopenCase({
      caseId: 'CAB-C-010', rationale: 'Assistant cannot reopen', actorId: 'bot', actorRole: 'assistant', expectedVersion: c.version
    }), /case_reopen_operator_required/)

    c = f.store.reopenCase({
      caseId: 'CAB-C-010', rationale: 'Need extra alternative', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    assert.equal(c.status, 'discussing')
    assert.equal(c.decision, null)
    const eventsBeforePromote = f.store.listCaseEvents('CAB-C-010')
    const reopenedEvent = eventsBeforePromote.find((e) => e.event_type === 'reopened')
    assert.equal(reopenedEvent.payload.previous_decision.selected_option, 'O1')

    // Old decision key cannot be reused after reopen.
    c = f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'decision_ready', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    assert.throws(() => f.store.decideCase({
      caseId: 'CAB-C-010',
      selectedOption: 'O2',
      decisionRationale: 'Reusing old key should fail',
      decisionAuthorizationRef: 'decision-ref:2',
      idempotencyKey: 'decide-k1',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: c.version
    }), /case_decision_idempotency_conflict/)

    // Decide with new key and promote.
    c = f.store.decideCase({
      caseId: 'CAB-C-010',
      selectedOption: 'O1',
      decisionRationale: 'Final decision',
      decisionAuthorizationRef: 'decision-ref:2',
      idempotencyKey: 'decide-k2',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: c.version
    }).case
    const promo = f.store.promoteCase({
      caseId: 'CAB-C-010',
      tasks: [{ project: 'curl-ai-bridge', title: 'Task 1' }],
      authorizationRef: 'promote-ref:1',
      idempotencyKey: 'promote-k1',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: c.version,
      expectedGeneration: 45
    })
    assert.equal(promo.records.length, 1)
    c = f.store.getCase('CAB-C-010')
    assert.equal(c.status, 'promoted')

    // Permanently immutable after promotion (store + SQLite trigger).
    assert.throws(() => f.store.reopenCase({
      caseId: 'CAB-C-010', rationale: 'Too late', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    }), /case_already_promoted_immutable/)
    assert.throws(() => f.store.addCaseOption({
      caseId: 'CAB-C-010', optionKey: 'O5', title: 'Too late', summary: 'No',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    }), /case_already_promoted_immutable/)
    assert.throws(() => f.db.db.prepare(
      "UPDATE cases SET selected_option_key = 'O2' WHERE case_id = 'CAB-C-010'"
    ).run(), /promoted case decision is permanently immutable/)

    // Promoted case CAN transition cleanly to closed (by operator with rationale).
    c = f.store.transitionCase({
      caseId: 'CAB-C-010', toStatus: 'closed', rationale: 'Work handed off cleanly.',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    assert.equal(c.status, 'closed')
  } finally {
    f.close()
  }
})

test('R2, R3, C2, and R6: decision/promotion separation, A2 bypass refusal, all expected_task_count modes, and cross-project denial', () => {
  const f = setupFixture()
  try {
    const { caseRecord: ready } = seedReadyCase(f.store, {
      caseId: 'CAB-C-020',
      options: [
        {
          optionKey: 'A1',
          title: 'Single task',
          summary: 'Standard 1 task',
          expectedTaskCount: 'one',
          governanceMode: 'standard_task_promotion'
        },
        {
          optionKey: 'A2',
          title: 'Direct execution waiver',
          summary: 'Requires separate governance mechanism',
          expectedTaskCount: 'one',
          governanceMode: 'requires_separate_governance_mechanism'
        },
        {
          optionKey: 'MULTI',
          title: 'Multiple tasks',
          summary: 'Needs >= 2 tasks',
          expectedTaskCount: 'multiple',
          governanceMode: 'standard_task_promotion'
        },
        {
          optionKey: 'HOLD',
          title: 'Hold without tasks',
          summary: 'No tasks needed',
          expectedTaskCount: 'none',
          governanceMode: 'no_task_required'
        }
      ]
    })

    // Contradictory governance_mode / expected_task_count pairs rejected.
    assert.throws(() => f.store.addCaseOption({
      caseId: 'CAB-C-020', optionKey: 'BAD1', title: 'Bad', summary: 'Mismatch',
      expectedTaskCount: 'none', governanceMode: 'standard_task_promotion',
      actorId: 'op', actorRole: 'operator', expectedVersion: ready.version
    }), /case_option_mode_count_mismatch/)
    assert.throws(() => f.store.addCaseOption({
      caseId: 'CAB-C-020', optionKey: 'BAD2', title: 'Bad', summary: 'Mismatch',
      expectedTaskCount: 'one', governanceMode: 'no_task_required',
      actorId: 'op', actorRole: 'operator', expectedVersion: ready.version
    }), /case_option_mode_count_mismatch/)

    // Non-binding recommendation never changes status or sets decision.
    const recommended = f.store.setCaseRecommendation({
      caseId: 'CAB-C-020', optionKey: 'A1', rationale: 'Safest first step.',
      actorId: 'reviewer-1', actorRole: 'reviewer', expectedVersion: ready.version
    })
    assert.equal(recommended.status, 'decision_ready')
    assert.equal(recommended.decision, null)
    assert.equal(recommended.recommendation.option_key, 'A1')

    // Non-operator decide fails closed.
    assert.throws(() => f.store.decideCase({
      caseId: 'CAB-C-020', selectedOption: 'A2', decisionRationale: 'Unauthorized',
      decisionAuthorizationRef: 'ref:x', idempotencyKey: 'dec-nonop',
      actorId: 'assistant-1', actorRole: 'assistant', expectedVersion: recommended.version
    }), /case_decision_operator_required/)

    // R3: A2 can be decided, but ordinary promoteCase refuses it.
    let c = f.store.decideCase({
      caseId: 'CAB-C-020', selectedOption: 'A2', decisionRationale: 'Record A2 preference for separate design.',
      decisionAuthorizationRef: 'dec-ref:a2', idempotencyKey: 'dec-shared-key',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: recommended.version
    }).case
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0)

    // R2: reusing decision idempotency key for promote fails closed.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: [{ project: 'curl-ai-bridge', title: 'T' }],
      authorizationRef: 'prom-ref:1', idempotencyKey: 'dec-shared-key',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_promotion_requires_distinct_idempotency_key/)

    // Non-operator promote fails closed.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: [{ project: 'curl-ai-bridge', title: 'T' }],
      authorizationRef: 'prom-ref:1', idempotencyKey: 'prom-a2-attempt',
      actorId: 'reviewer-1', actorRole: 'reviewer', expectedVersion: c.version, expectedGeneration: 45
    }), /case_promotion_operator_required/)

    // R3 refusal of A2.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: [{ project: 'curl-ai-bridge', title: 'Bypass' }],
      authorizationRef: 'prom-ref:1', idempotencyKey: 'prom-a2-attempt',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_option_requires_separate_governance_mechanism/)

    // Reopen and verify HOLD (none) rejects task promotion and can defer with 0 tasks.
    c = f.store.reopenCase({
      caseId: 'CAB-C-020', rationale: 'Switch to HOLD first', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.transitionCase({
      caseId: 'CAB-C-020', toStatus: 'decision_ready', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.decideCase({
      caseId: 'CAB-C-020', selectedOption: 'HOLD', decisionRationale: 'Wait on #160',
      decisionAuthorizationRef: 'dec-ref:hold', idempotencyKey: 'dec-hold',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    }).case
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: [{ project: 'curl-ai-bridge', title: 'Should not create' }],
      authorizationRef: 'prom-ref:hold', idempotencyKey: 'prom-hold',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_option_no_task_promotion/)

    // Reopen and test 'one' vs 'multiple' counts and R6 cross-project denial.
    c = f.store.reopenCase({
      caseId: 'CAB-C-020', rationale: 'Switch to MULTI', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.transitionCase({
      caseId: 'CAB-C-020', toStatus: 'decision_ready', actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.decideCase({
      caseId: 'CAB-C-020', selectedOption: 'MULTI', decisionRationale: 'Split F1 and F3',
      decisionAuthorizationRef: 'dec-ref:multi', idempotencyKey: 'dec-multi',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version
    }).case

    // C2: multiple rejects 1 task and > 25 tasks.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: [{ project: 'curl-ai-bridge', title: 'Only 1' }],
      authorizationRef: 'prom-ref:multi', idempotencyKey: 'prom-multi-1',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_option_task_count_mismatch/)
    const tooManyTasks = Array.from({ length: MAX_PROMOTION_BATCH_TASKS + 1 }, (_, i) => ({
      project: 'curl-ai-bridge', title: `Task ${i}`
    }))
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020', tasks: tooManyTasks,
      authorizationRef: 'prom-ref:multi', idempotencyKey: 'prom-multi-26',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_option_task_count_mismatch/)

    // R6: cross-project task fails closed with zero side effects.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-020',
      tasks: [
        { project: 'curl-ai-bridge', title: 'F1 fix' },
        { project: 'workspace', title: 'Cross-project escape' }
      ],
      authorizationRef: 'prom-ref:multi', idempotencyKey: 'prom-cross',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: c.version, expectedGeneration: 45
    }), /case_promotion_cross_project_disabled/)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0)

    // Stale case: A1 ('one') rejects 2 tasks.
    const { caseRecord: singleCase } = seedReadyCase(f.store, { caseId: 'CAB-C-021' })
    const decidedSingle = f.store.decideCase({
      caseId: 'CAB-C-021', selectedOption: 'A1', decisionRationale: 'Select A1',
      decisionAuthorizationRef: 'dec-ref:a1', idempotencyKey: 'dec-a1',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: singleCase.version
    }).case
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-021',
      tasks: [
        { project: 'curl-ai-bridge', title: 'T1' },
        { project: 'curl-ai-bridge', title: 'T2' }
      ],
      authorizationRef: 'prom-ref:a1', idempotencyKey: 'prom-a1-two',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: decidedSingle.version, expectedGeneration: 45
    }), /case_option_task_count_mismatch/)

    // Genuine A1 promotion produces strictly blocked task, gen=45 unchanged, zero leases.
    const a1Promo = f.store.promoteCase({
      caseId: 'CAB-C-021',
      tasks: [{ project: 'curl-ai-bridge', title: 'Fix F1 and F3' }],
      authorizationRef: 'prom-ref:a1', idempotencyKey: 'prom-a1-ok',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: decidedSingle.version, expectedGeneration: 45
    })
    assert.equal(a1Promo.authority, 'decision-only')
    assert.equal(a1Promo.grants_execution_authority, false)
    const createdTask = f.db.getTask(a1Promo.records[0].task_id)
    assert.equal(createdTask.status, 'blocked')
    assert.equal(createdTask.completed, false)
    assert.equal(
      f.db.db.prepare("SELECT fencing_generation FROM project_writer_lease_state WHERE project_id = 'curl-ai-bridge'").get().fencing_generation,
      45
    )
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM project_writer_leases').get().count, 0)
  } finally {
    f.close()
  }
})

test('R4 & C5: exact canonical UTF-8 byte anchor, single-pipeline normalization, atomic multi-task rollback, and batch identity', () => {
  // 1) Exact canonical UTF-8 byte output & SHA-256 verification anchor (inspectable literal).
  const fixedInput = {
    case_id: 'CAB-C-001',
    project_id: 'curl-ai-bridge',
    selected_option_key: 'A1',
    authorization_ref: '  op-auth:2026-11-19  ',
    expected_generation: 45,
    tasks: [
      {
        project: 'curl-ai-bridge',
        title: '  Repair Cafe\u0301 test  ',
        description: 'Line 1\r\nLine 2\rLine 3',
        relevant_files: 'tests/security/core-root-pins-integration.mjs\r\nscripts/test-all.mjs'
      }
    ]
  }
  const normalized = normalizePromotionPayload(fixedInput)
  assert.equal(normalized.authorization_ref, 'op-auth:2026-11-19')
  assert.equal(normalized.tasks[0].title, 'Repair Caf\u00e9 test')
  assert.equal(normalized.tasks[0].description, 'Line 1\nLine 2\nLine 3')

  const { canonicalJson, canonicalBytes, sha256 } = fingerprintPromotionPayload(normalized)
  const expectedCanonicalJson =
    '{"authorization_ref":"op-auth:2026-11-19","case_id":"CAB-C-001","expected_generation":45,"project_id":"curl-ai-bridge","selected_option_key":"A1","tasks":[{"acceptance_criteria":"","decisions":"","description":"Line 1\\nLine 2\\nLine 3","important_context":"","next_move":"","objectives":"","priority":"medium","project":"curl-ai-bridge","relevant_files":"tests/security/core-root-pins-integration.mjs\\nscripts/test-all.mjs","requirements":"","task_type":"feature","title":"Repair Caf\u00e9 test","work_active":"","work_blocked":"","work_completed":""}]}'
  assert.equal(canonicalJson, expectedCanonicalJson)
  assert.equal(Buffer.compare(canonicalBytes, Buffer.from(expectedCanonicalJson, 'utf8')), 0)
  assert.equal(sha256, createHash('sha256').update(Buffer.from(expectedCanonicalJson, 'utf8')).digest('hex'))

  // Exact fields reject outer whitespace; malformed unicode / NUL / newline in single-line fail closed.
  assert.throws(() => normalizePromotionPayload({ ...fixedInput, case_id: ' CAB-C-001 ' }), /case_promotion_exact_field_whitespace/)
  assert.throws(() => normalizePromotionPayload({ ...fixedInput, project_id: ' curl-ai-bridge ' }), /case_promotion_exact_field_whitespace/)
  assert.throws(() => normalizePromotionPayload({ ...fixedInput, selected_option_key: ' A1 ' }), /case_promotion_exact_field_whitespace/)
  assert.throws(() => normalizePromotionPayload({
    ...fixedInput,
    tasks: [{ project: 'curl-ai-bridge', title: 'Known fields only', unexpected_field: 'silently ignored before fix' }]
  }), /case_promotion_task_field_unknown/)
  assert.throws(() => normalizePromotionPayload({
    ...fixedInput,
    tasks: [{ project: ' curl-ai-bridge ', title: 'x' }]
  }), /case_promotion_exact_field_whitespace/)
  assert.throws(() => normalizePromotionPayload({
    ...fixedInput,
    tasks: [{ project: 'curl-ai-bridge', title: 'Bad\nTitle' }]
  }), /case_promotion_invalid_control_char/)
  assert.throws(() => normalizePromotionPayload({
    ...fixedInput,
    tasks: [{ project: 'curl-ai-bridge', title: 'Surrogate\uD800' }]
  }), /case_promotion_invalid_unicode/)
  assert.throws(() => normalizePromotionPayload({
    ...fixedInput,
    tasks: [{ project: 'curl-ai-bridge', title: 'Ok', description: 'NUL\u0000byte' }]
  }), /case_promotion_invalid_control_char/)

  // 2) Multi-task rollback when second registration fails inside the shared connection transaction.
  const f = setupFixture({ generation: 45 })
  try {
    const { caseRecord: ready } = seedReadyCase(f.store, {
      caseId: 'CAB-C-030',
      options: [
        {
          optionKey: 'M1',
          title: 'Two tasks',
          summary: 'Multi-task atomic promotion',
          expectedTaskCount: 'multiple',
          governanceMode: 'standard_task_promotion'
        },
        {
          optionKey: 'H1',
          title: 'Hold',
          summary: 'No task',
          expectedTaskCount: 'none',
          governanceMode: 'no_task_required'
        }
      ]
    })
    const decided = f.store.decideCase({
      caseId: 'CAB-C-030', selectedOption: 'M1', decisionRationale: 'Split into 2 tasks',
      decisionAuthorizationRef: 'dec-ref:m1', idempotencyKey: 'dec-m1',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: ready.version
    }).case

    let callIndex = 0
    const failingStore = createCasesStore(f.db.db, {
      tasks: f.db,
      registerTaskAtCurrentGeneration(input) {
        callIndex += 1
        if (callIndex === 2) throw new Error('simulated_second_task_failure')
        return f.db.registerTaskAtCurrentGeneration(input)
      },
      clock: () => FIXED_CLOCK_MS
    })

    assert.throws(() => failingStore.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        { project: 'curl-ai-bridge', title: 'Task 1 inserted before failure' },
        { project: 'curl-ai-bridge', title: 'Task 2 fails' }
      ],
      authorizationRef: 'prom-ref:rollback',
      idempotencyKey: 'prom-rollback-key',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    }), /simulated_second_task_failure/)

    // Task 1, its event, bootstrap event, and promotion rows MUST all be rolled back.
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM task_events').get().count, 0)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM project_writer_bootstrap_events').get().count, 0)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM case_promotions').get().count, 0)
    const afterFail = f.store.getCase('CAB-C-030')
    assert.equal(afterFail.status, 'decided')
    assert.equal(afterFail.version, decided.version)

    // Pre-existing bootstrap key collision on task #2 also rolls back task #1 cleanly.
    const fCollide = setupFixture({ generation: 45 })
    try {
      const { caseRecord: cReady } = seedReadyCase(fCollide.store, {
        caseId: 'CAB-C-039',
        options: [
          {
            optionKey: 'M1',
            title: 'Two tasks',
            summary: 'Collision test',
            expectedTaskCount: 'multiple',
            governanceMode: 'standard_task_promotion'
          },
          {
            optionKey: 'H1',
            title: 'Hold',
            summary: 'No task',
            expectedTaskCount: 'none',
            governanceMode: 'no_task_required'
          }
        ]
      })
      const cDecided = fCollide.store.decideCase({
        caseId: 'CAB-C-039', selectedOption: 'M1', decisionRationale: 'Split into 2 tasks',
        decisionAuthorizationRef: 'dec-ref:m1c', idempotencyKey: 'dec-m1c',
        actorId: 'sunil', actorRole: 'operator', expectedVersion: cReady.version
      }).case
      const preexistingReg = fCollide.db.registerTaskAtCurrentGeneration({
        task: { project: 'curl-ai-bridge', title: 'Preexisting collided task' },
        authorizationRef: 'preexisting:ref',
        idempotencyKey: 'prom-collide-key#1',
        expectedGeneration: 45
      })
      assert.ok(preexistingReg.taskId > 0)
      assert.throws(() => fCollide.store.promoteCase({
        caseId: 'CAB-C-039',
        tasks: [
          { project: 'curl-ai-bridge', title: 'Task 1 must roll back' },
          { project: 'curl-ai-bridge', title: 'Task 2 collides on bootstrap key' }
        ],
        authorizationRef: 'prom-ref:collide',
        idempotencyKey: 'prom-collide-key',
        actorId: 'sunil',
        actorRole: 'operator',
        expectedVersion: cDecided.version,
        expectedGeneration: 45
      }), /case_promotion_bootstrap_key_collision/)
      assert.equal(fCollide.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 1)
      assert.equal(fCollide.db.db.prepare('SELECT count(*) AS count FROM case_promotions').get().count, 0)
      assert.equal(fCollide.store.getCase('CAB-C-039').status, 'decided')
      assert.equal(fCollide.store.getCase('CAB-C-039').version, cDecided.version)
    } finally {
      fCollide.close()
    }

    // Stale expectedGeneration fails closed cleanly.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        { project: 'curl-ai-bridge', title: 'T1' },
        { project: 'curl-ai-bridge', title: 'T2' }
      ],
      authorizationRef: 'prom-ref:stale',
      idempotencyKey: 'prom-stale-gen',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 44
    }), /task_bootstrap_generation_mismatch/)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0)

    // Successful 2-task managed promotion + persisted normalized values + idempotent replay + conflict checks.
    const batchKey = 'prom-batch-c030'
    const promo = f.store.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        {
          project: 'curl-ai-bridge',
          title: '  Task 1 Cafe\u0301  ',
          description: 'Alpha\r\nBeta\rGamma'
        },
        {
          project: 'curl-ai-bridge',
          title: 'Task 2 F3',
          description: 'Register tests'
        }
      ],
      authorizationRef: '  prom-ref:m1  ',
      idempotencyKey: batchKey,
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    })
    assert.equal(promo.replayed, false)
    assert.equal(promo.authority, 'decision-only')
    assert.equal(promo.grants_execution_authority, false)
    assert.notEqual(promo.batch_id, batchKey)
    assert.equal(promo.records.length, 2)
    assert.equal(promo.records[0].item_idempotency_key, `${batchKey}#0`)
    assert.equal(promo.records[1].item_idempotency_key, `${batchKey}#1`)
    assert.equal(promo.records[0].registration_mode, 'current_generation_bootstrap')

    // Verify persisted task #1 matches single-pipeline normalized NFC + \n + trimmed fields verbatim.
    const storedTask1 = f.db.getTask(promo.records[0].task_id)
    assert.equal(storedTask1.title, 'Task 1 Caf\u00e9')
    assert.equal(storedTask1.description, 'Alpha\nBeta\nGamma')
    assert.equal(storedTask1.status, 'blocked')

    // Replay with NFC + \n equivalents must match request_sha256 and return same batch_id.
    const replay = f.store.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        {
          project: 'curl-ai-bridge',
          title: 'Task 1 Caf\u00e9',
          description: 'Alpha\nBeta\nGamma'
        },
        {
          project: 'curl-ai-bridge',
          title: 'Task 2 F3',
          description: 'Register tests'
        }
      ],
      authorizationRef: 'prom-ref:m1',
      idempotencyKey: batchKey,
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.batch_id, promo.batch_id)
    assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 2)

    // Replay with changed whitespace inside free-text description must conflict.
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        {
          project: 'curl-ai-bridge',
          title: 'Task 1 Caf\u00e9',
          description: 'Alpha\nBeta\nGamma '
        },
        {
          project: 'curl-ai-bridge',
          title: 'Task 2 F3',
          description: 'Register tests'
        }
      ],
      authorizationRef: 'prom-ref:m1',
      idempotencyKey: batchKey,
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    }), /case_promotion_idempotency_conflict/)

    // New key on already promoted case fails closed.
    const currentAfterPromote = f.store.getCase('CAB-C-030')
    assert.throws(() => f.store.promoteCase({
      caseId: 'CAB-C-030',
      tasks: [
        { project: 'curl-ai-bridge', title: 'Task 1' },
        { project: 'curl-ai-bridge', title: 'Task 2' }
      ],
      authorizationRef: 'prom-ref:m1',
      idempotencyKey: 'prom-new-after-promoted',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: currentAfterPromote.version,
      expectedGeneration: 45
    }), /case_already_promoted_immutable/)

    // Exported Case Record validates against JSON Schema and preserves authority declarations.
    const exported = f.store.exportCase('CAB-C-030')
    assertSchema(exported, CASE_SCHEMA, 'exported-promoted-case')
    assert.deepEqual(
      { authority: exported.authority, grants_execution_authority: exported.grants_execution_authority },
      CASE_AUTHORITY
    )
    assert.deepEqual(
      { authority: exported.promotion.authority, grants_execution_authority: exported.promotion.grants_execution_authority },
      CASE_AUTHORITY
    )
    for (const rec of exported.promotion.records) {
      assert.deepEqual(
        { authority: rec.authority, grants_execution_authority: rec.grants_execution_authority },
        CASE_AUTHORITY
      )
    }
  } finally {
    f.close()
  }

  // 3) Active writer lease blocks managed-project promotion cleanly.
  const activeFixture = setupFixture({ generation: 45, activeLease: true })
  try {
    const { caseRecord: ready } = seedReadyCase(activeFixture.store, { caseId: 'CAB-C-031' })
    const decided = activeFixture.store.decideCase({
      caseId: 'CAB-C-031', selectedOption: 'A1', decisionRationale: 'Try with active lease',
      decisionAuthorizationRef: 'dec-ref:active', idempotencyKey: 'dec-active',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: ready.version
    }).case
    assert.throws(() => activeFixture.store.promoteCase({
      caseId: 'CAB-C-031',
      tasks: [{ project: 'curl-ai-bridge', title: 'Blocked by active lease' }],
      authorizationRef: 'prom-ref:active',
      idempotencyKey: 'prom-active',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    }), /task_bootstrap_active_lease_exists/)
    assert.equal(activeFixture.db.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0)
  } finally {
    activeFixture.close()
  }

  // 4) Unmanaged project promotion uses direct_unmanaged_task and canonical expected_generation = null.
  const unmanaged = setupFixture()
  try {
    const { caseRecord: ready } = seedReadyCase(unmanaged.store, {
      caseId: 'MPW-C-001',
      projectId: 'workspace'
    })
    const decided = unmanaged.store.decideCase({
      caseId: 'MPW-C-001', selectedOption: 'A1', decisionRationale: 'Unmanaged workspace task',
      decisionAuthorizationRef: 'dec-ref:mpw', idempotencyKey: 'dec-mpw',
      actorId: 'sunil', actorRole: 'operator', expectedVersion: ready.version
    }).case
    assert.throws(() => unmanaged.store.promoteCase({
      caseId: 'MPW-C-001',
      tasks: [{ project: 'workspace', title: 'Unexpected gen' }],
      authorizationRef: 'prom-ref:mpw',
      idempotencyKey: 'prom-mpw-bad-gen',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    }), /case_promotion_expected_generation_unexpected/)

    const promo = unmanaged.store.promoteCase({
      caseId: 'MPW-C-001',
      tasks: [{ project: 'workspace', title: 'Create workspace helper' }],
      authorizationRef: 'prom-ref:mpw',
      idempotencyKey: 'prom-mpw-ok',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version
    })
    assert.equal(promo.records[0].registration_mode, 'direct_unmanaged_task')
    assert.equal(promo.records[0].fencing_generation, null)
    assert.equal(promo.records[0].bootstrap_event_id, null)
    assert.throws(() => unmanaged.store.promoteCase({
      caseId: 'MPW-C-001',
      tasks: [{ project: 'workspace', title: 'Create workspace helper' }],
      authorizationRef: 'prom-ref:mpw',
      idempotencyKey: 'prom-mpw-ok',
      actorId: 'sunil',
      actorRole: 'operator',
      expectedVersion: decided.version,
      expectedGeneration: 45
    }), /case_promotion_expected_generation_unexpected/)
    assertSchema(unmanaged.store.exportCase('MPW-C-001'), CASE_SCHEMA, 'exported-unmanaged-case')
  } finally {
    unmanaged.close()
  }
})

test('R5 & C3: evidence hash verification, informational authority, and append-only audit triggers', () => {
  const f = setupFixture()
  try {
    f.store.createCase({
      caseId: 'CAB-C-040',
      projectId: 'curl-ai-bridge',
      title: 'Evidence verification',
      problemStatement: 'Verify C3 rules.'
    })

    const payloadBytes = Buffer.from('verified artifact bytes\n', 'utf8')
    const validSha = createHash('sha256').update(payloadBytes).digest('hex')
    const wrongSha = '0'.repeat(64)

    // Caller-supplied SHA-256 without accessible bytes cannot become verified.
    assert.throws(() => f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'audit_report',
      sourceRef: 'report.txt',
      summary: 'Claimed digest only',
      artifactSha256: validSha,
      hashStatus: 'verified',
      observedAt: '2026-11-19T12:00:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor'
    }), /case_evidence_verification_source_required/)

    // Succeeds only as unverified_claimed without bytes.
    const claimed = f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'audit_report',
      sourceRef: 'report.txt',
      summary: 'Recorded claimed hash',
      artifactSha256: validSha,
      hashStatus: 'unverified_claimed',
      observedAt: '2026-11-19T12:00:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor'
    })
    assert.equal(claimed.case.evidence[0].hash_status, 'unverified_claimed')
    assert.equal(claimed.case.evidence[0].authority_level, 'informational')

    // Mismatched bytes fail closed.
    assert.throws(() => f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'workspace_file',
      sourceRef: 'artifact.bin',
      summary: 'Wrong hash',
      artifactSha256: wrongSha,
      hashStatus: 'verified',
      observedAt: '2026-11-19T12:01:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor',
      artifactBytes: payloadBytes
    }), /case_evidence_sha256_mismatch/)

    // Matching bytes succeed as verified and record verified_bytes.
    const verified = f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'workspace_file',
      sourceRef: 'artifact.bin',
      summary: 'Verified bytes',
      artifactSha256: validSha,
      hashStatus: 'verified',
      observedAt: '2026-11-19T12:02:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor',
      artifactBytes: payloadBytes
    })
    assert.equal(verified.case.evidence[1].hash_status, 'verified')
    assert.equal(verified.case.evidence[1].metadata.verified_bytes, payloadBytes.byteLength)

    // unhashed / not_applicable forbid non-null SHA-256.
    assert.throws(() => f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'command_output',
      sourceRef: 'cmd:1',
      summary: 'Has hash with unhashed status',
      artifactSha256: validSha,
      hashStatus: 'unhashed',
      observedAt: '2026-11-19T12:03:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor'
    }), /case_evidence_hash_status_invalid/)

    // Symlink verifyFilePath rejected cleanly.
    const realFile = join(f.dir, 'real.txt')
    const linkFile = join(f.dir, 'link.txt')
    writeFileSync(realFile, payloadBytes)
    symlinkSync(realFile, linkFile)
    assert.throws(() => f.store.addCaseEvidence({
      caseId: 'CAB-C-040',
      sourceType: 'workspace_file',
      sourceRef: 'link.txt',
      summary: 'Symlink target',
      artifactSha256: validSha,
      hashStatus: 'verified',
      observedAt: '2026-11-19T12:04:00.000Z',
      recordedBy: 'auditor-1',
      actorRole: 'auditor',
      verifyFilePath: linkFile
    }), /case_evidence_verify_file_symlink_rejected/)

    // Append discussion + promote an option so case_promotions has a row too.
    const discussRes = f.store.addCaseDiscussion({
      caseId: 'CAB-C-040',
      authorId: 'reviewer-1',
      authorRole: 'reviewer',
      entryType: 'finding',
      body: 'Evidence hash confirmed.',
      evidenceRefs: [verified.evidence_id]
    })
    let c = discussRes.case
    c = f.store.addCaseOption({
      caseId: 'CAB-C-040', optionKey: 'O1', title: 'Opt 1', summary: 'One',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.addCaseOption({
      caseId: 'CAB-C-040', optionKey: 'O2', title: 'Opt 2', summary: 'None',
      expectedTaskCount: 'none', governanceMode: 'no_task_required',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.transitionCase({
      caseId: 'CAB-C-040', toStatus: 'discussing', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.transitionCase({
      caseId: 'CAB-C-040', toStatus: 'decision_ready', actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    })
    c = f.store.decideCase({
      caseId: 'CAB-C-040', selectedOption: 'O1', decisionRationale: 'Proceed',
      decisionAuthorizationRef: 'dec:40', idempotencyKey: 'dec-40',
      actorId: 'op', actorRole: 'operator', expectedVersion: c.version
    }).case
    f.store.promoteCase({
      caseId: 'CAB-C-040',
      tasks: [{ project: 'curl-ai-bridge', title: 'Promoted task' }],
      authorizationRef: 'prom:40',
      idempotencyKey: 'prom-40',
      actorId: 'op',
      actorRole: 'operator',
      expectedVersion: c.version,
      expectedGeneration: 45
    })

    // Append-only triggers block UPDATE & DELETE on all 4 audit tables.
    for (const table of ['case_evidence', 'case_discussion', 'case_promotions', 'case_events']) {
      assert.throws(() => f.db.db.prepare(`DELETE FROM ${table}`).run(), /append-only/)
    }
    assert.throws(() => f.db.db.prepare("UPDATE case_evidence SET summary = 'x'").run(), /append-only/)
    assert.throws(() => f.db.db.prepare("UPDATE case_discussion SET body = 'x'").run(), /append-only/)
    assert.throws(() => f.db.db.prepare("UPDATE case_promotions SET authorization_ref = 'x'").run(), /append-only/)
    assert.throws(() => f.db.db.prepare("UPDATE case_events SET actor_id = 'x'").run(), /append-only/)
  } finally {
    f.close()
  }
})

test('CLI end-to-end: standalone case-registry.mjs workflow, --verify-file, read-only list/get/export, and fail-closed guards', () => {
  const f = setupFixture({ generation: 45 })
  try {
    const artifactPath = join(f.dir, 'audit-report.txt')
    const artifactContent = 'F1: core-root-pins-integration hardcoded path\nF3: 10 unregistered tests\n'
    writeFileSync(artifactPath, artifactContent, 'utf8')
    const artifactSha = createHash('sha256').update(artifactContent, 'utf8').digest('hex')

    const created = runCli(f.databasePath, [
      'create', '--case-id', 'CAB-C-001', '--project', 'curl-ai-bridge',
      '--title', 'F1/F3 Validation Repair Governance Path'
    ], JSON.stringify({ problem_statement: 'Select governance path for F1/F3 repair.' }))
    assert.equal(created.status, 0, created.stderr)
    let current = JSON.parse(created.stdout)
    assert.equal(current.version, 1)

    for (const opt of [
      ['A1', 'Register task #161 and stop', 'standard_task_promotion', 'one', 'Use bootstrap registration at gen 45.'],
      ['A2', 'Register task + direct waiver', 'requires_separate_governance_mechanism', 'one', 'Requires separate governance mechanism.'],
      ['HOLD', 'Hold until #160 lands', 'no_task_required', 'none', 'Defer repair without creating a task.']
    ]) {
      const res = runCli(f.databasePath, [
        'add-option', 'CAB-C-001',
        '--key', opt[0],
        '--title', opt[1],
        '--governance-mode', opt[2],
        '--expected-task-count', opt[3],
        '--expected-version', String(current.version)
      ], JSON.stringify({ summary: opt[4] }))
      assert.equal(res.status, 0, res.stderr)
      current = JSON.parse(res.stdout)
    }

    const ev = runCli(f.databasePath, [
      'add-evidence', 'CAB-C-001',
      '--source-type', 'audit_report',
      '--source-repo', 'curl-ai-bridge',
      '--source-ref', 'docs/post-agy-audit',
      '--observed-at', '2026-11-19T12:00:00.000Z',
      '--hash-status', 'verified',
      '--sha256', artifactSha,
      '--verify-file', artifactPath,
      '--actor', 'auditor-cli'
    ], 'Verified audit summary from file.')
    assert.equal(ev.status, 0, ev.stderr)
    assert.equal(JSON.parse(ev.stdout).case.evidence[0].hash_status, 'verified')

    const disc = runCli(f.databasePath, [
      'discuss', 'CAB-C-001', '--actor', 'reviewer-cli', '--role', 'reviewer', '--type', 'finding'
    ], 'Writer-lease acquire currently blocks on #160 mapping gap.')
    assert.equal(disc.status, 0, disc.stderr)

    const rec = runCli(f.databasePath, [
      'recommend', 'CAB-C-001', '--option', 'A1', '--actor', 'reviewer-cli', '--role', 'reviewer',
      '--expected-version', String(current.version)
    ], 'Recommend A1 for clean provenance.')
    assert.equal(rec.status, 0, rec.stderr)
    current = JSON.parse(rec.stdout)

    const tr1 = runCli(f.databasePath, [
      'transition', 'CAB-C-001', '--to', 'discussing', '--actor', 'sunil', '--role', 'operator',
      '--expected-version', String(current.version)
    ])
    assert.equal(tr1.status, 0, tr1.stderr)
    current = JSON.parse(tr1.stdout)

    const tr2 = runCli(f.databasePath, [
      'transition', 'CAB-C-001', '--to', 'decision_ready', '--actor', 'sunil', '--role', 'operator',
      '--expected-version', String(current.version)
    ])
    assert.equal(tr2.status, 0, tr2.stderr)
    current = JSON.parse(tr2.stdout)

    // C4 CLI check: generic transition cannot decide.
    const badTr = runCli(f.databasePath, [
      'transition', 'CAB-C-001', '--to', 'decided', '--actor', 'sunil', '--role', 'operator',
      '--expected-version', String(current.version)
    ])
    assert.equal(badTr.status, 2)
    assert.match(badTr.stderr, /case_transition_use_decide_operation/)

    // Non-operator decide via CLI rejected.
    const badDec = runCli(f.databasePath, [
      'decide', 'CAB-C-001', '--option', 'A1', '--actor', 'bot', '--role', 'assistant',
      '--authorization-ref', 'dec:cli', '--idempotency-key', 'cli-dec-bad',
      '--expected-version', String(current.version)
    ], 'Cannot decide as assistant')
    assert.equal(badDec.status, 2)
    assert.match(badDec.stderr, /case_decision_operator_required/)

    const dec = runCli(f.databasePath, [
      'decide', 'CAB-C-001', '--option', 'A1', '--actor', 'sunil', '--role', 'operator',
      '--authorization-ref', 'dec:cli:1', '--idempotency-key', 'cli-dec-1',
      '--expected-version', String(current.version)
    ], 'Proceed with A1.')
    assert.equal(dec.status, 0, dec.stderr)
    current = JSON.parse(dec.stdout).case

    const prom = runCli(f.databasePath, [
      'promote', 'CAB-C-001', '--actor', 'sunil', '--role', 'operator',
      '--authorization-ref', 'prom:cli:1', '--idempotency-key', 'cli-prom-1',
      '--expected-version', String(current.version), '--expected-generation', '45'
    ], JSON.stringify({
      tasks: [{
        project: 'curl-ai-bridge',
        title: 'Repair F1/F3 validation and runner registration'
      }]
    }))
    assert.equal(prom.status, 0, prom.stderr)
    const promOut = JSON.parse(prom.stdout)
    assert.equal(promOut.records.length, 1)

    const exp = runCli(f.databasePath, ['export', 'CAB-C-001'])
    assert.equal(exp.status, 0, exp.stderr)
    const exported = JSON.parse(exp.stdout)
    assertSchema(exported, CASE_SCHEMA, 'cli-exported-case')
    assert.equal(exported.status, 'promoted')

    const listed = runCli(f.databasePath, ['list', '--project', 'curl-ai-bridge', '--status', 'promoted'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(JSON.parse(listed.stdout).length, 1)

    const fetched = runCli(f.databasePath, ['get', 'CAB-C-001'])
    assert.equal(fetched.status, 0, fetched.stderr)
    assert.equal(JSON.parse(fetched.stdout).case_id, 'CAB-C-001')

    // Read-only CLI on unmigrated empty SQLite fails closed with cases_table_missing without mutating DB.
    const emptyDbPath = join(f.dir, 'unmigrated.sqlite')
    const emptyDb = new Database(emptyDbPath)
    emptyDb.exec('CREATE TABLE ping (id INTEGER PRIMARY KEY)')
    emptyDb.close()
    const missingTbl = runCli(emptyDbPath, ['list'])
    assert.equal(missingTbl.status, 2)
    assert.match(missingTbl.stderr, /cases_table_missing/)
  } finally {
    f.close()
  }
})

// Sanity guard: production database integrity and repo paths remain untouched by tests.
test('regression sanity check: canonicalSerializer handles nested key ordering cleanly', () => {
  assert.equal(canonicalSerializeJson({ z: 1, a: { d: 2, b: [3, { y: 1, x: 2 }] } }), '{"a":{"b":[3,{"x":2,"y":1}],"d":2},"z":1}')
})

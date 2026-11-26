import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkItem } from '../../src/toolchain/dispatch/case-task-lifecycle.js'
import {
  canonicalCasesDir,
  writeCase,
  readCase,
  readCases,
  recordOptionFinding,
  selectBestOptionAndPromote
} from '../../src/toolchain/dispatch/case-registry.js'

test('case registry stores multi-option cases, records sandbox findings, and promotes best passing option', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-reg-'))
  try {
    let kase = createWorkItem({
      id: 'case-opencode-nvidia',
      title: 'Recover OpenCode NVIDIA sibling',
      options: [
        { id: 'try-faster-nim', label: 'Switch to faster NIM model' },
        { id: 'keep-parked', label: 'Keep parked under #176' }
      ]
    })
    kase = writeCase(dir, kase)
    assert.strictEqual(readCases(dir).length, 1)

    assert.throws(() => selectBestOptionAndPromote(kase), /no_passing_option_finding/)

    kase = recordOptionFinding(kase, { optionId: 'try-faster-nim', ok: false, score: 0, latencyMs: 35000, sandboxType: 'sandbox', notes: 'rc=124 timeout' })
    kase = recordOptionFinding(kase, { optionId: 'keep-parked', ok: true, score: 80, latencyMs: 5, sandboxType: 'temp', notes: 'zero burn, tracked in #176' })
    kase = writeCase(dir, kase)

    const loaded = readCase(dir, 'case-opencode-nvidia')
    assert.throws(() => selectBestOptionAndPromote(loaded), /case_promotion_authority_required/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#231: file registry delegates promotion to the governed promoter only', () => {
  const kase = createWorkItem({
    id: 'case-authority-check',
    title: 'Promotion authority belongs to the governed store',
    options: [{ id: 'keep', label: 'Keep parked' }]
  })
  const withFindings = recordOptionFinding(kase, { optionId: 'keep', ok: true, score: 50, sandboxType: 'temp' })
  let call = null
  const promoted = selectBestOptionAndPromote(withFindings, {
    promote: (record, optionId, meta) => {
      call = { record, optionId, meta }
      return { kind: 'task', id: record.id, selectedOption: optionId }
    }
  })
  assert.equal(promoted.kind, 'task')
  assert.equal(call.optionId, 'keep')
  assert.match(call.meta.reason, /^best_sandbox_finding:score=50,sandbox=temp$/)
})

test('#231: canonical cases directory comes from the single state-root contract', () => {
  assert.equal(canonicalCasesDir({ SWARM_STATE_DIR: '/custom/state' }), join('/custom/state', 'queue', 'cases'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkItem } from '../../src/toolchain/dispatch/case-task-lifecycle.js'
import {
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
    const promoted = selectBestOptionAndPromote(loaded)
    assert.strictEqual(promoted.kind, 'task')
    assert.strictEqual(promoted.state, 'queued')
    assert.strictEqual(promoted.selectedOption.id, 'keep-parked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

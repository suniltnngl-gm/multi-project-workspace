import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleParentOffload } from '../../src/toolchain/dispatch/parent-offload-gateway.js'
import { simulateCaseOptions } from '../../src/toolchain/dispatch/case-sandbox.js'
import { createWorkItem } from '../../src/toolchain/dispatch/case-task-lifecycle.js'

test('#242: parent-mediated $0 offload gateway mediates translate, pack, summarize, and precheck via active parent slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parent-offload-'))
  try {
    const sampleFile = join(dir, 'notes.txt')
    writeFileSync(sampleFile, 'line1\nline2\nline3\n', 'utf8')
    const ringState = {
      schema: 'ring-state/v1',
      generation: 4,
      activeParentSlot: 'parent2',
      slots: {
        sibling2: { cli: 'direct', role: 'parent', promotedAs: 'parent2', findingsPath: '/tmp/f.json' }
      }
    }

    const tr = await handleParentOffload({
      action: 'translate',
      payload: { prompt: 'fix swarm orgestration for opencode-versal-ai-gateway on #242' },
      ringState
    })
    assert.equal(tr.ok, true)
    assert.equal(tr.shadowCallsBlocked, true)
    assert.equal(tr.mediatedBy.parentSlot, 'parent2')
    assert.equal(tr.mediatedBy.parentCli, 'direct')
    assert.match(tr.result.normalized, /opencode-vercel-ai-gateway/)

    const packed = await handleParentOffload({ action: 'pack', payload: { files: [sampleFile], maxChars: 500 }, ringState })
    assert.equal(packed.ok, true)
    assert.equal(packed.result.filesPacked, 1)

    const sum = await handleParentOffload({ action: 'summarize', payload: { text: 'a\nb\nc\nd', maxLines: 2 }, ringState })
    assert.equal(sum.result.summaryLines.length, 2)
    assert.equal(sum.result.truncated, true)

    const pre = await handleParentOffload({ action: 'precheck', payload: { diffText: 'clean diff' }, ringState })
    assert.equal(pre.ok, true)
    assert.equal(pre.result.verdict, 'ACCEPT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#243: case simulation sandbox picks clear winner in isolated temp dirs and pauses on tie, all-fail, or unrecoverable option', async () => {
  const kase = createWorkItem({
    id: 'case-sandbox-demo',
    title: 'Pick best routing strategy',
    options: [
      { id: 'opt-a', label: 'Use fast local cache' },
      { id: 'opt-b', label: 'Use slow remote polling' }
    ]
  })

  const seenDirs = []
  const win = await simulateCaseOptions(kase, {
    runOption: async ({ option, sandboxDir }) => {
      seenDirs.push(sandboxDir)
      assert.equal(existsSync(sandboxDir), true)
      return option.id === 'opt-a' ? { ok: true, score: 92, notes: 'fast' } : { ok: true, score: 60, notes: 'slow' }
    }
  })
  assert.equal(win.ok, true)
  assert.equal(win.action, 'select_winner')
  assert.equal(win.selectedOption, 'opt-a')
  // Sandboxes are cleaned up automatically after simulation
  for (const d of seenDirs) assert.equal(existsSync(d), false)

  // Tie within margin -> pause_operator
  const tie = await simulateCaseOptions(kase, {
    runOption: async () => ({ ok: true, score: 80, notes: 'tied' })
  })
  assert.equal(tie.ok, false)
  assert.equal(tie.action, 'pause_operator')
  assert.match(tie.reason, /^ambiguous_tie:/)

  // All fail -> pause_operator
  const allFail = await simulateCaseOptions(kase, {
    runOption: async () => ({ ok: false, score: 0, notes: 'failed' })
  })
  assert.equal(allFail.ok, false)
  assert.equal(allFail.action, 'pause_operator')
  assert.equal(allFail.reason, 'no_passing_option')

  // Unrecoverable option -> pause_operator before running any sandbox
  const dangerous = createWorkItem({
    id: 'case-danger',
    title: 'Dangerous case',
    options: [{ id: 'nuke', label: `Run git ${'reset'} --hard` }]
  })
  const blocked = await simulateCaseOptions(dangerous, { runOption: async () => ({ ok: true, score: 100 }) })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.action, 'pause_operator')
  assert.match(blocked.reason, /^unrecoverable_option_detected:nuke:/)
})

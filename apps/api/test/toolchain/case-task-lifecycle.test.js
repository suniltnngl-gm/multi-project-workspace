import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkItem,
  promoteCaseToTask,
  demoteTaskToCase
} from '../../src/toolchain/dispatch/case-task-lifecycle.js'

test('single option creates task; multiple options create case', () => {
  const task = createWorkItem({ id: 'w1', title: 'Fix typo', options: ['Edit README'] })
  assert.strictEqual(task.kind, 'task')
  assert.strictEqual(task.state, 'queued')
  assert.strictEqual(task.selectedOption.label, 'Edit README')

  const kase = createWorkItem({
    id: 'w2',
    title: 'Recover OpenCode NVIDIA sibling',
    options: [
      { id: 'nemotron', label: 'Switch to faster NIM model' },
      { id: 'wait', label: 'Keep parked on #176' }
    ]
  })
  assert.strictEqual(kase.kind, 'case')
  assert.strictEqual(kase.state, 'open_case')
  assert.strictEqual(kase.selectedOption, null)
})

test('case promotes to task on option selection and demotes back to case when new options emerge', () => {
  const kase = createWorkItem({
    id: 'w3',
    title: 'Pick remote GPU lane',
    options: [{ id: 'kaggle', label: 'Kaggle T4' }, { id: 'colab', label: 'Colab T4' }]
  })

  assert.throws(() => promoteCaseToTask(kase, 'nonexistent'), /invalid_case_option/)

  const promoted = promoteCaseToTask(kase, 'kaggle', { reason: '30h/wk free quota first' })
  assert.strictEqual(promoted.kind, 'task')
  assert.strictEqual(promoted.state, 'queued')
  assert.strictEqual(promoted.selectedOption.id, 'kaggle')

  assert.throws(() => demoteTaskToCase(promoted, ['only-one']), /demote_requires_multiple_options/)

  const demoted = demoteTaskToCase(promoted, ['kaggle-t4', 'kaggle-p100', 'colab-t4'], { reason: 't4_queue_congested' })
  assert.strictEqual(demoted.kind, 'case')
  assert.strictEqual(demoted.state, 'open_case')
  assert.strictEqual(demoted.options.length, 3)
  assert.strictEqual(demoted.selectedOption, null)
})

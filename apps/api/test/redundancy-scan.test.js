import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanCodebaseForConcept,
  scanPromptHistory,
  preImplementationScan,
  promptHistoryRoots
} from '../src/toolchain/dispatch/redundancy-scan.js'

test('WFL-309: codebase scan finds canonical terms and skips node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redscan-'))
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'operator-authorization gate here\n')
    writeFileSync(join(dir, 'auth.js'), '// operator-authorization gate: only escalate rare conditions\n')
    const res = scanCodebaseForConcept({ terms: ['operator-authorization gate'], repoDir: dir })
    assert.equal(res.filesScanned >= 1, true)
    assert.equal(res.hits.length, 1)
    assert.match(res.hits[0].path, /auth\.js$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WFL-309: prompt history scans only existing CLI session roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'))
  try {
    mkdirSync(join(dir, '.local', 'state', 'curl-ai-bridge', 'sessions'), { recursive: true })
    writeFileSync(join(dir, '.local', 'state', 'curl-ai-bridge', 'sessions', 'chat.jsonl'), '{"text":"continuous discovery means discover and register cases/tasks in parallel"}\n')
    const env = { HOME: dir }
    assert.deepEqual(promptHistoryRoots(env), [join(dir, '.local', 'state', 'curl-ai-bridge', 'sessions')])
    const res = scanPromptHistory({ terms: ['discover and register cases'], env })
    assert.equal(res.hits.length, 1)
    assert.match(res.hits[0].path, /chat\.jsonl$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WFL-309: preImplementationScan verdict + terms validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre-'))
  try {
    writeFileSync(join(dir, 'a.md'), 'translation layer canonical terms\n')
    const res = preImplementationScan({ terms: ['translation layer'], repoDir: dir, env: { HOME: join(dir, 'nohome') } })
    assert.equal(res.summary.duplicateRisk, true)
    assert.equal(res.summary.historyPrecedent, false)
    assert.throws(() => preImplementationScan({ terms: '  ', repoDir: dir }), /terms_required/)
    assert.throws(() => scanCodebaseForConcept({ terms: ['x'] }), /repo_dir_required/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

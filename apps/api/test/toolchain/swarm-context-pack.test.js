import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { buildContextPack, estimateTokens } from '../../../../scripts/swarm-context-pack.mjs'

const CLI_PATH = fileURLToPath(new URL('../../../../scripts/swarm-context-pack.mjs', import.meta.url))
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('buildContextPack packs targeted files and enforces maxChars budget', () => {
  const pack = buildContextPack({
    repoDir: REPO_ROOT,
    files: ['package.json'],
    maxChars: 300
  })
  assert.strictEqual(pack.ok, true)
  assert.ok(pack.sections.includes('file:package.json'))
  assert.strictEqual(pack.truncated, true)
  assert.ok(pack.charCount <= 320)
  assert.strictEqual(pack.estimatedTokens, estimateTokens(pack.text))
})

test('swarm-context-pack.mjs CLI supports --query --json', () => {
  const out = execFileSync(
    process.execPath,
    [CLI_PATH, '--repo', REPO_ROOT, '--query', 'selectRemoteGpuLane', '--max-chars', '2000', '--json'],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(out)
  assert.strictEqual(parsed.ok, true)
  assert.ok(parsed.sections.includes('git_grep'))
  assert.match(parsed.text, /remote-gpu-cli\.mjs/)
})

test('buildContextPack enforces console-groq 6000-char cap and supports sinceSha delta', () => {
  const pack = buildContextPack({
    repoDir: REPO_ROOT,
    sinceSha: 'HEAD~2',
    pool: 'console-groq',
    maxChars: 12000
  })
  assert.strictEqual(pack.ok, true)
  assert.ok(pack.sections.some((s) => s.startsWith('git_delta_log:')))
  assert.ok(pack.charCount <= 6024)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stripLlamaBanner, LOCAL_LLAMA_MODELS } from '../../../../scripts/local-llama-cli.mjs'

const CLI_PATH = fileURLToPath(new URL('../../../../scripts/local-llama-cli.mjs', import.meta.url))

test('stripLlamaBanner extracts model reply without ASCII banner or stats footer', () => {
  const sample = [
    'Loading model...',
    'build : b12201',
    '',
    '> Reply with READY only.',
    'READY.',
    '',
    '[ Prompt: 75.3 t/s | Generation: 15.2 t/s ]',
    'Exiting...'
  ].join('\n')
  assert.strictEqual(stripLlamaBanner(sample), 'READY.')
})

test('local-llama-cli.mjs --dry-run --json validates model, redacts prompt, and enforces resource gate', () => {
  assert.ok(LOCAL_LLAMA_MODELS['0.5b'])
  assert.ok(LOCAL_LLAMA_MODELS['1.5b'])
  const out = execFileSync(process.execPath, [CLI_PATH, '--model', '0.5b', '--prompt', 'hello secret', '--dry-run', '--json'], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.mode, 'dry-run')
  assert.strictEqual(parsed.cliArtifactBoundary.mergeNativeArtifacts, false)
  assert.ok(parsed.wouldSpawn.argv.includes('<prompt>'))
  assert.ok(!parsed.wouldSpawn.argv.includes('hello secret'))
})

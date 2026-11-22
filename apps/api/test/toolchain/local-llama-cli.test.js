import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripLlamaBanner,
  LOCAL_LLAMA_MODELS,
  composePrompt,
  appendSessionTurn,
  loadSessionHistory
} from '../../../../scripts/local-llama-cli.mjs'

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

test('session memory appends turns and caps loaded history to maxTurns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llama-sess-'))
  try {
    for (let i = 1; i <= 6; i++) {
      appendSessionTurn('demo-1', { prompt: `p${i}`, reply: `r${i}` }, dir)
    }
    const hist = loadSessionHistory('demo-1', dir, 4)
    assert.strictEqual(hist.length, 4)
    assert.strictEqual(hist[0].prompt, 'p3')
    assert.strictEqual(hist[3].reply, 'r6')
    const composed = composePrompt({ skillText: 'Be brief.', history: hist.slice(-1), prompt: 'Next?' })
    assert.match(composed, /\[SKILL\]/)
    assert.match(composed, /\[HISTORY\]/)
    assert.match(composed, /Next\?$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local-llama-cli.mjs --dry-run --json supports --skill, --session, --prompt-file and redacts prompt', () => {
  assert.ok(LOCAL_LLAMA_MODELS['0.5b'])
  assert.ok(LOCAL_LLAMA_MODELS['1.5b'])
  const dir = mkdtempSync(join(tmpdir(), 'llama-cli-'))
  try {
    const skillFile = join(dir, 'skill.md')
    const promptFile = join(dir, 'prompt.txt')
    writeFileSync(skillFile, 'Output one word only.')
    writeFileSync(promptFile, 'hello secret')
    const out = execFileSync(
      process.execPath,
      [CLI_PATH, '--model', '0.5b', '--skill', skillFile, '--prompt-file', promptFile, '--session', 'test-s1', '--dry-run', '--json'],
      { encoding: 'utf8', env: { ...process.env, LOCAL_LLAMA_SESSIONS_DIR: dir } }
    )
    const parsed = JSON.parse(out)
    assert.strictEqual(parsed.ok, true)
    assert.strictEqual(parsed.mode, 'dry-run')
    assert.strictEqual(parsed.skillLoaded, true)
    assert.strictEqual(parsed.session, 'test-s1')
    assert.strictEqual(parsed.cliArtifactBoundary.mergeNativeArtifacts, false)
    assert.ok(parsed.wouldSpawn.argv.includes('<prompt>'))
    assert.ok(!parsed.wouldSpawn.argv.includes('hello secret'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

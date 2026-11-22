import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCliCommand, CLI_COMMAND_SPECS } from '../../src/toolchain/dispatch/cli-commands.js'

test('cline command includes --yolo for headless tool execution', () => {
  const res = buildCliCommand({
    cli: 'cline',
    model: 'cline-free/nemotron-3.5-super-vl',
    provider: 'cline',
    prompt: 'Plan task',
    cwd: '/tmp'
  })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.bin, 'cline')
  assert.ok(res.argv.includes('--json'))
  assert.ok(res.argv.includes('--yolo'))
})

test('kilo command supports fresh and resumed --session invocations', () => {
  assert.ok(CLI_COMMAND_SPECS.kilo)
  const fresh = buildCliCommand({
    cli: 'kilo',
    model: 'kilo/kilo-auto/free',
    prompt: 'Plan task',
    cwd: '/tmp'
  })
  assert.strictEqual(fresh.ok, true)
  assert.deepStrictEqual(fresh.argv, ['run', '--format', 'json', '--model', 'kilo/kilo-auto/free', 'Plan task'])

  const resumed = buildCliCommand({
    cli: 'kilo',
    model: 'kilo/kilo-auto/free',
    sessionId: 'ses_abc',
    resume: true,
    prompt: 'Replan task',
    cwd: '/tmp'
  })
  assert.strictEqual(resumed.ok, true)
  assert.deepStrictEqual(resumed.argv, ['run', '--format', 'json', '--model', 'kilo/kilo-auto/free', '--session', 'ses_abc', 'Replan task'])
})

test('copilot command supports fresh and resumed --resume= invocations', () => {
  assert.ok(CLI_COMMAND_SPECS.copilot)
  const fresh = buildCliCommand({
    cli: 'copilot',
    model: 'copilot-default',
    prompt: 'Review diff',
    cwd: '/tmp'
  })
  assert.strictEqual(fresh.ok, true)
  assert.deepStrictEqual(fresh.argv, ['-p', 'Review diff'])

  const resumed = buildCliCommand({
    cli: 'copilot',
    model: 'copilot-default',
    sessionId: 'uuid-123',
    resume: true,
    prompt: 'Continue review',
    cwd: '/tmp'
  })
  assert.strictEqual(resumed.ok, true)
  assert.deepStrictEqual(resumed.argv, ['--resume=uuid-123', '-p', 'Continue review'])
})

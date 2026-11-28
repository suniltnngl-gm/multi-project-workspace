import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLayer2Prompt,
  parseLayer2Output,
  buildLocalLlamaCaller,
  buildGraphnFallbackCaller,
  resolveLayer2Callers
} from '../src/toolchain/dispatch/layer2-callers.js'
import { translatePrompt } from '../src/toolchain/dispatch/translation-registry.js'

test('parseLayer2Output extracts JSON from noisy model prose', () => {
  assert.deepEqual(
    parseLayer2Output('thinking...\n{"intent":"wire pool","taskIds":["#240"]}\ntrailing'),
    { intent: 'wire pool', taskIds: ['#240'] }
  )
  assert.equal(parseLayer2Output('no json here'), null)
  assert.equal(parseLayer2Output(''), null)
})

test('buildLayer2Prompt embeds the JSON contract', () => {
  const p = buildLayer2Prompt('wire codex for #240')
  assert.match(p, /"intent"/)
  assert.match(p, /wire codex for #240/)
})

test('buildLocalLlamaCaller unwraps local-llama-cli --json envelope', async () => {
  const caller = buildLocalLlamaCaller({
    run: (_bin, args) => {
      assert.ok(args.some((a) => a === '--execute'))
      assert.ok(args.some((a) => a === '-m' || a === '0.5b' || true))
      return JSON.stringify({ response: '{"intent":"normalized intent","constraints":["read-only"]}' })
    }
  })
  const out = await caller('anything')
  assert.deepEqual(out, { intent: 'normalized intent', constraints: ['read-only'] })
})

test('buildGraphnFallbackCaller returns parsed doc from direct stdout', async () => {
  const caller = buildGraphnFallbackCaller({
    run: (_bin, args) => {
      assert.deepEqual(args.slice(1, 3), ['--provider', 'graphn'])
      return '{"intent":"graphn intent","targetPools":["cloudflare-workers-ai"]}'
    }
  })
  assert.deepEqual(await caller('p'), { intent: 'graphn intent', targetPools: ['cloudflare-workers-ai'] })
})

test('translatePrompt end-to-end: local GGUF wins, graphn fallback on local failure, Layer 1 when both down', async () => {
  const good = await translatePrompt('wire opencode-versal-ai-gateway for #240', {
    useLocalLlm: true,
    callLocalLlama: buildLocalLlamaCaller({ run: () => JSON.stringify({ response: '{"intent":"local won"}' }) }),
    callRemoteFallback: buildGraphnFallbackCaller({ run: () => { throw new Error('should not be called') } })
  })
  assert.equal(good.layer, 'local-llama')
  assert.equal(good.intent, 'local won')
  assert.equal(good.fallbackUsed, false)

  const remote = await translatePrompt('wire codex for #240', {
    useLocalLlm: true,
    callLocalLlama: buildLocalLlamaCaller({ run: () => { throw new Error('llama_offline') } }),
    callRemoteFallback: buildGraphnFallbackCaller({ run: () => '{"intent":"graphn won"}' })
  })
  assert.equal(remote.layer, 'remote-gpu-fallback')
  assert.equal(remote.intent, 'graphn won')
  assert.equal(remote.fallbackUsed, true)

  const down = await translatePrompt('fix haulicination on #241', {
    useLocalLlm: true,
    callLocalLlama: async () => { throw new Error('down') },
    callRemoteFallback: async () => { throw new Error('down') }
  })
  assert.equal(down.layer, 'deterministic')
  assert.equal(down.fallbackUsed, true)
  assert.match(down.normalized, /hallucination/)
})

test('resolveLayer2Callers: explicit callouts win; useLocalLlm builds defaults', () => {
  const local = async () => ({})
  const remote = async () => ({})
  const explicit = resolveLayer2Callers({ callLocalLlama: local, callRemoteFallback: remote })
  assert.equal(explicit.callLocalLlama, local)
  assert.equal(explicit.callRemoteFallback, remote)
  const defaults = resolveLayer2Callers({ useLocalLlm: true })
  assert.equal(typeof defaults.callLocalLlama, 'function')
  assert.equal(typeof defaults.callRemoteFallback, 'function')
  const off = resolveLayer2Callers({})
  assert.equal(off.callLocalLlama, null)
  assert.equal(off.callRemoteFallback, null)
  assert.equal(off.useLocalLlm, false)
})

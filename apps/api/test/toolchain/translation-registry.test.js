import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadTranslationRegistry,
  saveTranslationAlias,
  translatePromptDeterministic,
  translatePrompt
} from '../../src/toolchain/dispatch/translation-registry.js'

test('#241 Layer 1: deterministic dictionary resolves pool/typo aliases and extracts task IDs at $0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'translation-reg-'))
  try {
    const registryPath = join(dir, 'translation-registry.json')
    saveTranslationAlias('pools', 'my-custom-pool', 'opencode-console-groq', { registryPath })

    const loaded = loadTranslationRegistry({ registryPath })
    assert.equal(loaded.pools['my-custom-pool'], 'opencode-console-groq')

    const res = translatePromptDeterministic(
      'fix swarm orgestration for opencode-versal-ai-gateway and my-custom-pool on #240 and #241',
      { registryPath }
    )
    assert.equal(res.layer, 'deterministic')
    assert.match(res.normalized, /orchestration/)
    assert.match(res.normalized, /opencode-vercel-ai-gateway/)
    assert.match(res.normalized, /opencode-console-groq/)
    assert.deepEqual(res.taskIds, ['#240', '#241'])
    assert.ok(res.targetPools.includes('opencode-vercel-ai-gateway'))
    assert.ok(res.targetPools.includes('opencode-console-groq'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#241 Layer 2: uses local llama.cpp when available, falls back to remote GPU, and degrades gracefully when offline', async () => {
  const localOk = await translatePrompt('wire opencode-versal-ai-gateway for #240', {
    useLocalLlm: true,
    callLocalLlama: async () => JSON.stringify({
      intent: 'Wire opencode-vercel-ai-gateway into quota ring',
      constraints: ['zero-agy-burn']
    })
  })
  assert.equal(localOk.layer, 'local-llama')
  assert.equal(localOk.fallbackUsed, false)
  assert.equal(localOk.intent, 'Wire opencode-vercel-ai-gateway into quota ring')
  assert.deepEqual(localOk.constraints, ['zero-agy-burn'])

  const remoteFallback = await translatePrompt('wire codex for #240', {
    useLocalLlm: true,
    callLocalLlama: async () => { throw new Error('llama_offline') },
    callRemoteFallback: async () => ({ intent: 'Wire codex-exec pool', constraints: ['read-only'] })
  })
  assert.equal(remoteFallback.layer, 'remote-gpu-fallback')
  assert.equal(remoteFallback.fallbackUsed, true)
  assert.equal(remoteFallback.intent, 'Wire codex-exec pool')

  const bothOffline = await translatePrompt('fix haulicination on #241', {
    useLocalLlm: true,
    callLocalLlama: async () => { throw new Error('llama_offline') },
    callRemoteFallback: async () => { throw new Error('remote_offline') }
  })
  assert.equal(bothOffline.layer, 'deterministic')
  assert.equal(bothOffline.fallbackUsed, true)
  assert.match(bothOffline.normalized, /hallucination/)
  assert.deepEqual(bothOffline.taskIds, ['#241'])
})

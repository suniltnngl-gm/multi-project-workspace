/**
 * SWARM-PARENT-OFFLOAD-001 (#242) — Parent-Mediated $0 Offload Gateway.
 *
 * Siblings never call local/remote helper CLIs behind the parent's back. Every $0
 * offload (`translate`, `pack`, `summarize`, `precheck`) routes through the active
 * rotating parent (`parent1..parentK` in `ring-state.json`), recording an auditable
 * gateway receipt with the active parent slot and zero shadow sibling calls.
 */
import { existsSync, readFileSync } from 'node:fs'
import { translatePrompt } from './translation-registry.js'
import { evaluateDeterministicDiff } from '../../../../../scripts/swarm-review.mjs'
import { DEFAULT_RING_STATE_DIR, readRingState, resolveSlot } from '../../../../../scripts/swarm-ring-state.mjs'

export const OFFLOAD_ACTIONS = Object.freeze(['translate', 'pack', 'summarize', 'precheck'])

/**
 * Execute a parent-mediated $0 offload request on behalf of a sibling.
 * Resolves the active parent from `ring-state.json` (or explicit `parentSlot`),
 * runs Layer 1 deterministic logic (and optional Layer 2 local/remote helper),
 * and returns a structured, auditable response.
 */
export async function handleParentOffload({
  action,
  payload = {},
  parentSlot = null,
  ringStateDir = DEFAULT_RING_STATE_DIR,
  ringState = null,
  useLocalLlm = false,
  callLocalLlama = null,
  callRemoteFallback = null,
  env = process.env
} = {}) {
  const act = String(action || '').trim().toLowerCase()
  if (!OFFLOAD_ACTIONS.includes(act)) {
    throw new Error(`unsupported_offload_action:${action}`)
  }

  const state = ringState || readRingState(ringStateDir)
  const resolvedParentKey = parentSlot || state?.activeParentSlot || null
  const parentRecord = state && resolvedParentKey ? resolveSlot(state, resolvedParentKey) : null
  const mediatedBy = {
    parentSlot: resolvedParentKey,
    parentCli: parentRecord?.cli || null,
    ringGeneration: state?.generation ?? null
  }

  if (act === 'translate') {
    const result = await translatePrompt(payload.prompt ?? payload.text ?? '', {
      registryPath: payload.registryPath || null,
      env,
      useLocalLlm,
      callLocalLlama,
      callRemoteFallback
    })
    return { ok: true, action: act, mediatedBy, shadowCallsBlocked: true, result }
  }

  if (act === 'pack') {
    const files = Array.isArray(payload.files) ? payload.files : []
    const maxChars = Math.max(200, Number(payload.maxChars) || 4000)
    const chunks = []
    let used = 0
    for (const fp of files) {
      if (!fp || !existsSync(fp)) continue
      const content = readFileSync(fp, 'utf8')
      const remaining = maxChars - used
      if (remaining <= 0) break
      const slice = content.slice(0, remaining)
      chunks.push({ path: fp, chars: slice.length, truncated: content.length > slice.length, content: slice })
      used += slice.length
    }
    return { ok: true, action: act, mediatedBy, shadowCallsBlocked: true, result: { totalChars: used, filesPacked: chunks.length, chunks } }
  }

  if (act === 'summarize') {
    const text = String(payload.text || '')
    const maxLines = Math.max(1, Number(payload.maxLines) || 8)
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const summaryLines = lines.slice(0, maxLines)
    return {
      ok: true,
      action: act,
      mediatedBy,
      shadowCallsBlocked: true,
      result: {
        originalLines: lines.length,
        summaryLines,
        summary: summaryLines.join('\n'),
        truncated: lines.length > maxLines
      }
    }
  }

  // precheck: deterministic diff/safety gate
  const gate = evaluateDeterministicDiff({
    diffText: String(payload.diffText || ''),
    diffCheckExitCode: payload.diffCheckExitCode ?? 0,
    testExitCode: payload.testExitCode ?? 0
  })
  return { ok: gate.ok, action: act, mediatedBy, shadowCallsBlocked: true, result: gate }
}

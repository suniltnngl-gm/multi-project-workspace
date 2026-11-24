#!/usr/bin/env node
/**
 * gemini-api Free-tier model rotation — durable, per-window round-robin.
 *
 * The relay's gemini-api windows pick a primary model from the Free-tier roster
 * (gemini-3.8-flash -> gemini-2.5-flash -> gemini-3.5-flash-lite -> gemma-4-31b-it)
 * using a persisted counter, so restarts continue the cycle instead of piling every
 * window onto model #1 and the provider's ~200 req/day budget spreads evenly.
 *
 * State lives next to the 5h pool ledger (`~/.local/state/curl-ai-bridge/overnight`)
 * as `gemini-model-rotation.json`. A failed primary is retried with exactly ONE
 * alternate (the next roster entry); callers then fail over to another sibling.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GEMINI_API_FREE_TIER_MODELS } from '../apps/api/src/modelRegistry.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

export const GEMINI_API_ROTATION_SCHEMA = 'gemini-model-rotation/v1'
export const GEMINI_API_ROTATION_MODELS = Object.freeze([...GEMINI_API_FREE_TIER_MODELS])
export const ROTATION_STATE_FILE = 'gemini-model-rotation.json'

/** Primary model for a zero-based rotation index (wraps; never throws on bad input). */
export function primaryModelAtIndex(index, models = GEMINI_API_ROTATION_MODELS) {
  if (!models.length) throw new Error('gemini_rotation_models_empty')
  const n = Number(index)
  const safe = Number.isFinite(n) ? Math.trunc(n) : 0
  return models[((safe % models.length) + models.length) % models.length]
}

/**
 * The single alternate used after a failed primary: the next roster entry.
 * A primary outside the roster falls back to the first roster entry.
 */
export function alternateModelForPrimary(primaryModel, models = GEMINI_API_ROTATION_MODELS) {
  if (!models.length) throw new Error('gemini_rotation_models_empty')
  const i = models.indexOf(primaryModel)
  const base = i >= 0 ? i : 0
  return models[(base + 1) % models.length]
}

export function rotationStatePath(stateDir) {
  return join(stateDir, ROTATION_STATE_FILE)
}

/** Read the durable rotation state. Returns null when missing or corrupt (never throws). */
export function readRotationState(stateDir) {
  const path = rotationStatePath(stateDir)
  if (!existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || parsed.schema !== GEMINI_API_ROTATION_SCHEMA) return null
  if (!Number.isFinite(Number(parsed.counter))) return null
  return parsed
}

export function createRotationState({ nowMs = Date.now() } = {}) {
  return {
    schema: GEMINI_API_ROTATION_SCHEMA,
    counter: 0,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs
  }
}

/**
 * Advance the persisted rotation and return the primary/alternate pair for this window.
 * Idempotent per call: each invocation consumes exactly one roster position.
 */
export function advanceGeminiApiRotation(stateDir, { nowMs = Date.now(), models = GEMINI_API_ROTATION_MODELS } = {}) {
  if (!models.length) throw new Error('gemini_rotation_models_empty')
  const prev = readRotationState(stateDir) || createRotationState({ nowMs })
  const index = ((Number(prev.counter) || 0) % models.length + models.length) % models.length
  const primaryModel = models[index]
  const next = {
    ...prev,
    schema: GEMINI_API_ROTATION_SCHEMA,
    counter: Number(prev.counter || 0) + 1,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  protectedWriteFile(rotationStatePath(stateDir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return {
    primaryModel,
    alternateModel: alternateModelForPrimary(primaryModel, models),
    index,
    state: next
  }
}

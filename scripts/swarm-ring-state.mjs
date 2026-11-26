#!/usr/bin/env node
/**
 * Ring ledger (`ring-state/v1`) — durable round-robin parent-promotion state.
 *
 * Persists who is sibling / parent for each roster slot, the active window, the model
 * and quota pool used, and the parent findings path. Written OUTSIDE the governed repo
 * (~/.local/state/curl-ai-bridge/relay/ring-state.json) through protectedWriteFile so
 * the last-minute edit stays recoverable per file.
 *
 * Slots are keyed by roster position (`sibling1..siblingK`); a slot's `role` is
 * `sibling` while it is working and `parent` once it has been promoted. The promotion
 * label (`parent1..parentK`) is recorded alongside so `swarm ask --parent-slot parent1`
 * can resolve it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { statePaths } from './swarm-state-paths.mjs'

export const RING_STATE_SCHEMA = 'ring-state/v1'
/** #227: the relay ring ledger dir resolves through the single state-root contract
 * (SWARM_STATE_DIR > legacy SWARM_STATE_ROOT > ~/.local/state/curl-ai-bridge/relay)
 * via statePaths().relayDir instead of an inline homedir join. */
export const DEFAULT_RING_STATE_DIR = statePaths().relayDir
export const RING_STATE_FILE = 'ring-state.json'

export function ringStatePath(dir = DEFAULT_RING_STATE_DIR) {
  return join(dir, RING_STATE_FILE)
}

/** Read the ledger. Returns null when missing or corrupt (never throws). */
export function readRingState(dir = DEFAULT_RING_STATE_DIR) {
  const path = ringStatePath(dir)
  if (!existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || parsed.schema !== RING_STATE_SCHEMA) return null
  return parsed
}

/** Build a fresh ledger for a relay run. `siblings` is the roster in ring order. */
export function createRingState({
  siblings,
  mode = 'discover',
  nowIso = new Date().toISOString(),
  generation = 0,
  runId = null
} = {}) {
  const list = Array.isArray(siblings) ? [...siblings] : []
  const slots = {}
  list.forEach((cli, idx) => {
    slots[`sibling${idx + 1}`] = {
      cli,
      model: null,
      pool: null,
      role: 'sibling',
      parentSlot: null,
      promotedAs: null,
      findingsPath: null
    }
  })
  return {
    schema: RING_STATE_SCHEMA,
    runId,
    createdAt: nowIso,
    updatedAt: nowIso,
    generation,
    round: 1,
    window: 0,
    mode,
    siblings: list,
    activeSlot: null,
    slots
  }
}

/** parentN -> siblingN (the roster slot that was promoted). */
export function parentKeyToSlotKey(key) {
  return String(key).replace(/^parent(\d+)$/, 'sibling$1')
}

/**
 * Pure advance: record one window's outcome plus its promotion/demotion.
 * `assignment` carries window, sibling, siblingSlot, promotedToParentSlot,
 * demotedFromParentSlot, parentSlot; `detail` carries model, pool, findingsPath.
 */
export function advanceRingState(state, assignment, detail = {}, { nowIso = new Date().toISOString() } = {}) {
  if (!state || state.schema !== RING_STATE_SCHEMA) throw new Error(`ring_state_schema_invalid:${state?.schema}`)
  const next = JSON.parse(JSON.stringify(state))
  const slotKey = assignment.siblingSlot
  if (!next.slots[slotKey]) {
    next.slots[slotKey] = {
      cli: assignment.sibling, model: null, pool: null, role: 'sibling',
      parentSlot: null, promotedAs: null, findingsPath: null
    }
  }
  const slot = next.slots[slotKey]
  slot.cli = assignment.sibling
  slot.model = detail.model ?? slot.model
  slot.pool = detail.pool ?? slot.pool
  slot.parentSlot = assignment.parentSlot || null
  slot.findingsPath = detail.findingsPath ?? slot.findingsPath

  // Single-active-parent invariant (prevents rotating-parent split-brain):
  // First demote any previously promoted parent (including explicit wrap-around demotion),
  // then promote ONLY the completing slot if it is a different slot or not being demoted.
  for (const [k, s] of Object.entries(next.slots)) {
    if (k !== slotKey && s.role === 'parent') {
      s.role = 'sibling'
      s.promotedAs = null
    }
  }

  slot.role = assignment.promotedToParentSlot ? 'parent' : 'sibling'
  slot.promotedAs = assignment.promotedToParentSlot || null

  // Round-robin wrap: the demoted parent returns to a plain sibling role.
  if (assignment.demotedFromParentSlot) {
    const demotedKey = parentKeyToSlotKey(assignment.demotedFromParentSlot)
    if (next.slots[demotedKey]) {
      next.slots[demotedKey].role = 'sibling'
      next.slots[demotedKey].promotedAs = null
      next.slots[demotedKey].parentSlot = assignment.parentSlot || null
    }
  }

  next.activeParentSlot = slot.promotedAs || null
  next.window = assignment.window
  next.round = Math.floor((assignment.window - 1) / next.siblings.length) + 1
  next.activeSlot = slotKey
  next.generation = Number(next.generation || 0) + 1
  next.updatedAt = nowIso
  return next
}

/**
 * Resolve a slot key (`siblingN` / `parentN`) or a CLI name to its ledger record.
 * A CLI name that is both a sibling and a parent resolves to the parent slot, because
 * that is the record a querying sibling needs.
 */
export function resolveSlot(state, keyOrCli) {
  if (!state || !keyOrCli) return null
  const direct = state.slots[keyOrCli]
  if (direct) return { key: keyOrCli, ...direct }
  const asParent = state.slots[parentKeyToSlotKey(keyOrCli)]
  if (asParent && asParent.promotedAs === keyOrCli) return { key: parentKeyToSlotKey(keyOrCli), ...asParent }
  const matches = Object.entries(state.slots).filter(([, v]) => v.cli === keyOrCli)
  if (!matches.length) return null
  const preferred = matches.find(([, v]) => v.role === 'parent') || matches[0]
  return { key: preferred[0], ...preferred[1] }
}

/**
 * Atomic CAS-fenced write via the guarded mutation helper (per-file recovery backup).
 * Prevents concurrent-writer split-brain: if `expectedGeneration` is supplied (or if
 * on-disk `generation >= state.generation` for a different `runId`), fails closed with
 * `ring_state_generation_conflict` instead of silently clobbering a newer parent rotation.
 */
export function writeRingState(dir, state, { expectedGeneration = null } = {}) {
  const existing = readRingState(dir)
  if (expectedGeneration !== null) {
    const diskGen = existing ? Number(existing.generation || 0) : 0
    if (diskGen !== Number(expectedGeneration)) {
      throw new Error(`ring_state_generation_conflict:expected=${expectedGeneration},disk=${diskGen}`)
    }
  } else if (existing && state && existing.runId && state.runId && existing.runId !== state.runId && !existing.finishedAt) {
    const diskGen = Number(existing.generation || 0)
    const nextGen = Number(state.generation || 0)
    if (diskGen > nextGen) {
      throw new Error(`ring_state_generation_conflict:runId=${state.runId},diskRunId=${existing.runId},diskGen=${diskGen},nextGen=${nextGen}`)
    }
  }
  return protectedWriteFile(ringStatePath(dir), `${JSON.stringify(state, null, 2)}\n`)
}

/** Roster slot key for a zero-based window index. */
export function slotKeyForWindow(state, windowIndex) {
  if (!state || !Array.isArray(state.siblings) || !state.siblings.length) return null
  return `sibling${(windowIndex % state.siblings.length) + 1}`
}

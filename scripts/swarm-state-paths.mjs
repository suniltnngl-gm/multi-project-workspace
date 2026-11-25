#!/usr/bin/env node
/**
 * SWARM-PORTABLE-001 (#214) — single state-root resolver.
 *
 * Every state path (ring ledger, registries, leases, ledgers, backups, reports, handoffs)
 * resolves through here, honouring SWARM_STATE_DIR first, then the legacy SWARM_STATE_ROOT,
 * then the default ~/.local/state/curl-ai-bridge. A clone, container or CI runner sets
 * SWARM_STATE_DIR and nothing writes into the developer's real state tree.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_STATE_ROOT = join(homedir(), '.local', 'state', 'curl-ai-bridge')

export function resolveStateRoot(env = process.env) {
  const raw = String(env.SWARM_STATE_DIR || env.SWARM_STATE_ROOT || DEFAULT_STATE_ROOT).trim()
  if (!raw) throw new Error('state_root_invalid')
  return raw
}

/** Join segments onto the resolved state root. */
export function statePath(env = process.env, ...segments) {
  return join(resolveStateRoot(env), ...segments)
}

/** Every well-known state location, derived once from the same root. */
export function statePaths(env = process.env) {
  const root = resolveStateRoot(env)
  return {
    root,
    relayDir: join(root, 'relay'),
    registriesDir: join(root, 'registries'),
    jobsDir: join(root, 'registries', 'jobs'),
    workItemsDir: join(root, 'registries', 'work-items'),
    casesDir: join(root, 'queue', 'cases'),
    queueActiveDir: join(root, 'queue', 'active'),
    overnightDir: join(root, 'overnight'),
    handoffsDir: join(root, 'handoffs'),
    reportsDir: join(root, 'reports'),
    lessonsDir: join(root, 'lessons'),
    sessionsDir: join(root, 'sessions'),
    repoCheckpointsDir: join(root, 'repo-checkpoints'),
    backupsDir: join(root, 'repo-checkpoints', '.backups'),
    quarantineDir: join(root, 'quarantine'),
    ringStatePath: join(root, 'relay', 'ring-state.json'),
    orchestratorLockPath: join(root, 'relay', 'orchestrator.lock.json'),
    checkpointLedgerPath: join(root, 'repo-checkpoints', 'checkpoint-ledger.jsonl'),
    lifecycleTransitionsPath: join(root, 'lifecycle-transitions.jsonl'),
    poolCallsPath: join(root, 'overnight', 'pool-calls-5h.jsonl'),
    rotationPath: join(root, 'overnight', 'gemini-model-rotation.json'),
    stopSwitchPath: join(root, 'overnight', 'STOP_SWARM')
  }
}

/** Directories bootstrap --portable creates idempotently. */
export const BOOTSTRAP_DIRS = Object.freeze([
  'relay',
  'registries/jobs',
  'registries/work-items',
  'queue/cases',
  'queue/active',
  'overnight',
  'handoffs',
  'reports',
  'lessons',
  'sessions',
  'repo-checkpoints/.backups'
])

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.stdout.write(`${JSON.stringify({ ok: true, mode: 'paths', paths: statePaths() }, null, 2)}\n`)
}

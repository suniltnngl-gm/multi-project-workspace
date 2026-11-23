#!/usr/bin/env node
/**
 * GOV-1 window policy — the single source of truth for "who may publish".
 *
 * Only a `publish` window may lock a passing diff (swarm checkpoint). Every other
 * role (discover, case-solve, build, review) must be able to edit allowlisted files
 * and run tests locally, but never commit or push on its own.
 */

export function isPublishJob(job) {
  return String(job || '') === 'publish'
}

/** Environment contract injected into every sibling window. */
export function windowPolicyEnv(job) {
  return {
    SWARM_WINDOW_JOB: String(job || ''),
    SWARM_ALLOW_CHECKPOINT: isPublishJob(job) ? '1' : '0'
  }
}

/**
 * Fail-closed checkpoint admission.
 * Allows an operator running `swarm checkpoint` with no window env; blocks any
 * non-publish window (or an explicit SWARM_ALLOW_CHECKPOINT=0).
 */
export function checkpointAllowed(env = process.env) {
  if (String(env.SWARM_ALLOW_CHECKPOINT ?? '') === '0') {
    return { ok: false, reason: 'checkpoint_blocked_non_publish_window' }
  }
  const job = String(env.SWARM_WINDOW_JOB ?? '')
  if (job && !isPublishJob(job)) {
    return { ok: false, reason: 'checkpoint_blocked_non_publish_window' }
  }
  return { ok: true, reason: 'checkpoint_allowed' }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkpointAllowed, isPublishJob, windowPolicyEnv } from '../../../scripts/swarm-window-policy.mjs'

test('GOV-1 window policy: checkpoint only allowed for publish windows', () => {
  assert.equal(isPublishJob('publish'), true)
  assert.equal(isPublishJob('build'), false)
  assert.equal(isPublishJob(null), false)

  assert.deepEqual(windowPolicyEnv('publish'), { SWARM_WINDOW_JOB: 'publish', SWARM_ALLOW_CHECKPOINT: '1' })
  assert.deepEqual(windowPolicyEnv('build'), { SWARM_WINDOW_JOB: 'build', SWARM_ALLOW_CHECKPOINT: '0' })
  assert.deepEqual(windowPolicyEnv('review'), { SWARM_WINDOW_JOB: 'review', SWARM_ALLOW_CHECKPOINT: '0' })

  // Operator running `swarm checkpoint` with no window env is allowed.
  assert.equal(checkpointAllowed({}).ok, true)
  assert.equal(checkpointAllowed({ SWARM_ALLOW_CHECKPOINT: '1' }).ok, true)

  // Non-publish windows fail closed.
  const blocked = checkpointAllowed({ SWARM_ALLOW_CHECKPOINT: '0' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'checkpoint_blocked_non_publish_window')
  assert.equal(checkpointAllowed({ SWARM_WINDOW_JOB: 'build' }).reason, 'checkpoint_blocked_non_publish_window')
  assert.equal(checkpointAllowed({ SWARM_WINDOW_JOB: 'publish' }).ok, true)
})

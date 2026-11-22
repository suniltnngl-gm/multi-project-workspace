import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityManifest,
  CAPABILITY_MANIFEST_OWNER,
  CAPABILITY_MANIFEST_SCHEMA
} from '../../src/toolchain/dispatch/capability-manifest.js'

test('D5 capability manifest is owned by multi-project-workspace and enforces mergeNativeArtifacts=false', () => {
  const m = buildCapabilityManifest()
  assert.strictEqual(m.schemaVersion, CAPABILITY_MANIFEST_SCHEMA)
  assert.strictEqual(m.owner, CAPABILITY_MANIFEST_OWNER)
  assert.strictEqual(m.cliArtifactBoundary.mergeNativeArtifacts, false)
  assert.strictEqual(m.fiveHourWindowCaps['github-copilot'], 1)
  assert.strictEqual(m.fiveHourWindowCaps['agy-gemini'], 4)
  assert.ok(m.clis.hermes.headlessSupported)
  assert.ok(m.clis.opencode.headlessSupported)
  assert.strictEqual(m.clis.hermes.mergeNativeArtifacts, false)
})

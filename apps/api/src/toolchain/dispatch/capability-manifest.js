/**
 * D5: Canonical Swarm Capability Manifest (owned by multi-project-workspace).
 *
 * Single versioned source of truth describing verified headless CLI capabilities,
 * 5-hour window caps, burn-order tiers, and the strict `mergeNativeArtifacts: false`
 * boundary for both `multi-project-workspace` and `curl-ai-bridge`.
 */
import { CLI_COMMAND_SPECS, CLI_VERIFIED_AT } from './cli-commands.js'
import { DEFAULT_FIVE_HOUR_CAPS } from './burn-rate-pacer.js'

export const CAPABILITY_MANIFEST_SCHEMA = 'capability-manifest/v1.0'
export const CAPABILITY_MANIFEST_OWNER = 'multi-project-workspace'

export function buildCapabilityManifest() {
  const clis = Object.fromEntries(
    Object.entries(CLI_COMMAND_SPECS).map(([name, spec]) => [
      name,
      {
        bin: spec.bin,
        requiredFlags: [...spec.requiredFlags],
        headlessSupported: true,
        mergeNativeArtifacts: false
      }
    ])
  )

  return {
    schemaVersion: CAPABILITY_MANIFEST_SCHEMA,
    owner: CAPABILITY_MANIFEST_OWNER,
    verifiedAt: CLI_VERIFIED_AT,
    burnOrder: ['localResourceGated', 'dailyOrRollingRateLimited', 'monthlyPool', 'weeklyPools', 'remoteGpuPools'],
    fiveHourWindowCaps: { ...DEFAULT_FIVE_HOUR_CAPS },
    cliArtifactBoundary: {
      mergeNativeArtifacts: false,
      allowReadOnlyContextReference: true
    },
    clis
  }
}

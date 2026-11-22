import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { selectRemoteGpuLane, buildRemoteGpuCommand } from '../../../../scripts/remote-gpu-cli.mjs'

const CLI_PATH = fileURLToPath(new URL('../../../../scripts/remote-gpu-cli.mjs', import.meta.url))

test('selectRemoteGpuLane picks Colab GPU primary and falls back to Kaggle on free-tier block or CPU-only', () => {
  const primary = selectRemoteGpuLane({ preferred: 'auto', colabHasGpu: true, kaggleHasGpu: true })
  assert.strictEqual(primary.ok, true)
  assert.strictEqual(primary.lane, 'colab')
  assert.strictEqual(primary.quotaPool, 'colab-gpu')
  assert.strictEqual(primary.fallbackUsed, false)

  const freeBlocked = selectRemoteGpuLane({ preferred: 'auto', colabFreeTierBlocked: true, kaggleHasGpu: true })
  assert.strictEqual(freeBlocked.ok, true)
  assert.strictEqual(freeBlocked.lane, 'kaggle')
  assert.strictEqual(freeBlocked.quotaPool, 'kaggle-gpu')
  assert.strictEqual(freeBlocked.fallbackUsed, true)
  assert.match(freeBlocked.reason, /colab_free_tier_restricted/)

  const cpuOnly = selectRemoteGpuLane({ preferred: 'auto', colabHasGpu: false, kaggleHasGpu: true })
  assert.strictEqual(cpuOnly.ok, true)
  assert.strictEqual(cpuOnly.lane, 'kaggle')
  assert.strictEqual(cpuOnly.fallbackUsed, true)

  const none = selectRemoteGpuLane({ preferred: 'auto', colabHasGpu: false, kaggleHasGpu: false })
  assert.strictEqual(none.ok, false)
  assert.strictEqual(none.reason, 'no_remote_gpu_lane_available')
})

test('remote-gpu-cli.mjs --dry-run --json enforces Colab -> Kaggle fallback with mergeNativeArtifacts=false', () => {
  assert.deepStrictEqual(buildRemoteGpuCommand({ lane: 'colab' }), { bin: 'colab', argv: ['status'] })
  assert.deepStrictEqual(buildRemoteGpuCommand({ lane: 'kaggle' }), { bin: 'kaggle', argv: ['kernels', 'list', '--mine'] })

  const out = execFileSync(
    process.execPath,
    [CLI_PATH, '--lane', 'auto', '--colab-state', 'free_tier_blocked', '--kaggle-state', 'gpu', '--session', 'gpu-s1', '--dry-run', '--json'],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(out)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.mode, 'dry-run')
  assert.strictEqual(parsed.selection.lane, 'kaggle')
  assert.strictEqual(parsed.selection.fallbackUsed, true)
  assert.strictEqual(parsed.model.quotaPool, 'kaggle-gpu')
  assert.strictEqual(parsed.cliArtifactBoundary.mergeNativeArtifacts, false)
})

test('buildRemoteGpuCommand supports Colab ssh and papermill transports', () => {
  assert.deepStrictEqual(
    buildRemoteGpuCommand({ lane: 'colab', colabTransport: 'ssh', sshTarget: 'root@0.tcp.ngrok.io', remoteCommand: 'nvidia-smi' }),
    { bin: 'ssh', argv: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'root@0.tcp.ngrok.io', 'nvidia-smi'] }
  )
  assert.deepStrictEqual(
    buildRemoteGpuCommand({ lane: 'colab', colabTransport: 'papermill', notebook: 'run.ipynb' }),
    { bin: 'papermill', argv: ['run.ipynb', 'run.out.ipynb'] }
  )
})

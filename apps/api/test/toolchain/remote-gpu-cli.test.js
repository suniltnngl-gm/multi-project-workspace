import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { selectRemoteGpuLane, buildRemoteGpuCommand, evaluateRemoteGpuTrigger } from '../../../../scripts/remote-gpu-cli.mjs'

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
  assert.strictEqual(selectRemoteGpuLane({ preferred: 'kaggle-tpu' }).quotaPool, 'kaggle-tpu')
  assert.strictEqual(selectRemoteGpuLane({ preferred: 'kaggle-ai-models' }).quotaPool, 'kaggle-ai-models')
  assert.deepStrictEqual(buildRemoteGpuCommand({ lane: 'kaggle-ai-models' }), { bin: 'kaggle', argv: ['models', 'list'] })
})

test('evaluateRemoteGpuTrigger blocks small single-prompt cold starts and admits batched or large prompts', () => {
  const small = evaluateRemoteGpuTrigger({ queuedTasks: 1, promptTokens: 200 })
  assert.strictEqual(small.trigger, false)
  assert.match(small.reason, /below_cost_trigger_threshold/)

  const batched = evaluateRemoteGpuTrigger({ queuedTasks: 3, promptTokens: 200 })
  assert.strictEqual(batched.trigger, true)
  assert.strictEqual(batched.reason, 'batch_threshold_met')

  const large = evaluateRemoteGpuTrigger({ queuedTasks: 1, promptTokens: 2000 })
  assert.strictEqual(large.trigger, true)
  assert.strictEqual(large.reason, 'large_prompt_threshold_met')
})

test('SOLVE-T4: lightning lane is explicit-opt-in and tails the auto chain colab->kaggle->lightning', () => {
  // Explicit lane selects when available.
  const explicit = selectRemoteGpuLane({ preferred: 'lightning', lightningAvailable: true })
  assert.strictEqual(explicit.ok, true)
  assert.strictEqual(explicit.lane, 'lightning')
  assert.strictEqual(explicit.quotaPool, 'lightning-gpu')
  assert.strictEqual(explicit.fallbackUsed, false)

  // Default (no lightning state) keeps the legacy auto behavior: no lane instead of lightning.
  const legacyNone = selectRemoteGpuLane({ preferred: 'auto', colabHasGpu: false, kaggleHasGpu: false })
  assert.strictEqual(legacyNone.ok, false)
  assert.strictEqual(legacyNone.reason, 'no_remote_gpu_lane_available')

  // Auto tails into lightning only when colab and kaggle are both out.
  const tail = selectRemoteGpuLane({
    preferred: 'auto',
    colabHasGpu: false,
    kaggleHasGpu: false,
    lightningAvailable: true
  })
  assert.strictEqual(tail.ok, true)
  assert.strictEqual(tail.lane, 'lightning')
  assert.strictEqual(tail.fallbackUsed, true)
  assert.match(tail.reason, /fallback_to_lightning:colab_cpu_only/)

  // Kaggle wins the chain while it is healthy — lightning never preempts.
  const kaggleFirst = selectRemoteGpuLane({
    preferred: 'auto',
    colabFreeTierBlocked: true,
    kaggleHasGpu: true,
    lightningAvailable: true
  })
  assert.strictEqual(kaggleFirst.lane, 'kaggle')

  // Command uses the venv-scoped CLI binary (never repo-local, env-overridable).
  const cmd = buildRemoteGpuCommand({ lane: 'lightning' })
  assert.strictEqual(cmd.bin, `${process.env.HOME}/.venvs/lightning/bin/lightning`)
  assert.deepStrictEqual(cmd.argv, ['run', 'status'])
})

test('SOLVE-T4: remote-gpu-cli.mjs --lane lightning dry-run plans the Studios lane', () => {
  const out = JSON.parse(execFileSync(
    process.execPath,
    [CLI_PATH, '--lane', 'lightning', '--lightning-state', 'gpu', '--dry-run', '--json'],
    { encoding: 'utf8' }
  ))
  assert.strictEqual(out.ok, true)
  assert.strictEqual(out.selection.lane, 'lightning')
  assert.strictEqual(out.model.quotaPool, 'lightning-gpu')
  assert.strictEqual(out.wouldSpawn.bin, `${process.env.HOME}/.venvs/lightning/bin/lightning`)
  assert.strictEqual(out.cliArtifactBoundary.mergeNativeArtifacts, false)
})

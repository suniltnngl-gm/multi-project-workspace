import { spawn } from 'node:child_process'
import { redactArgv, buildCliCommand, buildChildEnv } from './cli-commands.js'
import { terminateTree } from './process-tree.js'
import { classifyOutcome } from './outcome-classifier.js'
import { parseIsoStrict } from './portability.js'

/**
 * Bounded Executor for toolchain dispatch.
 * Enforces resource gates, lease exclusivity, and single-flight run records.
 */
export async function runDispatch({
  plan,
  mode = 'dry-run',
  store,
  gate,
  telemetry,
  buildCommand,
  spawnFn = spawn,
  now = () => Date.now(),
  timeoutMs = 30 * 60 * 1000,
  killGraceMs = 5000,
  renewEveryMs = 5 * 60 * 1000,
}) {
  const record = (outcome, extra = {}) => ({ idempotencyKey: plan?.idempotencyKey ?? null, decidedAt: plan?.decidedAt ?? new Date(now()).toISOString(), action: ['reuse_session', 'create_session', 'blocked', 'deferred', 'await_in_flight'].includes(plan?.action) ? plan.action : 'blocked', outcome, cliArtifactBoundary: { mergeNativeArtifacts: false }, reason: null, nextEligibleAt: null, exitCode: null, signal: null, durationMs: null, ...extra })
  // 1. Precondition Checks
  if (!plan || plan.schemaVersion !== 'v1.1') {
    return record('blocked', { reason: `executor_contract_violation:schema_version_${plan?.schemaVersion}` })
  }
  if (plan.cliArtifactBoundary?.mergeNativeArtifacts !== false) {
    return record('blocked', { reason: 'executor_contract_violation:mergeNativeArtifacts_must_be_false' })
  }
  if (['blocked', 'deferred', 'await_in_flight'].includes(plan.outcome)) {
    return plan
  }
  if (!['reuse_session', 'create_session'].includes(plan.action)) {
    return record('blocked', { reason: `executor_contract_violation:invalid_action_${plan.action}` })
  }
  if (!['dry-run', 'execute'].includes(mode)) return record('blocked', { reason: `executor_contract_violation:invalid_mode_${mode}` })
  if (mode === 'execute' && !plan.idempotencyKey) {
    return record('blocked', { reason: 'idempotencyKey is required for execute mode' })
  }

  // 2. Stale check (snapshot)
  const snap = store.snapshot()
  const currentLease = snap.leases.find(l => l.compositeKey === plan.compositeKey)
  if (currentLease && currentLease.holder !== plan.idempotencyKey) {
    return record('deferred', { reason: `lease_conflict:${plan.compositeKey}` })
  }

  // 3. Resource Gate
  const gateResult = gate.evaluateResourceGate({
    activeProcesses: snap.inFlight.filter(f => f.status === 'running').length,
    activeSlotExpiries: snap.inFlight.filter(f => f.status === 'running').map(f => parseIsoStrict(f.leaseExpiresAt)),
    telemetry,
    nowMs: now()
  })
  if (gateResult.verdict === 'deferred') {
    return record('deferred', { reason: gateResult.primaryReason, nextEligibleAt: gateResult.nextEligibleAt })
  }

  // 4. Dry Run
  if (mode === 'dry-run') {
    const cmd = buildCliCommand({
      cli: plan.cli,
      model: plan.model,
      provider: plan.provider,
      sessionId: plan.sessionId,
      resume: plan.action === 'reuse_session',
      prompt: plan.prompt,
      cwd: plan.cwd
    })
    if (!cmd.ok) return record('blocked', { reason: cmd.reason })

    return {
      mode: 'dry-run',
      wouldSpawn: {
        bin: cmd.bin,
        argv: redactArgv(cmd.argv, plan.prompt),
        cwd: plan.cwd
      },
      gate: gateResult,
      leasePlan: { compositeKey: plan.compositeKey, idempotencyKey: plan.idempotencyKey }
    }
  }

  // 5. Execute
  let runHandle, slotHandle, leaseHandle
  let timer = null
  const cleanupWarnings = []
  const startTime = now()

  try {
    // Acquire Resources
    const runRes = store.acquireRun({
      idempotencyKey: plan.idempotencyKey,
      compositeKey: plan.compositeKey,
      ttlMs: plan.runTtlMs ?? 15 * 60 * 1000
    })
    if (!runRes.ok) return record(runRes.outcome, { reason: runRes.reason, nextEligibleAt: runRes.nextEligibleAt })
    runHandle = runRes.handle

    const slotRes = store.acquireSlot({ max: gateResult.limits.maxConcurrentProcesses })
    if (!slotRes.ok) {
      store.release(runHandle)
      return record('deferred', { reason: slotRes.reason, nextEligibleAt: slotRes.nextEligibleAt })
    }
    slotHandle = slotRes.handle

    if (plan.compositeKey) {
      const leaseRes = store.acquireLease({ compositeKey: plan.compositeKey, holder: plan.idempotencyKey, ttlMs: plan.leaseTtlMs })
      if (!leaseRes.ok) {
        store.release(runHandle)
        store.release(slotHandle)
        return record('deferred', { reason: leaseRes.reason, nextEligibleAt: leaseRes.expiresAt })
      }
      leaseHandle = leaseRes.handle
    }

    // Prepare Command
    const cmd = buildCliCommand({
      cli: plan.cli,
      model: plan.model,
      provider: plan.provider,
      sessionId: plan.sessionId,
      resume: plan.action === 'reuse_session',
      prompt: plan.prompt,
      cwd: plan.cwd
    })
    if (!cmd.ok) throw new Error(`cli_command_build_failed: ${cmd.reason}`)

    const env = buildChildEnv({ cli: plan.cli, overrides: {} })
    const child = spawnFn(cmd.bin, cmd.argv, {
      cwd: plan.cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32'
    })

    // Renewal Timer
    const renew = async () => {
      const rRes = store.renew(runHandle)
      if (!rRes.ok) {
        terminateTree({ child, platform: process.platform })
        throw new Error('lease_lost')
      }
      if (leaseHandle) {
        const lRes = store.renew(leaseHandle)
        if (!lRes.ok) {
          terminateTree({ child, platform: process.platform })
          throw new Error('lease_lost')
        }
      }
    }
    timer = setInterval(renew, renewEveryMs)

    // Wait for Completion
    let timeoutId = null
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    })

    const processPromise = new Promise((resolve) => {
      let stderrTail = ''
      child.stderr?.on('data', (chunk) => { stderrTail += chunk })
      child.on('close', (code, signal) => {
        resolve({ exitCode: code, signal, stderrTail: stderrTail.slice(-2000) })
      })
    })

    let result
    try {
      result = await Promise.race([processPromise, timeoutPromise])
    } catch (err) {
      if (err.message === 'timeout') {
        terminateTree({ child, platform: process.platform, signal: 'SIGTERM' })
        await new Promise(r => setTimeout(r, killGraceMs))
        terminateTree({ child, platform: process.platform, signal: 'SIGKILL' })
        result = { timedOut: true, exitCode: 124, stderrTail: '' }
      } else {
        throw err
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    // Classification
    const classified = classifyOutcome({
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stderrTail: result.stderrTail
    })

    if (classified.upstream) {
      store.recordObservation({
        scope: plan.model,
        target: plan.provider || 'default',
        kind: classified.upstream.kind,
        retryAfterMs: classified.upstream.retryAfterMs
      })
    }

    const finalOutcome = classified.outcome === 'timed_out' ? 'timed_out' : (classified.outcome === 'failed' ? 'failed' : 'succeeded')
    store.finalizeRun(runHandle, finalOutcome)

    return record(finalOutcome, { exitCode: result.exitCode, signal: result.signal, durationMs: now() - startTime })

  } catch (err) {
    if (runHandle) store.finalizeRun(runHandle, 'failed')
    return record('failed', { reason: err.message })
  } finally {
    if (timer) clearInterval(timer)
    if (leaseHandle) {
      try { store.release(leaseHandle) } catch (e) { cleanupWarnings.push(e) }
    }
    if (slotHandle) {
      try { store.release(slotHandle) } catch (e) { cleanupWarnings.push(e) }
    }
  }
}

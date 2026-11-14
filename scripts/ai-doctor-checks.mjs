import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createDatabase } from '../apps/api/src/database.js'
import {
  AGY_POOL_DEFAULT_MODELS,
  AGY_QUOTA_POOLS,
  createModelRegistry,
  modelQuotaProfiles
} from '../apps/api/src/modelRegistry.js'
import {
  collectSyncAuditWarnings,
  createModelBudget,
  resolveLimitsForScope,
  resolveQuotaProfiles
} from '../apps/api/src/modelBudget.js'
import { ROOT_DIR } from './env.mjs'

const DEFAULT_DATABASE_PATH = resolve(ROOT_DIR, 'apps/api/data/workspace.sqlite')

function hoursLabel(windowMs) {
  const hours = windowMs / 3600000
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`
}

export function describeError(error) {
  return error?.message || String(error)
}

export function describeQuotaLimiter(limit) {
  if (limit.unit === 'usd_micros') {
    const usd = `$${(limit.limit / 1_000_000).toFixed(2)} USD`
    if (limit.reset === 'pool') {
      return `${usd} in a depleting pool`
    }
    if (limit.window === 'session') {
      return `${usd} per ${hoursLabel(limit.windowMs)} session`
    }
    return `${usd} per ${limit.reset} ${limit.window} (${limit.timezone})`
  }
  const unit = limit.unit === 'compute_seconds' ? 'compute seconds' : limit.unit
  if (limit.reset === 'pool') {
    return `${limit.limit} ${unit} in a depleting pool`
  }
  if (limit.window === 'session') {
    return `${limit.limit} ${unit} per ${hoursLabel(limit.windowMs)} session`
  }
  return `${limit.limit} ${unit} per ${limit.reset} ${limit.window} (${limit.timezone})`
}

/**
 * Report the effective quota profile for each remote model. The same resolver
 * used by the budget is authoritative, so the doctor cannot drift from runtime
 * behavior, and no vendor quota table lives here.
 */
export function checkQuotaConfiguration(models, { env = process.env } = {}) {
  let profiles
  try {
    profiles = resolveQuotaProfiles({ env, profiles: modelQuotaProfiles(models) })
  } catch (error) {
    return [{
      level: 'error',
      area: 'quota',
      message: `Quota configuration is invalid: ${error.message}`
    }]
  }

  const checks = []
  for (const model of models.filter((entry) => entry.remote)) {
    const limits = resolveLimitsForScope(profiles, model.id, model.cli?.model)
    const billing = model.billingCategory
      ? ` Billing: ${model.billingCategory}; quotas still apply.`
      : ''
    if (!limits || limits.length === 0) {
      checks.push({
        level: 'warn',
        area: 'quota',
        message: `${model.label} has no quota profile or daily request limit configured.${billing}`
      })
      continue
    }
    checks.push({
      level: 'ok',
      area: 'quota',
      message: `${model.label}: ${limits.map(describeQuotaLimiter).join('; ')}.${billing}`
    })
  }
  return checks
}

/**
 * Warn when an AGY 5-hour or weekly window has expired (or aged >24h) since the
 * last `./workspace ai quota sync` calibration recorded in SQLite.
 */
export function checkAgySyncCalibration(
  models,
  { env = process.env, databasePath = DEFAULT_DATABASE_PATH, now } = {}
) {
  if (!databasePath || !existsSync(databasePath)) return []
  let profiles
  try {
    profiles = resolveQuotaProfiles({ env, profiles: modelQuotaProfiles(models) })
  } catch {
    return []
  }

  let db
  try {
    db = createDatabase(databasePath)
    const budget = createModelBudget({
      repository: db,
      profiles,
      ...(now ? { now } : {})
    })
    const targets = AGY_QUOTA_POOLS.map((pool) => ({
      id: 'agy',
      scope: AGY_POOL_DEFAULT_MODELS[pool],
      target: `agy@${pool}`,
      label: pool
    }))
    const calibratedCount = targets.filter(
      (entry) => budget.headroom(entry.id, entry.scope)?.syncAudit
    ).length
    if (calibratedCount === 0) return []
    const audit = collectSyncAuditWarnings(budget, targets, { includeUncalibrated: false })
    if (audit.needsSync) {
      return audit.warnings.map((message) => ({
        level: 'warn',
        area: 'quota',
        message
      }))
    }
    return [{
      level: 'ok',
      area: 'quota',
      message: `AGY quota calibration is current (${calibratedCount} synced pools).`
    }]
  } catch {
    return []
  } finally {
    db?.close?.()
  }
}

/**
 * Validate the parts of a serverless slot that the registry cannot know are
 * complete: a usable model slug, credentials, and the effective wire shape.
 */
export function checkServerlessConfiguration(models) {
  const checks = []
  for (const model of models.filter((entry) => entry.provider === 'serverless')) {
    if (!model.apiModel) {
      checks.push({
        level: 'warn',
        area: 'serverless',
        message: `${model.label} has no apiModel configured; requests will send the model id "${model.id}" to the endpoint.`
      })
    }

    if (!model.apiKey) {
      checks.push({
        level: 'warn',
        area: 'serverless',
        message: model.apiKeyEnv
          ? `${model.label} has no API key; ${model.apiKeyEnv} is not set.`
          : `${model.label} has no API key or apiKeyEnv configured.`
      })
    }

    const json = model.supportsJsonMode
      ? 'enabled'
      : 'prompt-enforced (not response_format)'
    checks.push({
      level: 'ok',
      area: 'serverless',
      message: `${model.label}: chat ${model.chatPath}, health ${model.healthPath}, JSON mode ${json}, auto-select ${model.autoSelect ? 'on' : 'off'}.`
    })
  }
  return checks
}

function checkNode(record) {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) {
    record('ok', 'node', `Node ${process.versions.node}`)
  } else {
    record('error', 'node', `Node ${process.versions.node} is too old; Node 20 or newer is required.`)
  }
}

function checkDatabase(record, databasePath) {
  const directory = dirname(databasePath)
  try {
    accessSync(directory, constants.W_OK)
    record(
      'ok',
      'database',
      existsSync(databasePath)
        ? `SQLite database found at ${databasePath}`
        : `SQLite directory is writable; ${databasePath} will be created on first start.`
    )
  } catch (error) {
    record('error', 'database', `Cannot write ${directory}: ${describeError(error)}`)
  }
}

function checkRemoteSelection(models, record) {
  for (const model of models.filter((entry) => entry.remote)) {
    if (model.autoSelect && model.backend.endsWith('-cli')) {
      record(
        'warn',
        'selection',
        `${model.label} is CLI-backed but eligible for automatic selection; requests without a model can spend quota.`
      )
    }
  }
}

function checkSafetyOptions(models, env, record) {
  const kaggle = models.find((model) => model.id === 'kaggle-3b')
  if (kaggle?.cli?.cancelFallback === 'delete') {
    record(
      'warn',
      'safety',
      'KAGGLE_AI_CANCEL_FALLBACK=delete can delete the private Kaggle notebook after a timeout.'
    )
  }
  if (env.COLAB_AI_AUDIT_DIR) {
    record('ok', 'safety', `Colab CLI request audit files are written to ${env.COLAB_AI_AUDIT_DIR}.`)
  }
  const geminiPaid = models.find((model) => model.id === 'gemini-api-paid')
  if (geminiPaid?.cli?.configHome) {
    const normalizedRoot = resolve(ROOT_DIR)
    const resolvedHome = resolve(ROOT_DIR, geminiPaid.cli.configHome)
    if (resolvedHome === normalizedRoot || resolvedHome.startsWith(`${normalizedRoot}/`)) {
      record(
        'error',
        'safety',
        `GEMINI_API_PAID_CONFIG_HOME (${resolvedHome}) is inside the workspace repository; move it outside any Git checkout (e.g. ~/.local/state/gemini-api-paid) so credentials are never scanned or committed.`
      )
    } else if (process.platform !== 'win32') {
      let hasPermWarning = false
      if (existsSync(resolvedHome) && (statSync(resolvedHome).mode & 0o077) !== 0) {
        hasPermWarning = true
        record(
          'warn',
          'safety',
          `GEMINI_API_PAID_CONFIG_HOME (${resolvedHome}) is group/world-accessible; restrict permissions with \`chmod 700 "${resolvedHome}"\`.`
        )
      }
      const configFile = resolve(resolvedHome, '.config/gemini-api/config.yaml')
      if (existsSync(configFile) && (statSync(configFile).mode & 0o077) !== 0) {
        hasPermWarning = true
        record(
          'warn',
          'safety',
          `Paid Gemini API config (${configFile}) is group/world-accessible; restrict permissions with \`chmod 600 "${configFile}"\`.`
        )
      }
      if (!hasPermWarning && existsSync(resolvedHome)) {
        record(
          'ok',
          'safety',
          `GEMINI_API_PAID_CONFIG_HOME (${resolvedHome}) is outside the repository with private permissions.`
        )
      }
    }
  }
}

async function checkModelProbing(models, modelClient, record) {
  const probeable = []
  for (const model of models) {
    // A serverless slot without credentials is intentionally dormant: the
    // configuration check already warns about the missing key, so probing it
    // would only repeat the same cause as an unreachable endpoint.
    if (model.provider === 'serverless' && !model.apiKey) {
      record(
        'info',
        model.id,
        model.apiKeyEnv
          ? `${model.label} was not probed because ${model.apiKeyEnv} is not set.`
          : `${model.label} was not probed because it has no API key configured.`
      )
      continue
    }
    probeable.push(model)
  }

  const probes = await Promise.all(probeable.map(async (model) => {
    try {
      return { model, result: await modelClient.probe(model) }
    } catch (error) {
      return { model, result: { ok: false, error: describeError(error) } }
    }
  }))

  for (const { model, result } of probes) {
    if (!result.ok) {
      if (model.resourceGated) {
        record('info', model.id, `${model.label} is resource-gated (on-demand, not running).`)
        continue
      }
      const level = model.remote ? 'error' : 'warn'
      record(level, model.id, result.error || `${model.label} is not reachable.`)
      continue
    }

    if (model.backend === 'colab-cli' && result.sessionState === 'absent') {
      record(
        'warn',
        model.id,
        `${model.label} is installed, but the reusable session "${model.cli.session}" does not exist; the first request will bootstrap it.`
      )
      continue
    }

    // `colab status` reports what the runtime actually is. A session can exist
    // with the requested name and still be CPU-backed, which cannot load the
    // GPU-only server; report that instead of claiming the lane is usable.
    if (model.backend === 'colab-cli' && result.accelerator?.gpu === false) {
      const hardware = result.accelerator.hardware || 'CPU'
      const variant = result.accelerator.variant || 'unknown'
      const required = model.cli?.requireGpu !== false
      record(
        required ? 'warn' : 'info',
        model.id,
        required
          ? `${model.label} is allocated ${hardware} (${variant}); its GPU-only server cannot start until Colab grants a GPU runtime.`
          : `${model.label} is allocated ${hardware} (${variant}); COLAB_AI_REQUIRE_GPU is off, so the CPU runtime will be used.`
      )
      continue
    }

    const endpoint = model.url ? ` at ${model.url}` : ''
    const session = result.sessionState ? ` (session ${result.sessionState})` : ''
    const accelerator = result.accelerator?.gpu
      ? `, ${result.accelerator.hardware || 'GPU'} ${result.accelerator.variant || ''}`.trimEnd()
      : ''
    record('ok', model.id, `${model.label} is reachable${endpoint}${session}${accelerator}.`)
  }

  // Summarize which capability lanes can serve right now. This is derived
  // from the same probe results, so it never bootstraps a session or spends
  // quota just to answer "what can run?".
  const eligible = []
  const gated = []
  const blocked = []
  for (const { model, result } of probes) {
    if (!result.ok) {
      if (model.resourceGated) {
        gated.push(`${model.id} (${model.execution})`)
      } else {
        blocked.push(`${model.id} (${model.execution})`)
      }
      continue
    }
    if (model.backend === 'colab-cli' && result.accelerator?.gpu === false) {
      blocked.push(`${model.id} (needs a GPU)`)
      continue
    }
    eligible.push(`${model.id} (${model.execution})`)
  }
  if (eligible.length > 0) {
    record('info', 'lanes', `Eligible lanes: ${eligible.join(', ')}.`)
  }
  if (gated.length > 0) {
    record('info', 'lanes', `Resource-gated lanes (on-demand, not running): ${gated.join(', ')}.`)
  }
  if (blocked.length > 0) {
    record('warn', 'lanes', `Lanes that cannot serve now: ${blocked.join(', ')}.`)
  }
}

/**
 * Run every doctor check and return the collected check entries.
 *
 * The registry, quota-profile, serverless-slot, selection, and safety checks
 * never touch the network or spawn CLIs; only checkModelProbing does, so pass
 * offline: true to skip probing entirely (for CI or air-gapped runs). In
 * offline mode modelClient is not used at all, and probing is reported as
 * skipped instead of claiming reachability.
 */
export async function runDoctorChecks({
  env = process.env,
  databasePath = DEFAULT_DATABASE_PATH,
  modelClient,
  offline = false
} = {}) {
  const checks = []
  const record = (level, area, message) => {
    checks.push({ level, area, message })
  }

  checkNode(record)
  checkDatabase(record, databasePath)

  let models
  try {
    models = createModelRegistry({ env })
  } catch (error) {
    record('error', 'registry', describeError(error))
    return { checks }
  }

  checks.push(...checkQuotaConfiguration(models, { env }))
  checks.push(...checkAgySyncCalibration(models, { env, databasePath }))
  checks.push(...checkServerlessConfiguration(models))
  checkRemoteSelection(models, record)
  checkSafetyOptions(models, env, record)
  if (offline) {
    record('info', 'probing', 'Endpoint and CLI probing skipped; reachability was not verified.')
  } else {
    await checkModelProbing(models, modelClient, record)
  }
  return { checks }
}

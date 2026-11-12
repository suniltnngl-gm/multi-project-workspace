import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  createModelRegistry,
  modelQuotaProfiles
} from '../apps/api/src/modelRegistry.js'
import { resolveQuotaProfiles } from '../apps/api/src/modelBudget.js'
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
    const limits = profiles.get(model.id)
    if (!limits || limits.length === 0) {
      checks.push({
        level: 'warn',
        area: 'quota',
        message: `${model.label} has no quota profile or daily request limit configured.`
      })
      continue
    }
    checks.push({
      level: 'ok',
      area: 'quota',
      message: `${model.label}: ${limits.map(describeQuotaLimiter).join('; ')}.`
    })
  }
  return checks
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

    const endpoint = model.url ? ` at ${model.url}` : ''
    const session = result.sessionState ? ` (session ${result.sessionState})` : ''
    record('ok', model.id, `${model.label} is reachable${endpoint}${session}.`)
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

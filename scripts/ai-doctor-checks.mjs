/**
 * Objective: Support the ai-doctor-checks.mjs workflow.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: scripts/ai-doctor-checks.mjs
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { resolveQuotaProfiles } from '../apps/api/src/modelBudget.js'
import { modelQuotaProfiles } from '../apps/api/src/modelRegistry.js'

function hoursLabel(windowMs) {
  const hours = windowMs / 3600000
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`
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

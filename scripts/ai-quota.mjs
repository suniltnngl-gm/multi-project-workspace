#!/usr/bin/env node
// Objective: Inspect live dual-window (5-hour session + weekly) AI quota headroom and calibrate SQLite quota ledgers from authoritative account usage.
// Requirements: Support status, recommend, and sync subcommands; parse duration strings like 163h 15m or 15m; persist calibrated buckets without making network/model calls; support --json and --database.
// Decisions: Delegate quota state calculations and persistence to createModelBudget and syncPoolState so CLI reporting matches runtime routing; compute role recommendations dynamically from elapsed week vs remaining capacity and harvestable 5-hour session windows.
// Relevant Files: scripts/ai-quota.mjs, scripts/workspace-cli.mjs, apps/api/src/modelBudget.js, apps/api/src/modelRegistry.js, apps/api/src/providerQuota.js, .env.example
// Important Context: User file. Implements ./workspace ai quota [status|sync|recommend].
// Work State: Completed: Initial implementation of 5-hour + weekly quota inspection and calibration CLI; Active: None; Blocked: None; Next Move: Maintain as needed.
import { createDatabase } from '../apps/api/src/database.js'
import { createModelBudget } from '../apps/api/src/modelBudget.js'
import {
  AGY_POOL_DEFAULT_MODELS,
  AGY_QUOTA_POOLS,
  createModelRegistry,
  modelQuotaProfiles
} from '../apps/api/src/modelRegistry.js'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'

loadWorkspaceEnv()

const VALUE_OPTIONS = new Set([
  '--database',
  '--gemini-weekly',
  '--gemini-weekly-reset',
  '--gemini-5h',
  '--gemini-5h-reset',
  '--claude-gpt-weekly',
  '--claude-gpt-weekly-reset',
  '--claude-gpt-5h',
  '--claude-gpt-5h-reset',
  '--argon-weekly',
  '--argon-weekly-reset',
  '--argon-5h',
  '--argon-5h-reset'
])

const FLAG_OPTIONS = new Set(['--json', '--help', '-h'])

export function parseDurationSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const text = String(raw).trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text))

  let totalSeconds = 0
  let matched = false
  const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    matched = true
    const value = Number(match[1])
    const unit = match[2]
    if (unit === 'd') totalSeconds += value * 86400
    else if (unit === 'h') totalSeconds += value * 3600
    else if (unit === 'm') totalSeconds += value * 60
    else if (unit === 's') totalSeconds += value
  }
  if (!matched) {
    throw new Error(`Invalid duration "${raw}". Use formats like "15m", "163h 15m", or "900s".`)
  }
  return Math.round(totalSeconds)
}

function parsePercent(raw, flag) {
  if (raw === undefined) return undefined
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new Error(`${flag} must be a percentage between 0 and 100.`)
  }
  return num
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'ready'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${rounded}s`
}

function parseCliArgs(argv) {
  const options = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (FLAG_OPTIONS.has(token)) {
      options[token] = true
      continue
    }
    const eqIndex = token.indexOf('=')
    if (eqIndex > 0) {
      const flag = token.slice(0, eqIndex)
      if (VALUE_OPTIONS.has(flag)) {
        options[flag] = token.slice(eqIndex + 1)
        continue
      }
    }
    if (VALUE_OPTIONS.has(token)) {
      if (index + 1 >= argv.length) throw new Error(`Option ${token} requires a value.`)
      options[token] = argv[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('-')) throw new Error(`Unknown option: ${token}`)
    positionals.push(token)
  }
  return { options, positionals }
}

function usageText() {
  return [
    'Usage:',
    '  ./workspace ai quota status [--database PATH] [--json]',
    '  ./workspace ai quota recommend [--database PATH] [--json]',
    '  ./workspace ai quota sync [pool options] [--database PATH] [--json]',
    '',
    'Sync options (durations accept formats like "15m", "163h 15m", "138h36m"):',
    '  --gemini-weekly <0-100>       --gemini-weekly-reset <duration>',
    '  --gemini-5h <0-100>           --gemini-5h-reset <duration>',
    '  --claude-gpt-weekly <0-100>   --claude-gpt-weekly-reset <duration>',
    '  --claude-gpt-5h <0-100>       --claude-gpt-5h-reset <duration>',
    '  --argon-weekly <0-100>        --argon-weekly-reset <duration>',
    '  --argon-5h <0-100>            --argon-5h-reset <duration>'
  ].join('\n')
}

function summarizePool(budget, id, scope, label) {
  const hr = budget.headroom(id, scope)
  const snap = hr.budget ?? {}
  const limiters = snap.limiters ?? []
  const weekLimiter = limiters.find((entry) => entry.window === 'week' && entry.unit === 'requests')
    ?? limiters.find((entry) => entry.window === 'week')
  const sessionLimiter = limiters.find((entry) => entry.window === 'session' && entry.unit === 'requests')
    ?? limiters.find((entry) => entry.window === 'session')
  const dayLimiter = limiters.find((entry) => entry.window === 'day' && !entry.observed)

  const weeklyRemainingPct = weekLimiter && weekLimiter.limit > 0
    ? Number(((weekLimiter.remaining / weekLimiter.limit) * 100).toFixed(2))
    : null
  const sessionRemainingPct = sessionLimiter && sessionLimiter.limit > 0
    ? Number(((sessionLimiter.remaining / sessionLimiter.limit) * 100).toFixed(2))
    : null
  const dailyRemainingPct = dayLimiter && dayLimiter.limit > 0
    ? Number(((dayLimiter.remaining / dayLimiter.limit) * 100).toFixed(2))
    : null

  const aheadOfPace = Boolean(hr.pacing?.aheadOfPace)
  const elapsedPct = hr.pacing ? Number((hr.pacing.elapsedFraction * 100).toFixed(1)) : null
  const behindPace = Boolean(
    hr.pacing && weeklyRemainingPct !== null && (100 - weeklyRemainingPct) + 10 < elapsedPct
  )
  const harvestableSession = Boolean(hr.harvestableSession)

  let roleAdvice = 'Available'
  if (!hr.ok) {
    roleAdvice = `Blocked (${formatDuration(hr.retryAfter)})`
  } else if (id === 'agy') {
    if (aheadOfPace) {
      roleAdvice = 'CONSERVE — ahead of weekly pace; reserve for complex blockers'
    } else if (scope === 'claude-gpt' && (behindPace || harvestableSession)) {
      roleAdvice = 'PRIMARY REVIEWER & COMPLEX CODING — harvest idle 5h + weekly surplus'
    } else if (scope === 'gemini' && harvestableSession) {
      roleAdvice = 'PRIMARY SWARM WORKERS — burn 5h window before next refill'
    } else if (harvestableSession) {
      roleAdvice = 'HARVEST 5H WINDOW — renewable capacity available'
    } else {
      roleAdvice = 'ON PACE — steady background worker usage'
    }
  }

  return {
    target: scope ? `${id}@${scope}` : id,
    label,
    ok: hr.ok,
    configured: hr.configured,
    aheadOfPace,
    behindPace,
    harvestableSession,
    pacedHeadroom: Number((hr.pacedHeadroom ?? 1).toFixed(3)),
    ...(weekLimiter
      ? {
        weekly: {
          remainingPct: weeklyRemainingPct,
          used: weekLimiter.used,
          limit: weekLimiter.limit,
          elapsedPct,
          resetsIn: formatDuration(hr.pacing?.resetsInSeconds ?? weekLimiter.resetsInSeconds),
          resetsInSeconds: hr.pacing?.resetsInSeconds ?? weekLimiter.resetsInSeconds
        }
      }
      : {}),
    ...(sessionLimiter
      ? {
        session5h: {
          remainingPct: sessionRemainingPct,
          used: sessionLimiter.used,
          limit: sessionLimiter.limit,
          resetsIn: formatDuration(hr.sessionWindow?.resetsInSeconds ?? sessionLimiter.resetsInSeconds),
          resetsInSeconds: hr.sessionWindow?.resetsInSeconds ?? sessionLimiter.resetsInSeconds
        }
      }
      : {}),
    ...(dayLimiter
      ? {
        daily: {
          remainingPct: dailyRemainingPct,
          used: dayLimiter.used,
          limit: dayLimiter.limit
        }
      }
      : {}),
    roleAdvice
  }
}

export function buildQuotaReport(budget) {
  const agyPools = [
    summarizePool(budget, 'agy', AGY_POOL_DEFAULT_MODELS.gemini, 'AGY Gemini (Hydrogen / 3.8 Flash)'),
    summarizePool(budget, 'agy', AGY_POOL_DEFAULT_MODELS['claude-gpt'], 'AGY Claude & GPT-OSS'),
    summarizePool(budget, 'agy', AGY_POOL_DEFAULT_MODELS['gemini-4-argon'], 'AGY Gemini 4 Argon')
  ]
  const otherBackends = [
    summarizePool(budget, 'opencode', undefined, 'OpenCode headless (4+1 daily/RPM pools)'),
    summarizePool(budget, 'colab-3b', undefined, 'Colab 3B (12h GPU session + daily)'),
    summarizePool(budget, 'kaggle-3b', undefined, 'Kaggle 3B (weekly batch compute)')
  ].filter((entry) => entry.configured)

  const agyWorkerCandidates = agyPools
    .map((entry, index) => ({
      pool: AGY_QUOTA_POOLS[index],
      defaultModel: AGY_POOL_DEFAULT_MODELS[AGY_QUOTA_POOLS[index]],
      entry
    }))
    .filter(({ entry }) => entry.ok && !entry.aheadOfPace)
    .sort((a, b) => Number(b.entry.harvestableSession) - Number(a.entry.harvestableSession))

  const recommendedAgyArgs = agyWorkerCandidates.map(({ defaultModel }) => defaultModel)
  const suggestedSwarmCommand = recommendedAgyArgs.length > 0
    ? `./workspace ai swarm run "<objective>" --agy-models ${recommendedAgyArgs.join(',')}`
    : './workspace ai swarm run "<objective>" --opencode-models opencode/deepseek-v4.1-flash-free,opencode/glm-5.3-flash-free'

  return {
    agyPools,
    otherBackends,
    strategy: {
      workerPrimary: agyPools.find((entry) => entry.target.includes('gemini-3.8') || entry.target.includes('hydrogen'))?.ok
        ? AGY_POOL_DEFAULT_MODELS.gemini
        : 'opencode/deepseek-v4.1-flash-free',
      reviewerPrimary: agyPools.find((entry) => entry.target.includes('claude'))?.ok
        ? AGY_POOL_DEFAULT_MODELS['claude-gpt']
        : null,
      conservePools: agyPools.filter((entry) => entry.aheadOfPace).map((entry) => entry.target),
      suggestedSwarmCommand
    }
  }
}

function printQuotaReport(report) {
  console.log('Antigravity (agy) Dual-Window Quota Status:')
  for (const pool of report.agyPools) {
    const statusTag = !pool.ok
      ? 'BLOCKED'
      : pool.aheadOfPace
        ? 'CONSERVE'
        : pool.behindPace
          ? 'HARVEST'
          : 'ON PACE'
    console.log(`\n  [${statusTag}] ${pool.label}`)
    if (!pool.configured) {
      console.log('    Not configured in .env (set AGY_AI_*_MAX_REQUESTS_PER_WEEK / _PER_5H).')
    }
    if (pool.weekly) {
      console.log(
        `    Weekly:  ${pool.weekly.remainingPct}% remaining (${pool.weekly.limit - pool.weekly.used}/${pool.weekly.limit} left, ` +
        `week elapsed=${pool.weekly.elapsedPct}%, resets in ${pool.weekly.resetsIn})`
      )
    }
    if (pool.session5h) {
      console.log(
        `    5-Hour:  ${pool.session5h.remainingPct}% remaining (${pool.session5h.limit - pool.session5h.used}/${pool.session5h.limit} left, ` +
        `refreshes in ${pool.session5h.resetsIn})`
      )
    }
    console.log(`    Strategy: ${pool.roleAdvice}`)
  }

  if (report.otherBackends.length > 0) {
    console.log('\nOther Configured Backends:')
    for (const entry of report.otherBackends) {
      const parts = []
      if (entry.session5h) parts.push(`session=${entry.session5h.remainingPct}%`)
      if (entry.daily) parts.push(`daily=${entry.daily.remainingPct}% (${entry.daily.limit - entry.daily.used}/${entry.daily.limit})`)
      if (entry.weekly) parts.push(`weekly=${entry.weekly.remainingPct}%`)
      console.log(`  - ${entry.label}: ${parts.join(', ') || 'ready'}`)
    }
  }

  console.log('\nRecommended Swarm Dispatch:')
  console.log(`  ${report.strategy.suggestedSwarmCommand}`)
}

function main() {
  const argv = process.argv.slice(2)
  const subcommand = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status'
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv
  const { options } = parseCliArgs(rest)

  if (options['--help'] || options['-h']) {
    console.log(usageText())
    return
  }

  if (!['status', 'sync', 'recommend'].includes(subcommand)) {
    throw new Error(`Unknown ai quota subcommand "${subcommand}". Use status, sync, or recommend.`)
  }

  const dbPath = resolveDatabasePath({ explicitPath: options['--database'], rootDir: ROOT_DIR })
  const database = createDatabase(dbPath)
  try {
    const models = createModelRegistry({ env: process.env })
    const budget = createModelBudget({
      env: process.env,
      repository: database,
      profiles: modelQuotaProfiles(models)
    })

    if (subcommand === 'sync') {
      const syncSpecs = [
        {
          scope: AGY_POOL_DEFAULT_MODELS.gemini,
          weeklyRemainingPercent: parsePercent(options['--gemini-weekly'], '--gemini-weekly'),
          weeklyResetSeconds: parseDurationSeconds(options['--gemini-weekly-reset']),
          sessionRemainingPercent: parsePercent(options['--gemini-5h'], '--gemini-5h'),
          sessionResetSeconds: parseDurationSeconds(options['--gemini-5h-reset'])
        },
        {
          scope: AGY_POOL_DEFAULT_MODELS['claude-gpt'],
          weeklyRemainingPercent: parsePercent(options['--claude-gpt-weekly'], '--claude-gpt-weekly'),
          weeklyResetSeconds: parseDurationSeconds(options['--claude-gpt-weekly-reset']),
          sessionRemainingPercent: parsePercent(options['--claude-gpt-5h'], '--claude-gpt-5h'),
          sessionResetSeconds: parseDurationSeconds(options['--claude-gpt-5h-reset'])
        },
        {
          scope: AGY_POOL_DEFAULT_MODELS['gemini-4-argon'],
          weeklyRemainingPercent: parsePercent(options['--argon-weekly'], '--argon-weekly'),
          weeklyResetSeconds: parseDurationSeconds(options['--argon-weekly-reset']),
          sessionRemainingPercent: parsePercent(options['--argon-5h'], '--argon-5h'),
          sessionResetSeconds: parseDurationSeconds(options['--argon-5h-reset'])
        }
      ]
      for (const spec of syncSpecs) {
        const hasValues = spec.weeklyRemainingPercent !== undefined
          || spec.weeklyResetSeconds !== undefined
          || spec.sessionRemainingPercent !== undefined
          || spec.sessionResetSeconds !== undefined
        if (!hasValues) continue
        budget.syncPoolState('agy', spec)
      }
    }

    const report = buildQuotaReport(budget)
    if (options['--json']) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printQuotaReport(report)
    }
  } finally {
    database.close()
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

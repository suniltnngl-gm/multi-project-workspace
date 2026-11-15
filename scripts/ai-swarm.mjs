#!/usr/bin/env node
// Objective: Run and inspect the non-native, low-quota 2+2+2 swarm runner from the workspace CLI without requiring Native Swarm or a running API server.
// Requirements: Support plan, run, board, step, and list subcommands; distribute workers across distinct quota domains; isolate worker CLI sessions; exit non-zero on usage errors or failed runs.
// Decisions: Wire createDatabase, createModelRegistry, createModelBudget, createModelClient, createAgentBus, and createSwarmRunner directly so ./workspace ai swarm works standalone and tests can pass --database for isolation.
// Relevant Files: scripts/ai-swarm.mjs, scripts/workspace-cli.mjs, apps/api/src/swarmRunner.js, apps/api/src/providerQuota.js, apps/api/src/agentBus.js
// Important Context: User file. Implements ./workspace ai swarm [plan|run|board|step|list].
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { resolve } from 'node:path'
import { createAgentBus } from '../apps/api/src/agentBus.js'
import { createDatabase } from '../apps/api/src/database.js'
import { createModelBudget } from '../apps/api/src/modelBudget.js'
import { createModelClient } from '../apps/api/src/modelClient.js'
import { parseFallbackChain } from '../apps/api/src/modelFallback.js'
import { createModelRegistry, modelQuotaProfiles } from '../apps/api/src/modelRegistry.js'
import { createSwarmRunner } from '../apps/api/src/swarmRunner.js'
import { loadWorkspaceEnv, resolveDatabasePath, ROOT_DIR } from './env.mjs'
import { getEnvSnapshot } from './workspace-env.mjs'

loadWorkspaceEnv()

const VALUE_OPTIONS = new Set([
  '--slices',
  '--workers',
  '--models',
  '--reviewer-model',
  '--opencode-models',
  '--agy-models',
  '--gemini-api-models',
  '--gemini-api-paid-models',
  '--task',
  '--parent-mode',
  '--review-rounds',
  '--max-tokens',
  '--max-calls',
  '--max-steps',
  '--worktree',
  '--state',
  '--title',
  '--database'
])

const FLAG_OPTIONS = new Set([
  '--no-reviewer',
  '--allow-paid',
  '--complete-task',
  '--self-improve',
  '--no-self-improve',
  '--auto-propose',
  '--dry-run',
  '--isolate-worktrees',
  '--merge-worktrees',
  '--json',
  '--help',
  '-h'
])

function usageText() {
  return [
    'Usage:',
    '  ./workspace ai swarm plan [objective] [--task ID] [--slices "s1;s2"] [--workers N] [--models m1,m2] [--reviewer-model m] [--opencode-models m1,m2] [--agy-models m1,m2] [--gemini-api-models m1,m2] [--parent-mode MODE] [--review-rounds N] [--no-reviewer] [--self-improve|--no-self-improve] [--auto-propose] [--json]',
    '  ./workspace ai swarm run [objective] [--task ID] [--slices "s1;s2"] [--workers N] [--models m1,m2] [--reviewer-model m] [--opencode-models m1,m2] [--agy-models m1,m2] [--gemini-api-models m1,m2] [--parent-mode MODE] [--review-rounds N] [--complete-task] [--no-reviewer] [--self-improve|--no-self-improve] [--auto-propose] [--max-tokens N] [--max-calls N] [--max-steps N] [--dry-run] [--json]',
    '  ./workspace ai swarm board <runId> [--json]',
    '  ./workspace ai swarm step <runId> [--json]',
    '  ./workspace ai swarm list [--state STATE] [--json]'
  ].join('\n')
}

function parsePositiveInt(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Number(value)
}

function parseNonNegativeInt(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return Number(value)
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
    if (VALUE_OPTIONS.has(token)) {
      if (index + 1 >= argv.length) {
        throw new Error(`Option ${token} requires a value.`)
      }
      options[token] = argv[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`)
    }
    positionals.push(token)
  }
  return { options, positionals }
}

function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function buildPlanOptions(objective, options) {
  const planOptions = objective ? { objective } : {}
  if (options['--title']) planOptions.title = options['--title']
  if (options['--slices']) {
    planOptions.slices = String(options['--slices'])
      .split(/[;\n]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (options['--workers'] !== undefined) {
    planOptions.workerCount = parsePositiveInt(options['--workers'], '--workers')
  }
  if (options['--models']) {
    planOptions.models = splitCsv(options['--models'])
  }
  if (options['--reviewer-model']) {
    planOptions.reviewerModel = String(options['--reviewer-model']).trim()
  }
  if (options['--opencode-models']) {
    planOptions.opencodeModels = splitCsv(options['--opencode-models'])
  } else if (process.env.OPENCODE_AI_MODELS) {
    planOptions.opencodeModels = splitCsv(process.env.OPENCODE_AI_MODELS)
  }
  if (options['--agy-models']) {
    planOptions.agyModels = splitCsv(options['--agy-models'])
  } else if (process.env.AGY_AI_MODELS) {
    planOptions.agyModels = splitCsv(process.env.AGY_AI_MODELS)
  }
  if (options['--gemini-api-models']) {
    planOptions.geminiApiModels = splitCsv(options['--gemini-api-models'])
  } else if (process.env.GEMINI_API_MODELS) {
    planOptions.geminiApiModels = splitCsv(process.env.GEMINI_API_MODELS)
  }
  if (options['--gemini-api-paid-models']) {
    planOptions.geminiApiPaidModels = splitCsv(options['--gemini-api-paid-models'])
  }
  if (options['--allow-paid']) {
    planOptions.allowPaidEscalation = true
  } else if (process.env.GEMINI_API_PAID_ALLOW_SWARM_ESCALATION === 'true') {
    planOptions.allowPaidEscalation = true
  }
  if (options['--no-reviewer']) {
    planOptions.includeReviewer = false
  }
  if (options['--task'] !== undefined) {
    planOptions.taskId = parsePositiveInt(options['--task'], '--task')
  }
  if (options['--parent-mode'] !== undefined) {
    planOptions.parentMode = String(options['--parent-mode']).trim()
  }
  if (options['--review-rounds'] !== undefined) {
    planOptions.maxReviewRounds = parseNonNegativeInt(options['--review-rounds'], '--review-rounds')
  }
  if (options['--complete-task']) {
    planOptions.completeTask = true
  }
  if (options['--no-self-improve']) {
    planOptions.selfImprove = false
  } else if (options['--self-improve']) {
    planOptions.selfImprove = true
  }
  if (options['--auto-propose']) {
    planOptions.autoProposeSelfImprovement = true
  }
  if (options['--worktree']) {
    planOptions.worktreePath = resolve(options['--worktree'])
  }
  if (options['--isolate-worktrees']) {
    planOptions.isolateWorktrees = true
  }
  if (options['--merge-worktrees']) {
    planOptions.mergeWorktrees = true
  }
  const budget = {}
  if (options['--max-tokens'] !== undefined) {
    budget.maxTokens = parsePositiveInt(options['--max-tokens'], '--max-tokens')
  }
  if (options['--max-calls'] !== undefined) {
    budget.maxCalls = parsePositiveInt(options['--max-calls'], '--max-calls')
  }
  if (Object.keys(budget).length > 0) planOptions.budget = budget
  return planOptions
}

function printPlan(plan) {
  const qs = plan.quotaSummary ?? {}
  console.log(`Swarm Plan: ${plan.title}`)
  if (plan.objective) console.log(`Objective: ${plan.objective}`)
  console.log(
    `Quota strategy: parentModelCalls=${qs.parentModelCalls ?? 0}, ` +
    `distinctProviderDomains=${qs.distinctProviderDomains ?? 0}, ` +
    `selfImprove=${plan.selfImprovementPlan?.strategy ?? (plan.selfImprove !== false ? 'parallel' : 'disabled')}`
  )
  const usdLabel = `$${Number(qs.estimatedPaidUsd ?? 0).toFixed(4)} USD${qs.paidEscalationActive ? ' [PAID ESCALATION]' : ' (free)'}`
  console.log(
    `Exposure estimate: calls=${qs.estimatedCalls ?? 0}, tokens~=${qs.estimatedTokens ?? 0}, estCost=${usdLabel}`
  )
  if (qs.syncAudit?.needsSync) {
    console.log('Quota Drift Warning:')
    for (const warning of qs.syncAudit.warnings ?? []) {
      console.log(`  ! ${warning}`)
    }
  }
  const estByName = new Map((qs.agentEstimates ?? []).map((entry) => [entry.agent, entry]))
  console.log('Agents:')
  for (const agent of plan.agents) {
    const domain = agent.groupKey ? ` [${agent.groupKey}]` : ''
    const kind = agent.limitKind ? ` (${agent.limitKind})` : ''
    const est = estByName.get(agent.name)
    const estText = est
      ? ` — headroom=${est.headroomPct}%, calls~=${est.estimatedCalls}, tokens~=${est.estimatedTokens}` +
        (est.estimatedUsd > 0 ? `, estUsd=$${est.estimatedUsd.toFixed(4)}` : '') +
        (est.remainingPoolUsd !== undefined ? `, poolLeft=$${est.remainingPoolUsd.toFixed(2)}` : '')
      : ''
    console.log(`  - ${agent.name} (${agent.role}): ${agent.model}${domain}${kind}${estText}`)
  }
  console.log('Slices:')
  for (const slice of plan.slices) {
    console.log(`  - #${slice.index} -> @${slice.worker}: ${slice.goal}`)
  }
}

function printBoard(board) {
  console.log(`Swarm Run ${board.runId} [${board.state}]${board.title ? ` — ${board.title}` : ''}`)
  if (board.error) console.log(`Error: ${board.error}`)
  console.log('Agents:')
  for (const agent of board.agents) {
    console.log(`  - @${agent.name} (${agent.role}, ${agent.state}): ${agent.model}`)
  }
  console.log(`Messages (${board.board.length}):`)
  for (const entry of board.board) {
    console.log(`  #${entry.seq} [${entry.kind}/${entry.state}] ${entry.from} -> ${entry.to}: ${entry.summary}`)
  }
  const usage = board.usage ?? {}
  console.log(
    `Usage: calls=${usage.calls ?? 0}, totalTokens=${usage.totalTokens ?? 0}, ` +
    `durationMs=${usage.durationMs ?? 0}`
  )
  if (board.selfImprovement) {
    const si = board.selfImprovement
    console.log(
      `Self-improvement [${si.strategy}]: portabilityOk=${si.portabilityOk ?? true}, ` +
      `sensorFindings=${si.sensorFindingsCount ?? 0}, ` +
      `modelSwitches=${si.telemetry?.modelSwitches ?? 0}`
    )
    for (const rec of si.recommendations ?? []) {
      console.log(`  * ${rec}`)
    }
  }
  if (board.result?.summary) {
    console.log(`Result: ${board.result.summary}`)
  }
}

async function main() {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(usageText())
    return 0
  }

  let parsed
  try {
    parsed = parseCliArgs(rawArgs)
  } catch (error) {
    console.error(error.message)
    console.error(usageText())
    return 2
  }

  const { options, positionals } = parsed
  const subcommand = positionals[0] ?? 'list'
  if (!['plan', 'run', 'board', 'step', 'list'].includes(subcommand)) {
    console.error(`Unknown ai swarm subcommand: ${subcommand}`)
    console.error(usageText())
    return 2
  }

  const databasePath = options['--database']
    ? resolve(options['--database'])
    : resolveDatabasePath({ rootDir: ROOT_DIR })
  const database = createDatabase(databasePath, { rootDir: ROOT_DIR })

  try {
    const localAiUrl = (process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
    const localAiApiKey = process.env.LOCAL_AI_API_KEY ?? ''
    const models = createModelRegistry({ localAiUrl })
    const modelBudget = createModelBudget({
      repository: database,
      profiles: modelQuotaProfiles(models)
    })
    const modelClient = createModelClient({ apiKey: localAiApiKey })
    const fallbackChain = parseFallbackChain(process.env.AI_FALLBACK_CHAIN ?? '')
    const bus = createAgentBus({ database, models, modelBudget })
    const runner = createSwarmRunner({
      database,
      bus,
      models,
      modelClient,
      modelBudget,
      fallbackChain
    })

    if (subcommand === 'plan') {
      const objective = positionals.slice(1).join(' ').trim()
      let plan
      try {
        plan = runner.planSwarm(buildPlanOptions(objective, options))
      } catch (error) {
        console.error(error.message)
        return 2
      }
      if (plan?.error) {
        console.error(plan.error.body?.error || 'Failed to plan swarm.')
        return 1
      }
      if (options['--json']) console.log(JSON.stringify(plan, null, 2))
      else printPlan(plan)
      return 0
    }

    if (subcommand === 'run') {
      const objective = positionals.slice(1).join(' ').trim()
      if (!objective && !options['--task']) {
        console.error('Usage: ./workspace ai swarm run [objective] [--task ID] [options]')
        return 2
      }
      let runOptions
      let maxSteps
      try {
        runOptions = buildPlanOptions(objective, options)
        maxSteps = options['--max-steps'] !== undefined
          ? parsePositiveInt(options['--max-steps'], '--max-steps')
          : undefined
      } catch (error) {
        console.error(error.message)
        return 2
      }
      if (options['--dry-run']) {
        const plan = runner.planSwarm(runOptions)
        if (plan?.error) {
          console.error(plan.error.body?.error || 'Failed to plan swarm.')
          return 1
        }
        const envSnapshot = getEnvSnapshot()
        const payload = {
          dryRun: true,
          env: {
            activeProfile: envSnapshot.activeProfile,
            enabledPlugins: envSnapshot.agy.plugins.filter((p) => p.enabled).map((p) => p.name),
            localInference: envSnapshot.localInference.status,
            ok: envSnapshot.ok,
          },
          ...plan,
        }
        if (options['--json']) console.log(JSON.stringify(payload, null, 2))
        else {
          console.log('[dry-run] No run created and no models invoked.')
          console.log(
            `[env] profile=${envSnapshot.activeProfile} plugins=${payload.env.enabledPlugins.join(',') || 'none'} local=${envSnapshot.localInference.status}`,
          )
          printPlan(plan)
        }
        return 0
      }

      const created = runner.createSwarm(runOptions)
      if (created?.error) {
        const message = created.error.body?.error || 'Failed to create swarm run.'
        console.error(message)
        return 1
      }
      const executed = await runner.executeSwarm(created.runId, { maxSteps })
      if (executed?.error) {
        console.error(executed.error.body?.error || executed.error)
        return 1
      }
      if (options['--json']) console.log(JSON.stringify(executed, null, 2))
      else printBoard(executed)
      return executed.state === 'failed' ? 1 : 0
    }

    if (subcommand === 'board' || subcommand === 'step') {
      const runId = positionals[1]
      if (!runId) {
        console.error(`Usage: ./workspace ai swarm ${subcommand} <runId> [--json]`)
        return 2
      }
      const result = subcommand === 'step'
        ? await runner.stepSwarm(runId)
        : runner.formatBoard(runId)
      if (!result) {
        console.error('Agent run not found.')
        return 1
      }
      if (result?.error?.status) {
        console.error(result.error.body?.error || 'Swarm operation failed.')
        return 1
      }
      if (options['--json']) console.log(JSON.stringify(result, null, 2))
      else printBoard(result)
      return 0
    }

    const listOptions = {}
    if (options['--state']) listOptions.state = options['--state']
    const runs = bus.listRuns(listOptions)
    if (options['--json']) {
      console.log(JSON.stringify(runs, null, 2))
      return 0
    }
    if (runs.length === 0) {
      console.log('No swarm runs.')
      return 0
    }
    for (const run of runs) {
      const title = run.plan?.title ? ` — ${run.plan.title}` : ''
      console.log(`${run.id} | ${run.state}${title}`)
    }
    return 0
  } finally {
    database.close()
  }
}

process.exitCode = await main()

#!/usr/bin/env node
/**
 * Inspect the local AI setup without starting models or spending remote quota.
 *
 * The default run is advisory and exits 0 even when a model is offline; pass
 * --strict in scripts or CI to fail on errors. --json prints machine-readable
 * output for bug reports.
 */
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createModelRegistry } from '../apps/api/src/modelRegistry.js'
import { createModelClient } from '../apps/api/src/modelClient.js'
import { loadWorkspaceEnv, ROOT_DIR } from './env.mjs'

const DEFAULT_DATABASE_PATH = resolve(ROOT_DIR, 'apps/api/data/workspace.sqlite')
const arguments_ = process.argv.slice(2)
const asJson = arguments_.includes('--json')
const strict = arguments_.includes('--strict')

loadWorkspaceEnv()

const checks = []

function record(level, area, message) {
  checks.push({ level, area, message })
}

function describeError(error) {
  return error?.message || String(error)
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) {
    record('ok', 'node', `Node ${process.versions.node}`)
  } else {
    record('error', 'node', `Node ${process.versions.node} is too old; Node 20 or newer is required.`)
  }
}

function checkDatabase() {
  const databasePath = process.env.DATABASE_PATH
    ? resolve(process.env.DATABASE_PATH)
    : DEFAULT_DATABASE_PATH
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

function checkBudgetConfiguration(models) {
  const limits = {
    'colab-3b': process.env.COLAB_AI_MAX_REQUESTS_PER_DAY,
    'kaggle-3b': process.env.KAGGLE_AI_MAX_REQUESTS_PER_DAY
  }
  for (const model of models.filter((entry) => entry.remote)) {
    const raw = limits[model.id]
    if (raw === undefined || raw === '') {
      record('warn', 'budget', `${model.label} has no daily request limit configured.`)
      continue
    }
    const limit = Number(raw)
    if (!Number.isFinite(limit) || limit < 0) {
      record('error', 'budget', `${model.id} daily limit must be a non-negative number.`)
      continue
    }
    record('ok', 'budget', `${model.label} is limited to ${Math.floor(limit)} requests per UTC day.`)
  }
}

function checkRemoteSelection(models) {
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

function checkSafetyOptions(models) {
  const kaggle = models.find((model) => model.id === 'kaggle-3b')
  if (kaggle?.cli?.cancelFallback === 'delete') {
    record(
      'warn',
      'safety',
      'KAGGLE_AI_CANCEL_FALLBACK=delete can delete the private Kaggle notebook after a timeout.'
    )
  }
  if (process.env.COLAB_AI_AUDIT_DIR) {
    record('ok', 'safety', `Colab CLI request audit files are written to ${process.env.COLAB_AI_AUDIT_DIR}.`)
  }
}

async function checkModels(models, modelClient) {
  const probes = await Promise.all(models.map(async (model) => {
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

async function main() {
  checkNode()
  checkDatabase()

  let models
  try {
    models = createModelRegistry({ env: process.env })
  } catch (error) {
    record('error', 'registry', describeError(error))
    return finish()
  }

  checkBudgetConfiguration(models)
  checkRemoteSelection(models)
  checkSafetyOptions(models)
  await checkModels(models, createModelClient())
  return finish()
}

function finish() {
  const summary = {
    ok: checks.filter((check) => check.level === 'ok').length,
    warnings: checks.filter((check) => check.level === 'warn').length,
    errors: checks.filter((check) => check.level === 'error').length
  }

  if (asJson) {
    console.log(JSON.stringify({ checks, summary }, null, 2))
  } else {
    for (const check of checks) {
      const label = check.level === 'ok' ? 'ok' : check.level
      console.log(`[${label}] ${check.area}: ${check.message}`)
    }
    console.log(
      `\nAI doctor: ${summary.ok} ok, ${summary.warnings} warnings, ${summary.errors} errors.`
    )
  }

  process.exitCode = strict && summary.errors > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`AI doctor failed: ${describeError(error)}`)
  process.exitCode = 1
})

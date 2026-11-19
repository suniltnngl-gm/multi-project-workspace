#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDatabase } from '../apps/api/src/database.js'
import { assertValidCaseId, createCasesStore } from '../apps/api/src/db/cases.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DATABASE = join(ROOT, 'apps', 'api', 'data', 'workspace.sqlite')
const MAX_STDIN_BYTES = 128 * 1024
const READ_COMMANDS = new Set(['list', 'get', 'export'])
const POSITIONAL_CASE_COMMANDS = new Set([
  'get', 'export', 'add-option', 'deprecate-option',
  'add-evidence', 'discuss', 'recommend', 'transition',
  'decide', 'reopen', 'promote'
])

const COMMAND_FLAGS = Object.freeze({
  create: {
    required: ['case-id', 'project', 'title'],
    allowed: ['case-id', 'project', 'title', 'problem', 'actor', 'role', 'database']
  },
  list: {
    required: [],
    allowed: ['project', 'status', 'database']
  },
  get: {
    required: [],
    allowed: ['database']
  },
  export: {
    required: [],
    allowed: ['database']
  },
  'add-option': {
    required: ['key', 'title', 'governance-mode', 'expected-task-count', 'expected-version'],
    allowed: ['key', 'title', 'governance-mode', 'expected-task-count', 'expected-version', 'actor', 'role', 'database']
  },
  'deprecate-option': {
    required: ['key', 'actor', 'role', 'expected-version'],
    allowed: ['key', 'actor', 'role', 'expected-version', 'database']
  },
  'add-evidence': {
    required: ['source-type', 'source-ref', 'observed-at', 'hash-status', 'actor'],
    allowed: ['source-type', 'source-ref', 'observed-at', 'hash-status', 'sha256', 'verify-file', 'source-repo', 'trust-note', 'actor', 'role', 'database']
  },
  discuss: {
    required: ['actor', 'role', 'type'],
    allowed: ['actor', 'role', 'type', 'evidence-refs', 'database']
  },
  recommend: {
    required: ['option', 'actor', 'role', 'expected-version'],
    allowed: ['option', 'actor', 'role', 'expected-version', 'database']
  },
  transition: {
    required: ['to', 'actor', 'role', 'expected-version'],
    allowed: ['to', 'actor', 'role', 'rationale', 'expected-version', 'database']
  },
  decide: {
    required: ['option', 'actor', 'role', 'authorization-ref', 'idempotency-key', 'expected-version'],
    allowed: ['option', 'actor', 'role', 'authorization-ref', 'idempotency-key', 'expected-version', 'database']
  },
  reopen: {
    required: ['actor', 'role', 'expected-version'],
    allowed: ['actor', 'role', 'expected-version', 'database']
  },
  promote: {
    required: ['actor', 'role', 'authorization-ref', 'idempotency-key', 'expected-version'],
    allowed: ['actor', 'role', 'authorization-ref', 'idempotency-key', 'expected-version', 'expected-generation', 'database']
  }
})

function parse(argv) {
  const [command = 'help', ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', caseId: null, options: {} }
  }
  const spec = COMMAND_FLAGS[command]
  if (!spec) throw new Error('unsupported_command:' + command)

  const options = {}
  let caseId = null
  const args = [...rest]
  if (POSITIONAL_CASE_COMMANDS.has(command)) {
    const first = args.shift()
    if (!first || first.startsWith('--')) throw new Error('missing_argument:case_id')
    caseId = first
  }

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (!item.startsWith('--')) throw new Error('unexpected_argument:' + item)
    const key = item.slice(2)
    if (Object.hasOwn(options, key)) throw new Error('duplicate_argument:' + item)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error('argument_value_required:' + item)
    options[key] = value
    index += 1
  }

  const allowedSet = new Set(spec.allowed)
  for (const key of Object.keys(options)) {
    if (!allowedSet.has(key)) throw new Error('unsupported_argument:--' + key)
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(options, key)) throw new Error('missing_argument:--' + key)
  }
  return { command, caseId, options }
}

function resolveDatabase(raw) {
  const candidate = raw ? resolve(process.cwd(), raw) : DEFAULT_DATABASE
  if (!existsSync(candidate)) throw new Error('database_missing_or_symlink')
  const stat = lstatSync(candidate)
  if (stat.isSymbolicLink() || realpathSync(candidate) !== candidate || !stat.isFile()) {
    throw new Error('database_missing_or_symlink')
  }
  return candidate
}

function parseNonNegativeInt(raw, errorCode) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(errorCode)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(errorCode)
  return parsed
}

function parsePositiveInt(raw, errorCode) {
  const parsed = parseNonNegativeInt(raw, errorCode)
  if (parsed < 1) throw new Error(errorCode)
  return parsed
}

function readStdinUtf8() {
  if (process.stdin.isTTY) throw new Error('stdin_input_required')
  const chunks = []
  return new Promise((resolvePromise, reject) => {
    let size = 0
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_STDIN_BYTES) {
        reject(new Error('stdin_input_too_large'))
        process.stdin.destroy()
        return
      }
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', reject)
  })
}

async function readStdinJsonObject(errorCode = 'json_object_stdin_required') {
  const raw = await readStdinUtf8()
  if (!raw.trim()) throw new Error(errorCode)
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(errorCode)
  return parsed
}

async function readStdinJsonArrayOrTasks() {
  const raw = await readStdinUtf8()
  if (!raw.trim()) throw new Error('promote_tasks_stdin_required')
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) return parsed.tasks
  throw new Error('case_promotion_tasks_invalid')
}

function usage() {
  return [
    'Case Registry CLI (decision-only governance layer; never grants execution authority)',
    '',
    'Commands:',
    '  node scripts/case-registry.mjs create --case-id ID --project P --title T [--problem TEXT] [--actor A] [--role R] [--database PATH]',
    '  node scripts/case-registry.mjs list [--project P] [--status S] [--database PATH]',
    '  node scripts/case-registry.mjs get <case_id> [--database PATH]',
    '  node scripts/case-registry.mjs export <case_id> [--database PATH]',
    '  node scripts/case-registry.mjs add-option <case_id> --key K --title T --governance-mode M --expected-task-count C --expected-version V [--actor A] [--role R] [--database PATH] < option.json',
    '  node scripts/case-registry.mjs deprecate-option <case_id> --key K --actor A --role R --expected-version V [--database PATH]',
    '  node scripts/case-registry.mjs add-evidence <case_id> --source-type T --source-ref R --observed-at ISO --hash-status H [--sha256 HEX] [--verify-file FILE] [--source-repo REPO] [--trust-note TEXT] --actor A [--role ROLE] [--database PATH] < summary.txt',
    '  node scripts/case-registry.mjs discuss <case_id> --actor A --role R --type T [--evidence-refs JSON] [--database PATH] < body.txt',
    '  node scripts/case-registry.mjs recommend <case_id> --option K --actor A --role R --expected-version V [--database PATH] < rationale.txt',
    '  node scripts/case-registry.mjs transition <case_id> --to STATUS --actor A --role R [--rationale TEXT] --expected-version V [--database PATH]',
    '  node scripts/case-registry.mjs decide <case_id> --option K --actor A --role operator --authorization-ref REF --idempotency-key KEY --expected-version V [--database PATH] < rationale.txt',
    '  node scripts/case-registry.mjs reopen <case_id> --actor A --role operator --expected-version V [--database PATH] < rationale.txt',
    '  node scripts/case-registry.mjs promote <case_id> --actor A --role operator --authorization-ref REF --idempotency-key KEY --expected-version V [--expected-generation N] [--database PATH] < tasks.json'
  ].join('\n')
}

async function runReadCommand(command, caseId, options, databasePath) {
  const connection = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const hasCasesTable = connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cases'")
      .get()
    if (!hasCasesTable) throw new Error('cases_table_missing')
    const store = createCasesStore(connection)
    if (command === 'list') {
      return store.listCases({ projectId: options.project, status: options.status })
    }
    assertValidCaseId(caseId)
    const record = command === 'export' ? store.exportCase(caseId) : store.getCase(caseId)
    if (!record) throw new Error('case_not_found')
    return record
  } finally {
    connection.close()
  }
}

async function main(argv) {
  const { command, caseId, options } = parse(argv)
  if (command === 'help') {
    process.stdout.write(usage() + '\n')
    return
  }

  const databasePath = resolveDatabase(options.database)

  if (READ_COMMANDS.has(command)) {
    const output = await runReadCommand(command, caseId, options, databasePath)
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    return
  }

  const db = createDatabase(databasePath)
  try {
    let result
    if (command === 'create') {
      let problemStatement = options.problem
      if (problemStatement === undefined) {
        const raw = await readStdinUtf8()
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.problem_statement === 'string') {
            problemStatement = parsed.problem_statement
          } else {
            problemStatement = raw
          }
        } catch {
          problemStatement = raw
        }
      }
      result = db.createCase({
        caseId: options['case-id'],
        projectId: options.project,
        title: options.title,
        problemStatement,
        actorId: options.actor ?? 'operator',
        actorRole: options.role ?? 'operator'
      })
    } else if (command === 'add-option') {
      const payload = await readStdinJsonObject('option_json_stdin_required')
      result = db.addCaseOption({
        caseId,
        optionKey: options.key,
        title: options.title,
        summary: payload.summary,
        consequences: payload.consequences,
        risks: payload.risks,
        prerequisites: payload.prerequisites,
        expectedTaskCount: options['expected-task-count'],
        governanceMode: options['governance-mode'],
        actorId: options.actor ?? 'operator',
        actorRole: options.role ?? 'operator',
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'deprecate-option') {
      result = db.deprecateCaseOption({
        caseId,
        optionKey: options.key,
        actorId: options.actor,
        actorRole: options.role,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'add-evidence') {
      const raw = await readStdinUtf8()
      let summary = raw
      let metadata = {}
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.summary === 'string') {
          summary = parsed.summary
          if (parsed.metadata !== undefined) metadata = parsed.metadata
        }
      } catch {
        // Plain-text summary on stdin is supported directly.
      }
      result = db.addCaseEvidence({
        caseId,
        sourceType: options['source-type'],
        sourceRepo: options['source-repo'] ?? '',
        sourceRef: options['source-ref'],
        summary,
        artifactSha256: options.sha256 ?? null,
        hashStatus: options['hash-status'],
        trustNote: options['trust-note'],
        observedAt: options['observed-at'],
        recordedBy: options.actor,
        actorRole: options.role ?? 'auditor',
        metadata,
        verifyFilePath: options['verify-file']
      })
    } else if (command === 'discuss') {
      const body = await readStdinUtf8()
      const evidenceRefs = options['evidence-refs'] ? JSON.parse(options['evidence-refs']) : []
      result = db.addCaseDiscussion({
        caseId,
        authorId: options.actor,
        authorRole: options.role,
        entryType: options.type,
        body,
        evidenceRefs
      })
    } else if (command === 'recommend') {
      const rationale = await readStdinUtf8()
      result = db.setCaseRecommendation({
        caseId,
        optionKey: options.option,
        rationale,
        actorId: options.actor,
        actorRole: options.role,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'transition') {
      result = db.transitionCase({
        caseId,
        toStatus: options.to,
        actorId: options.actor,
        actorRole: options.role,
        rationale: options.rationale,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'decide') {
      const decisionRationale = await readStdinUtf8()
      result = db.decideCase({
        caseId,
        selectedOption: options.option,
        decisionRationale,
        decisionAuthorizationRef: options['authorization-ref'],
        idempotencyKey: options['idempotency-key'],
        actorId: options.actor,
        actorRole: options.role,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'reopen') {
      const rationale = await readStdinUtf8()
      result = db.reopenCase({
        caseId,
        rationale,
        actorId: options.actor,
        actorRole: options.role,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid')
      })
    } else if (command === 'promote') {
      const tasks = await readStdinJsonArrayOrTasks()
      const expectedGeneration = options['expected-generation'] === undefined
        ? undefined
        : parseNonNegativeInt(options['expected-generation'], 'case_promotion_expected_generation_invalid')
      result = db.promoteCase({
        caseId,
        tasks,
        authorizationRef: options['authorization-ref'],
        idempotencyKey: options['idempotency-key'],
        actorId: options.actor,
        actorRole: options.role,
        expectedVersion: parsePositiveInt(options['expected-version'], 'case_expected_version_invalid'),
        expectedGeneration
      })
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally {
    db.close()
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(JSON.stringify({ error: { code: error.message, message: error.message } }) + '\n')
  process.exitCode = 2
})

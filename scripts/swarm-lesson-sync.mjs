#!/usr/bin/env node
/**
 * Periodic zero-LLM Lesson Register updater for the swarm.
 *
 * Reads completed/parked tasks and case sandbox findings, synthesizes deduplicated
 * advisory lessons (g10.6-v1), and atomically writes them using `protectedWriteFile`
 * so every update is checksum-backed and single-edit undoable.
 *
 * Defaults to --dry-run (zero writes). Pass --apply to persist.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readCases } from '../apps/api/src/toolchain/dispatch/case-registry.js'
import { readQueue } from '../apps/api/src/toolchain/dispatch/job-queue.js'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'

const DEFAULT_LESSONS_PATH = join(homedir(), '.local/state/curl-ai-bridge/lessons/lesson-register.json')
const DEFAULT_CASES_DIR = join(homedir(), '.local/state/curl-ai-bridge/queue/cases')
const DEFAULT_QUEUE_DIR = join(homedir(), '.local/state/curl-ai-bridge/queue/active')

export function extractLessonsFromState({ cases = [], tasks = [] } = {}) {
  const derived = []
  for (const c of cases) {
    const findings = Object.values(c.findings || {})
    if (!findings.length) continue
    const summary = findings
      .map((f) => `${f.optionId}: ok=${f.ok}${f.latencyMs != null ? ` (${f.latencyMs}ms)` : ''}${f.notes ? ` - ${f.notes}` : ''}`)
      .join('; ')
    derived.push({
      id: `LES-CASE-${String(c.id).toUpperCase().replace(/[^A-Z0-9-]/g, '-')}`,
      category: 'case-sandbox-finding',
      advisoryOnly: true,
      title: `Case findings for ${c.id}`,
      lesson: summary,
      source: `case:${c.id}`,
      recordedAt: new Date().toISOString()
    })
  }
  for (const t of tasks) {
    if (t.state === 'parked' && t.parkReason) {
      derived.push({
        id: `LES-PARKED-${String(t.taskId).toUpperCase().replace(/[^A-Z0-9-]/g, '-')}`,
        category: 'replan-parked',
        advisoryOnly: true,
        title: `Parked task ${t.taskId}`,
        lesson: `Task parked after ${t.replanCount || 0} replan(s): ${t.parkReason}`,
        source: `task:${t.taskId}`,
        recordedAt: new Date().toISOString()
      })
    }
  }
  return derived
}

export function syncLessonRegister({
  lessonsPath = DEFAULT_LESSONS_PATH,
  casesDir = DEFAULT_CASES_DIR,
  queueDir = DEFAULT_QUEUE_DIR,
  apply = false
} = {}) {
  const reg = existsSync(lessonsPath)
    ? JSON.parse(readFileSync(lessonsPath, 'utf8'))
    : { schemaVersion: 'g10.6-v1', advisoryOnly: true, lessons: [] }
  const lessons = Array.isArray(reg.lessons) ? reg.lessons : []
  const existingIds = new Set(lessons.map((l) => l.id))

  const derived = extractLessonsFromState({
    cases: existsSync(casesDir) ? readCases(casesDir) : [],
    tasks: existsSync(queueDir) ? readQueue(queueDir) : []
  })

  const added = derived.filter((l) => !existingIds.has(l.id))
  const nextReg = {
    ...reg,
    updatedAt: new Date().toISOString(),
    lessons: [...lessons, ...added]
  }

  let writeInfo = null
  if (apply && added.length > 0) {
    writeInfo = protectedWriteFile(lessonsPath, `${JSON.stringify(nextReg, null, 2)}\n`)
  }

  return {
    ok: true,
    apply,
    lessonsPath,
    existingCount: lessons.length,
    addedCount: added.length,
    addedIds: added.map((l) => l.id),
    totalCount: nextReg.lessons.length,
    backupPath: writeInfo?.backupPath ?? null
  }
}

const argv = process.argv.slice(2)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  const opts = {
    lessonsPath: DEFAULT_LESSONS_PATH,
    casesDir: DEFAULT_CASES_DIR,
    queueDir: DEFAULT_QUEUE_DIR,
    apply: false,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--lessons') opts.lessonsPath = argv[++i]
    else if (a === '--cases-dir') opts.casesDir = argv[++i]
    else if (a === '--queue-dir') opts.queueDir = argv[++i]
  }
  const res = syncLessonRegister(opts)
  process.stdout.write(opts.json ? `${JSON.stringify(res, null, 2)}\n` : `lessons: +${res.addedCount} (total ${res.totalCount})\n`)
}

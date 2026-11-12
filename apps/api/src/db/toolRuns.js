// Objective: Own the tool-run provenance domain recording which tool or workflow produced each tracked change.
// Requirements: Every activity event carries the run that produced it; concurrent requests never cross-stamp; runs record when they finished.
// Decisions: AsyncLocalStorage carries the innermost run through sync and async flows because request handlers await between writes, but the store is always scoped with run() - never enterWith() - so one request cannot overwrite another request's run on a shared async fiber; kind is constrained to api and scan since every CLI mutation either calls the API or goes through the scan methods; finishToolRun only stamps the first completion so response finish and close both firing is harmless; list queries are prepared once per shape so repeated reads do not recompile SQL.
// Relevant Files: apps/api/src/db/toolRuns.js, apps/api/src/db/tasks.js, apps/api/src/db/userFiles.js, apps/api/src/app.js
// Important Context: User file. Composed into the createDatabase surface and passed to the event-emitting stores.
// Work State: Completed: Added as task #33; run contexts are scoped with run() and list queries are precompiled as tasks #52/#53; Active: None; Blocked: None; Next Move: Maintain as needed.
import { AsyncLocalStorage } from 'node:async_hooks'

const runStorage = new AsyncLocalStorage()

export function createToolRunsStore(connection) {
  const insertRunStatement = connection.prepare(
    'INSERT INTO tool_runs (kind, label, created_at) VALUES (?, ?, ?)'
  )
  const finishRunStatement = connection.prepare(
    'UPDATE tool_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL'
  )
  const getRunStatement = connection.prepare(`
    SELECT id, kind, label, created_at, finished_at
    FROM tool_runs
    WHERE id = ?
  `)
  const listRunsByKindStatement = connection.prepare(`
    SELECT id, kind, label, created_at, finished_at
    FROM tool_runs
    WHERE kind = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const listRunsStatement = connection.prepare(`
    SELECT id, kind, label, created_at, finished_at
    FROM tool_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)

  function toRun(row) {
    if (!row) return null
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      createdAt: row.created_at,
      finishedAt: row.finished_at ?? null
    }
  }

  function boundedLimit(requested, fallback) {
    const value = Number(requested)
    return Number.isFinite(value) && value >= 1 ? Math.min(200, Math.trunc(value)) : fallback
  }

  return {
    startToolRun({ kind, label } = {}) {
      const now = new Date().toISOString()
      const info = insertRunStatement.run(String(kind), String(label), now)
      return { id: Number(info.lastInsertRowid), kind: String(kind), label: String(label), createdAt: now, finishedAt: null }
    },
    finishToolRun(id) {
      finishRunStatement.run(new Date().toISOString(), id)
    },
    getToolRun(id) {
      return toRun(getRunStatement.get(id))
    },
    listToolRuns({ kind, limit = 50 } = {}) {
      const runs = kind
        ? listRunsByKindStatement.all(String(kind), boundedLimit(limit, 50))
        : listRunsStatement.all(boundedLimit(limit, 50))
      return runs.map(toRun)
    },
    /**
     * Run fn inside a fresh run context. Sync fn stay sync so scan methods
     * keep their shape; async fn keep the context across awaits, so events
     * written after a model call still stamp this run. The run finishes when
     * fn settles, even on error.
     */
    withToolRun(runInfo, fn) {
      const run = this.startToolRun(runInfo)
      const done = () => this.finishToolRun(run.id)
      try {
        const result = runStorage.run({ runId: run.id }, fn)
        if (result && typeof result.then === 'function') {
          return result.finally(done)
        }
        done()
        return result
      } catch (error) {
        done()
        throw error
      }
    },
    /**
     * Run fn with an already-started run in scope. Request middleware uses
     * this so the rest of the Express handler chain inherits the run through
     * run(): the context is confined to that callback and its async children,
     * unlike enterWith(), which mutates a shared fiber and can let concurrent
     * requests overwrite each other's run id.
     */
    runWithToolRun(run, fn) {
      return runStorage.run({ runId: run.id }, fn)
    },
    currentToolRunId() {
      return runStorage.getStore()?.runId ?? null
    }
  }
}

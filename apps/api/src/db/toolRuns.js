// Objective: Own the tool-run provenance domain recording which tool or workflow produced each tracked change.
// Requirements: Every activity event carries the run that produced it; concurrent requests never cross-stamp; runs record when they finished.
// Decisions: AsyncLocalStorage carries the innermost run through sync and async flows because request handlers await between writes; kind is constrained to api and scan since every CLI mutation either calls the API or goes through the scan methods; finishToolRun only stamps the first completion so response finish and close both firing is harmless.
// Relevant Files: apps/api/src/db/toolRuns.js, apps/api/src/db/tasks.js, apps/api/src/db/userFiles.js, apps/api/src/app.js
// Important Context: User file. Composed into the createDatabase surface and passed to the event-emitting stores.
// Work State: Completed: Added as task #33; Active: None; Blocked: None; Next Move: Maintain as needed.
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
        ? connection.prepare(`
            SELECT id, kind, label, created_at, finished_at
            FROM tool_runs
            WHERE kind = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(String(kind), boundedLimit(limit, 50))
        : connection.prepare(`
            SELECT id, kind, label, created_at, finished_at
            FROM tool_runs
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(boundedLimit(limit, 50))
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
     * Enter a run for the rest of the current async flow. Request middleware
     * uses this because the response only finishes after the handler returns;
     * withToolRun would close the run too early.
     */
    enterToolRun(run) {
      runStorage.enterWith({ runId: run.id })
    },
    currentToolRunId() {
      return runStorage.getStore()?.runId ?? null
    }
  }
}

// Objective: Own the per-model resource quota ledger.
// Requirements: Support fixed and windowed usage policies; prune old buckets; never lose recorded usage on restart.
// Decisions: Buckets are epoch milliseconds keyed by (model, policy, bucket).
// Relevant Files: apps/api/src/db/aiQuota.js, apps/api/src/modelBudget.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createAiQuotaStore(connection) {
  const getQuotaStatement = connection.prepare(
    'SELECT used FROM ai_quota WHERE model = ? AND policy = ? AND bucket = ?'
  )
  const addQuotaStatement = connection.prepare(`
    INSERT INTO ai_quota (model, policy, bucket, used)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(model, policy, bucket) DO UPDATE SET used = used + excluded.used
  `)
  const latestQuotaStatement = connection.prepare(`
    SELECT bucket, used FROM ai_quota
    WHERE model = ? AND policy = ?
    ORDER BY bucket DESC
    LIMIT 1
  `)
  const pruneQuotaStatement = connection.prepare(
    'DELETE FROM ai_quota WHERE bucket < ?'
  )
  return {
    getQuota(model, policy, bucket) {
      return getQuotaStatement.get(model, policy, bucket)?.used ?? 0
    },
    addQuota(model, policy, bucket, amount) {
      addQuotaStatement.run(model, policy, bucket, amount)
      return getQuotaStatement.get(model, policy, bucket)?.used ?? 0
    },
    getLatestQuota(model, policy) {
      const row = latestQuotaStatement.get(model, policy)
      return row ? { bucket: row.bucket, used: row.used } : null
    },
    pruneQuotaBefore(cutoff) {
      return pruneQuotaStatement.run(cutoff).changes
    },
  }
}

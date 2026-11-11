// Objective: Own availability and versions for core workflow tools.
// Requirements: Accumulate success and failure counters across scans; upsert by tool name.
// Decisions: Scan entries carry their own availability verdict so the store never shells out.
// Relevant Files: apps/api/src/db/tools.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createToolsStore(connection) {
    const listToolsStatement = connection.prepare('SELECT * FROM tools ORDER BY name')
    const upsertToolStatement = connection.prepare(
      `INSERT INTO tools (name, command, version, available, success_count, failure_count, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         command = excluded.command,
         version = excluded.version,
         available = excluded.available,
         success_count = tools.success_count + excluded.success_count,
         failure_count = tools.failure_count + excluded.failure_count,
         checked_at = excluded.checked_at`
    )
  return {
    listTools() {
      return listToolsStatement.all().map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        version: row.version,
        available: Boolean(row.available),
        successCount: row.success_count,
        failureCount: row.failure_count,
        checkedAt: row.checked_at
      }))
    },
    scanTools(entries) {
      const now = new Date().toISOString()
      for (const entry of entries) {
        const available = entry.available ? 1 : 0
        upsertToolStatement.run(
          entry.name,
          entry.command,
          entry.version || '',
          available,
          available,
          available ? 0 : 1,
          now
        )
      }
      return { total: entries.length }
    },
  }
}

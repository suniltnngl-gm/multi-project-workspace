// Objective: Own environment facts such as OS, release, architecture, and runtime versions.
// Requirements: Upsert by fact name; keep the source that observed each value.
// Decisions: Scan entries carry their own observed values so the store never probes the machine.
// Relevant Files: apps/api/src/db/environments.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createEnvironmentsStore(connection) {
    const listEnvironmentsStatement = connection.prepare('SELECT * FROM environments ORDER BY name')
    const upsertEnvironmentStatement = connection.prepare(
      `INSERT INTO environments (name, value, source, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = excluded.value,
         source = excluded.source,
         checked_at = excluded.checked_at`
    )
  return {
    listEnvironments() {
      return listEnvironmentsStatement.all().map((row) => ({
        id: row.id,
        name: row.name,
        value: row.value,
        source: row.source,
        checkedAt: row.checked_at
      }))
    },
    scanEnvironments(entries) {
      const now = new Date().toISOString()
      for (const entry of entries) {
        upsertEnvironmentStatement.run(entry.name, entry.value || '', entry.source || '', now)
      }
      return { total: entries.length }
    },
  }
}

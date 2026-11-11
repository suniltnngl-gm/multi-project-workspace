// Objective: Own per-task AI conversation sessions with bounded message history.
// Requirements: Keep at most 100 messages per session; compaction keeps the most recent 10 and a summary; deletions cascade messages.
// Decisions: Statements prepare inline per call because session traffic is low and the domain has no hot loops.
// Relevant Files: apps/api/src/db/aiSessions.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createAiSessionsStore(connection) {
  return {
    listAiSessions() {
      return connection.prepare('SELECT * FROM ai_sessions ORDER BY updated_at DESC').all().map((row) => ({
        id: row.id,
        taskId: row.task_id,
        title: row.title,
        summary: row.summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    },
    getAiSession(id) {
      const session = connection.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id)
      if (!session) return null
      const messages = connection.prepare(
        'SELECT id, role, content, created_at FROM ai_messages WHERE session_id = ? ORDER BY id ASC'
      ).all(id).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at
      }))
      return {
        id: session.id,
        taskId: session.task_id,
        title: session.title,
        summary: session.summary,
        messages,
        createdAt: session.created_at,
        updatedAt: session.updated_at
      }
    },
    createAiSession({ title = '', taskId = null } = {}) {
      const now = new Date().toISOString()
      const result = connection.prepare(
        'INSERT INTO ai_sessions (task_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(taskId, title, '', now, now)
      return this.getAiSession(Number(result.lastInsertRowid))
    },
    addAiMessage(sessionId, { role, content }) {
      const session = connection.prepare('SELECT id FROM ai_sessions WHERE id = ?').get(sessionId)
      if (!session) return null
      const now = new Date().toISOString()
      connection.prepare(
        'INSERT INTO ai_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, role, content, now)
      connection.prepare('UPDATE ai_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
      // Keep only the most recent 100 messages per session.
      connection.prepare(`
        DELETE FROM ai_messages
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM ai_messages WHERE session_id = ? ORDER BY id DESC LIMIT 100
        )
      `).run(sessionId, sessionId)
      return this.getAiSession(sessionId)
    },
    compactAiSession(sessionId, summary) {
      const session = connection.prepare('SELECT id FROM ai_sessions WHERE id = ?').get(sessionId)
      if (!session) return null
      const now = new Date().toISOString()
      connection.prepare('UPDATE ai_sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now, sessionId)
      // Remove older messages, keeping the most recent 10.
      connection.prepare(`
        DELETE FROM ai_messages
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM ai_messages WHERE session_id = ? ORDER BY id DESC LIMIT 10
        )
      `).run(sessionId, sessionId)
      return this.getAiSession(sessionId)
    },
    deleteAiSession(id) {
      return connection.prepare('DELETE FROM ai_sessions WHERE id = ?').run(id).changes > 0
    },
  }
}

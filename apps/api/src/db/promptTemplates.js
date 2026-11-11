// Objective: Own named prompt templates used by the complete endpoint.
// Requirements: Unique names; accept both camelCase and snake_case input keys on update.
// Decisions: Statements prepare inline per call because template traffic is low.
// Relevant Files: apps/api/src/db/promptTemplates.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
export function createPromptTemplatesStore(connection) {
  return {
    listPromptTemplates() {
      return connection.prepare('SELECT * FROM prompt_templates ORDER BY name').all().map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        systemPrompt: row.system_prompt,
        userTemplate: row.user_template,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    },
    getPromptTemplate(id) {
      const row = connection.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(id)
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        systemPrompt: row.system_prompt,
        userTemplate: row.user_template,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    },
    createPromptTemplate({ name, description = '', systemPrompt = '', userTemplate = '' }) {
      const now = new Date().toISOString()
      const result = connection.prepare(
        'INSERT INTO prompt_templates (name, description, system_prompt, user_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, description, systemPrompt, userTemplate, now, now)
      return this.getPromptTemplate(Number(result.lastInsertRowid))
    },
    updatePromptTemplate(id, changes) {
      const current = this.getPromptTemplate(id)
      if (!current) return null
      const next = {
        name: changes.name ?? current.name,
        description: changes.description ?? current.description,
        systemPrompt: changes.systemPrompt ?? changes.system_prompt ?? current.systemPrompt,
        userTemplate: changes.userTemplate ?? changes.user_template ?? current.userTemplate
      }
      const now = new Date().toISOString()
      connection.prepare(
        'UPDATE prompt_templates SET name = ?, description = ?, system_prompt = ?, user_template = ?, updated_at = ? WHERE id = ?'
      ).run(next.name, next.description, next.systemPrompt, next.userTemplate, now, id)
      return this.getPromptTemplate(id)
    },
    deletePromptTemplate(id) {
      return connection.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id).changes > 0
    },
  }
}

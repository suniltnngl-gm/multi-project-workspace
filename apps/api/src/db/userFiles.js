// Objective: Own centrally tracked user files, their header sync, and their activity trail.
// Requirements: Sync only fields whose header value changed; skip unchanged content by hash; never erase a field whose header line is missing; preserve event history across syncs and manual edits; stamp every event with the tool run that produced it.
// Decisions: Header parsing and content hashing live here because only this domain reads file bodies; scans are scoped per repository; the whole scan pass runs as one scan tool run so its events point at the scanner rather than whatever request triggered it, with the run body kept factory-level so the public surface stays one thin entry.
// Relevant Files: apps/api/src/db/userFiles.js, apps/api/src/db/toolRuns.js, apps/api/src/workspaceScan.js, apps/api/src/database.js
// Important Context: User file. Composed into the createDatabase surface.
// Work State: Completed: Extracted from database.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { createHash } from 'node:crypto'

export function createUserFilesStore(connection, { toolRuns } = {}) {
  // Events stamp the innermost active run; callers without one (legacy
  // scripts, tests) keep run_id NULL.
  const currentRunId = () => toolRuns?.currentToolRunId() ?? null
  const USER_FILE_ACTIVITY_FIELDS = [
    'path', 'objective', 'requirements', 'decisions', 'relevant_files', 'important_context'
  ]

  // Header lines recognized in the leading comment block of tracked files.
  const USER_FILE_HEADER_FIELDS = [
    ['objective', 'Objective'],
    ['requirements', 'Requirements'],
    ['decisions', 'Decisions'],
    ['relevant_files', 'Relevant Files'],
    ['important_context', 'Important Context']
  ]

  /**
   * Parse the tracking header from a file's leading comment block.
   *
   * Recognized lines are "# Objective: ..." (Python, YAML, shell, Markdown)
   * or "// Objective: ..." (JavaScript). Only the leading comment block is
   * read, so the convention mentioned later in a file - inside a test
   * fixture, for example - is never mistaken for the file's own header.
   * The first value per field wins.
   */
  function parseUserFileHeaders(content) {
    const headers = {}
    for (const line of String(content ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith('#!')) continue
      const comment = /^(?:#|\/\/)\s?(.*)$/.exec(trimmed)
      if (!comment) break
      for (const [field, label] of USER_FILE_HEADER_FIELDS) {
        if (headers[field] !== undefined) continue
        const match = new RegExp(`^${label}:\\s*(.*)$`).exec(comment[1])
        if (match) headers[field] = match[1].trim()
      }
    }
    return headers
  }

  function hashUserFileContent(content) {
    return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
  }

  function toUserFileEvent(row) {
    if (!row) return null
    return {
      id: row.id,
      fileId: row.user_file_id,
      action: row.action,
      ...(row.field !== null ? { field: row.field } : {}),
      ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
      ...(row.new_value !== null ? { newValue: row.new_value } : {}),
      ...(row.run_id !== null ? { run: { id: row.run_id, kind: row.run_kind, label: row.run_label } } : {}),
      createdAt: row.created_at
    }
  }

  function readUserFileActivity(fileId, activityLimit = 50) {
    const requestedLimit = Number(activityLimit)
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(200, Math.trunc(requestedLimit))
      : 50
    return listUserFileEventsStatement.all(fileId, limit).map(toUserFileEvent)
  }

    const listUserFilesStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      ORDER BY user_files.repository_id, user_files.path COLLATE NOCASE
    `)
    const getUserFileStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      WHERE user_files.id = ?
    `)
    const getUserFileByPathStatement = connection.prepare(`
      SELECT user_files.*, repositories.name AS repository_name
      FROM user_files
      LEFT JOIN repositories ON repositories.id = user_files.repository_id
      WHERE user_files.repository_id = ? AND user_files.path = ?
    `)
    const insertUserFileStatement = connection.prepare(
      'INSERT INTO user_files (repository_id, path, objective, requirements, decisions, relevant_files, important_context, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const listUserFilesForRepositoryStatement = connection.prepare(
      'SELECT * FROM user_files WHERE repository_id = ?'
    )
    const updateUserFileStatement = connection.prepare(
      'UPDATE user_files SET path = ?, objective = ?, requirements = ?, decisions = ?, relevant_files = ?, important_context = ?, updated_at = ? WHERE id = ?'
    )
    const updateUserFileHashStatement = connection.prepare(
      'UPDATE user_files SET content_hash = ? WHERE id = ?'
    )
    const deleteUserFileStatement = connection.prepare('DELETE FROM user_files WHERE id = ?')
    const listUserFileEventsStatement = connection.prepare(`
      SELECT user_file_events.id, user_file_events.user_file_id, user_file_events.action,
             user_file_events.field, user_file_events.old_value, user_file_events.new_value,
             user_file_events.created_at, user_file_events.run_id,
             tool_runs.kind AS run_kind, tool_runs.label AS run_label
      FROM user_file_events
      LEFT JOIN tool_runs ON tool_runs.id = user_file_events.run_id
      WHERE user_file_events.user_file_id = ?
      ORDER BY user_file_events.created_at DESC, user_file_events.id DESC
      LIMIT ?
    `)
    const insertUserFileEventStatement = connection.prepare(`
      INSERT INTO user_file_events (user_file_id, action, field, old_value, new_value, created_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    function toUserFile(row) {
      if (!row) return null
      return {
        id: row.id,
        repositoryId: row.repository_id,
        ...(row.repository_name !== undefined ? { repository: row.repository_name } : {}),
        path: row.path,
        objective: row.objective,
        requirements: row.requirements,
        decisions: row.decisions,
        relevant_files: row.relevant_files,
        important_context: row.important_context,
        contentHash: row.content_hash ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    }
  /**
   * Sync tracked files with their header comments for one repository. The
   * scanUserFiles method wraps this in a scan tool run; the body is
   * factory-level so the public surface stays one thin entry.
   */
  function scanUserFilesWithinRun(files, repositoryId) {
    const now = new Date().toISOString()
    const existing = new Map(
      listUserFilesForRepositoryStatement.all(repositoryId).map((row) => [row.path, row])
    )
    let inserted = 0
    let synced = 0
    let refreshed = 0
    let skipped = 0
    for (const { path, content } of files) {
      const hash = hashUserFileContent(content)
      const current = existing.get(path)
      if (!current) {
        const headers = parseUserFileHeaders(content)
        const result = insertUserFileStatement.run(
          repositoryId,
          path,
          headers.objective ?? '',
          headers.requirements ?? '',
          headers.decisions ?? '',
          headers.relevant_files ?? '',
          headers.important_context ?? '',
          hash,
          now,
          now
        )
        const id = Number(result.lastInsertRowid)
        insertUserFileEventStatement.run(id, 'created', null, null, null, now, currentRunId())
        for (const [field] of USER_FILE_HEADER_FIELDS) {
          const value = headers[field] ?? ''
          if (value) insertUserFileEventStatement.run(id, 'synced', field, '', value, now, currentRunId())
        }
        inserted += 1
        continue
      }

      if (current.content_hash === hash) {
        skipped += 1
        continue
      }

      const headers = parseUserFileHeaders(content)
      const next = {}
      const changedFields = []
      for (const [field] of USER_FILE_HEADER_FIELDS) {
        next[field] = headers[field] !== undefined ? headers[field] : current[field]
        if (next[field] !== current[field]) changedFields.push(field)
      }
      updateUserFileHashStatement.run(hash, current.id)
      if (changedFields.length === 0) {
        refreshed += 1
        continue
      }
      updateUserFileStatement.run(
        current.path, next.objective, next.requirements, next.decisions,
        next.relevant_files, next.important_context, now, current.id
      )
      for (const field of changedFields) {
        insertUserFileEventStatement.run(
          current.id, 'synced', field, current[field], next[field], now, currentRunId()
        )
      }
      synced += 1
    }
    return { inserted, synced, refreshed, skipped, total: files.length }
  }

  return {
    listUserFiles({ search = '', repositoryId } = {}) {
      const conditions = []
      const values = []
      if (repositoryId !== undefined) {
        conditions.push('user_files.repository_id = ?')
        values.push(repositoryId)
      }
      if (search) {
        const like = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`
        conditions.push(
          '(user_files.path LIKE ? ESCAPE \'\\\' OR user_files.objective LIKE ? ESCAPE \'\\\' OR user_files.requirements LIKE ? ESCAPE \'\\\' OR user_files.decisions LIKE ? ESCAPE \'\\\' OR user_files.relevant_files LIKE ? ESCAPE \'\\\' OR user_files.important_context LIKE ? ESCAPE \'\\\')'
        )
        values.push(...Array(6).fill(like))
      }
      if (conditions.length === 0) return listUserFilesStatement.all().map(toUserFile)
      const rows = connection.prepare(`
        SELECT user_files.*, repositories.name AS repository_name
        FROM user_files
        LEFT JOIN repositories ON repositories.id = user_files.repository_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY user_files.repository_id, user_files.path COLLATE NOCASE
      `).all(...values)
      return rows.map(toUserFile)
    },
    getUserFile(id) {
      return toUserFile(getUserFileStatement.get(id))
    },
    getUserFileByPath(path, repositoryId = 1) {
      return toUserFile(getUserFileByPathStatement.get(repositoryId, path))
    },
    createUserFile({
      path,
      objective = '',
      requirements = '',
      decisions = '',
      relevant_files = '',
      important_context = '',
      repositoryId = 1
    }) {
      const now = new Date().toISOString()
      const result = insertUserFileStatement.run(
        repositoryId, path, objective, requirements, decisions, relevant_files, important_context,
        null, now, now
      )
      const id = Number(result.lastInsertRowid)
      insertUserFileEventStatement.run(id, 'created', null, null, null, now, currentRunId())
      return toUserFile(getUserFileStatement.get(id))
    },
    updateUserFile(id, changes) {
      const current = toUserFile(getUserFileStatement.get(id))
      if (!current) return null
      const next = {
        path: changes.path ?? current.path,
        objective: changes.objective ?? current.objective,
        requirements: changes.requirements ?? current.requirements,
        decisions: changes.decisions ?? current.decisions,
        relevant_files: changes.relevant_files ?? current.relevant_files,
        important_context: changes.important_context ?? current.important_context
      }
      const changedFields = USER_FILE_ACTIVITY_FIELDS.filter(
        (field) => current[field] !== next[field]
      )
      if (changedFields.length === 0) return current
      const now = new Date().toISOString()
      updateUserFileStatement.run(
        next.path, next.objective, next.requirements, next.decisions, next.relevant_files,
        next.important_context, now, id
      )
      for (const field of changedFields) {
        insertUserFileEventStatement.run(id, 'updated', field, current[field], next[field], now, currentRunId())
      }
      return toUserFile(getUserFileStatement.get(id))
    },
    deleteUserFile(id) {
      return deleteUserFileStatement.run(id).changes > 0
    },
    getUserFileDetail(id, { activityLimit = 50 } = {}) {
      const file = toUserFile(getUserFileStatement.get(id))
      if (!file) return null
      return { ...file, activity: readUserFileActivity(id, activityLimit) }
    },
    /**
     * Sync tracked files with their header comments.
     *
     * Each entry carries { path, content }. A content hash scopes the work:
     * files whose content are unchanged are skipped entirely, and a changed
     * file only writes the fields whose header value differs. A missing
     * header line stops syncing that field instead of erasing the last
     * value. Header syncs record "synced" events; manual updates record
     * "updated" events, so history is preserved either way.
     *
     * The whole pass runs as one scan tool run, so every event it writes
     * points at the scanner rather than whatever request triggered it.
     */
    scanUserFiles(files, { repositoryId = 1 } = {}) {
      const runScan = () => scanUserFilesWithinRun(files, repositoryId)
      return toolRuns ? toolRuns.withToolRun({ kind: 'scan', label: 'user-files' }, runScan) : runScan()
    },
  }
}

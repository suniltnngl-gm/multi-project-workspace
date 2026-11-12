// Objective: Persist the deterministic script registry and the content-addressed artifact cache.
// Requirements: Keep registration idempotent by name, bump versions on change, clear verification when a script changes, dedupe artifacts by SHA-256, and prune expired rows with their files.
// Decisions: Commands are stored, never executed here; artifact bytes live beside the database under a hash-named file while SQLite holds only metadata; resolving is delegated to the pure resolver so the store has no matching rules of its own.
// Relevant Files: apps/api/src/db/agentScripts.js, apps/api/src/agentScripts.js, apps/api/src/db/migrations.js, apps/api/src/database.js, apps/api/src/routes/agents.js
// Important Context: User file. The registry is part of the zero-token control plane.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '../agentProtocol.js'
import { resolveScript } from '../agentScripts.js'

const defaultArtifactDir = fileURLToPath(new URL('../../data/agent-artifacts', import.meta.url))

function toScript(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    intent: row.intent,
    inputSchema: parseJson(row.input_schema, {}),
    outputSchema: parseJson(row.output_schema, {}),
    command: row.command,
    version: row.version,
    timeoutMs: row.timeout_ms,
    costClass: row.cost_class,
    ...(row.verified_at !== null ? { verifiedAt: row.verified_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toArtifact(row, { content } = {}) {
  if (!row) return null
  return {
    contentHash: row.content_hash,
    kind: row.kind,
    path: row.path,
    producer: row.producer,
    bytes: row.bytes,
    createdAt: row.created_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(content !== undefined ? { content } : {})
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function sameScript(row, fields) {
  return row.intent === fields.intent
    && row.command === fields.command
    && canonicalJson(parseJson(row.input_schema, {})) === canonicalJson(fields.inputSchema)
    && canonicalJson(parseJson(row.output_schema, {})) === canonicalJson(fields.outputSchema)
    && row.timeout_ms === fields.timeoutMs
    && row.cost_class === fields.costClass
}

export function createAgentScriptsStore(connection, {
  now = Date.now,
  idFactory = () => `scr_${randomUUID()}`,
  artifactDir = process.env.AGENT_ARTIFACT_DIR || defaultArtifactDir
} = {}) {
  if (!connection) throw new Error('createAgentScriptsStore requires a connection.')
  const resolvedArtifactDir = resolve(artifactDir)

  const getScriptStatement = connection.prepare('SELECT * FROM agent_scripts WHERE id = ?')
  const getScriptByNameStatement = connection.prepare('SELECT * FROM agent_scripts WHERE name = ?')
  const insertScriptStatement = connection.prepare(`
    INSERT INTO agent_scripts (
      id, name, intent, input_schema, output_schema, command, version,
      timeout_ms, cost_class, created_at, updated_at
    ) VALUES (
      @id, @name, @intent, @inputSchema, @outputSchema, @command, 1,
      @timeoutMs, @costClass, @createdAt, @updatedAt
    )
  `)
  const updateScriptStatement = connection.prepare(`
    UPDATE agent_scripts
    SET intent = @intent, input_schema = @inputSchema, output_schema = @outputSchema,
        command = @command, version = @version, timeout_ms = @timeoutMs,
        cost_class = @costClass, verified_at = NULL, updated_at = @updatedAt
    WHERE id = @id
  `)
  const verifyScriptStatement = connection.prepare(
    'UPDATE agent_scripts SET verified_at = ?, updated_at = ? WHERE id = ?'
  )

  const getArtifactStatement = connection.prepare(
    'SELECT * FROM agent_artifacts WHERE content_hash = ?'
  )
  const insertArtifactStatement = connection.prepare(`
    INSERT INTO agent_artifacts (content_hash, kind, path, producer, bytes, created_at, expires_at)
    VALUES (@contentHash, @kind, @path, @producer, @bytes, @createdAt, @expiresAt)
  `)
  const deleteArtifactStatement = connection.prepare(
    'DELETE FROM agent_artifacts WHERE content_hash = ?'
  )

  const register = connection.transaction((fields) => {
    const existing = getScriptByNameStatement.get(fields.name)
    const at = now()
    if (existing) {
      if (sameScript(existing, fields)) return toScript(existing)
      updateScriptStatement.run({
        id: existing.id,
        intent: fields.intent,
        inputSchema: JSON.stringify(fields.inputSchema),
        outputSchema: JSON.stringify(fields.outputSchema),
        command: fields.command,
        version: existing.version + 1,
        timeoutMs: fields.timeoutMs,
        costClass: fields.costClass,
        updatedAt: at
      })
      return toScript(getScriptStatement.get(existing.id))
    }
    const id = idFactory()
    insertScriptStatement.run({
      id,
      name: fields.name,
      intent: fields.intent,
      inputSchema: JSON.stringify(fields.inputSchema),
      outputSchema: JSON.stringify(fields.outputSchema),
      command: fields.command,
      timeoutMs: fields.timeoutMs,
      costClass: fields.costClass,
      createdAt: at,
      updatedAt: at
    })
    return toScript(getScriptStatement.get(id))
  })

  function artifactPath(contentHash) {
    return join(resolvedArtifactDir, contentHash)
  }

  return {
    registerAgentScript(fields) {
      return register(fields)
    },
    getAgentScript(id) {
      return toScript(getScriptStatement.get(id))
    },
    getAgentScriptByName(name) {
      return toScript(getScriptByNameStatement.get(name))
    },
    listAgentScripts({ intent, limit = 50, verifiedOnly = false } = {}) {
      const conditions = []
      const values = []
      if (typeof intent === 'string' && intent.trim()) {
        conditions.push('intent LIKE ?')
        values.push(`%${intent.trim().replace(/[\\%_]/g, '\\$&')}%`)
      }
      if (verifiedOnly) conditions.push('verified_at IS NOT NULL')
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      return connection.prepare(
        `SELECT * FROM agent_scripts ${where} ORDER BY version DESC, updated_at DESC, id DESC LIMIT ?`
      ).all(...values, limit).map(toScript)
    },
    resolveAgentScript({ intent, input } = {}) {
      const scripts = connection.prepare(
        'SELECT * FROM agent_scripts ORDER BY version DESC, updated_at DESC, id DESC LIMIT 500'
      ).all().map(toScript)
      return resolveScript(scripts, { intent, input })
    },
    markAgentScriptVerified(id, verifiedAt = now()) {
      verifyScriptStatement.run(verifiedAt, now(), id)
      return toScript(getScriptStatement.get(id))
    },
    saveAgentArtifact({ kind, path = '', producer = '', content, expiresAt = null }) {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
      const contentHash = createHash('sha256').update(buffer).digest('hex')
      const at = now()
      const file = artifactPath(contentHash)
      const existing = getArtifactStatement.get(contentHash)
      if (existing && (existing.expires_at === null || existing.expires_at > at) && existsSync(file)) {
        return toArtifact(existing)
      }
      if (existing) deleteArtifactStatement.run(contentHash)

      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, buffer)
      insertArtifactStatement.run({
        contentHash,
        kind,
        path,
        producer,
        bytes: buffer.length,
        createdAt: at,
        expiresAt
      })
      return toArtifact(getArtifactStatement.get(contentHash))
    },
    getAgentArtifact(contentHash, { includeContent = false } = {}) {
      const row = getArtifactStatement.get(contentHash)
      if (!row) return null
      if (!includeContent) return toArtifact(row)
      const file = artifactPath(contentHash)
      const content = existsSync(file) ? readFileSync(file, 'utf8') : null
      return toArtifact(row, { content })
    },
    pruneAgentArtifacts(at = now()) {
      const expired = connection.prepare(
        'SELECT content_hash FROM agent_artifacts WHERE expires_at IS NOT NULL AND expires_at <= ?'
      ).all(at)
      for (const row of expired) {
        deleteArtifactStatement.run(row.content_hash)
        const file = artifactPath(row.content_hash)
        if (existsSync(file)) unlinkSync(file)
      }
      return expired.length
    }
  }
}

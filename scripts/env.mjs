import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecipheriv, createHash } from 'node:crypto'

const require = createRequire(import.meta.url)

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_FILE = resolve(ROOT_DIR, '.env')
export const DEFAULT_DATABASE_PATH = resolve(ROOT_DIR, 'apps/api/data/workspace.sqlite')

// dotenv is loaded lazily so `./workspace install` still works on a fresh
// clone before node_modules exists. The fallback covers the simple KEY=value
// shape that bootstrap needs.
let dotenvParser
function parseEnvContents(contents) {
  if (dotenvParser === undefined) {
    try {
      dotenvParser = require('dotenv').parse
    } catch {
      dotenvParser = parseEnvFallback
    }
  }
  return dotenvParser(contents)
}

function parseEnvFallback(contents) {
  const parsed = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    parsed[match[1]] = value
  }
  return parsed
}

/**
 * Resolve DATABASE_PATH consistently across hosts. Relative values are
 * anchored to the workspace root so a command never depends on the caller's
 * current directory; absolute values are used as-is.
 */
export function resolveDatabasePath({
  env = process.env,
  rootDir = ROOT_DIR,
  fallback = DEFAULT_DATABASE_PATH
} = {}) {
  const configured = env.DATABASE_PATH
  if (!configured) return fallback
  return isAbsolute(configured) ? resolve(configured) : resolve(rootDir, configured)
}

/**
 * Machine-local scratch space for scheduling state, study output, and other
 * transient files. Honors WORKSPACE_TMP_DIR and otherwise uses the OS temp
 * directory, so the same checkout works on Linux, macOS, and Windows.
 */
export function workspaceTmpDir({ env = process.env } = {}) {
  const configured = env.WORKSPACE_TMP_DIR
  return configured ? resolve(configured) : join(tmpdir(), 'opencode')
}

function decryptEnv(contents, key) {
  const parts = contents.trim().split(':')
  if (parts.length !== 3) {
    throw new Error('Encrypted env file must use iv:tag:ciphertext format.')
  }
  const derivedKey = createHash('sha256').update(key).digest()
  const iv = Buffer.from(parts[0], 'base64')
  const tag = Buffer.from(parts[1], 'base64')
  const encrypted = Buffer.from(parts[2], 'base64')
  const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function loadWorkspaceEnv({
  env = process.env,
  envFile = DEFAULT_ENV_FILE
} = {}) {
  let contents
  let path = envFile
  try {
    contents = readFileSync(envFile, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const encryptedPath = `${envFile}.enc`
    try {
      const encrypted = readFileSync(encryptedPath, 'utf8')
      const key = env.WORKSPACE_ENV_KEY
      if (!key) {
        throw new Error('WORKSPACE_ENV_KEY is required to decrypt the encrypted env file.')
      }
      contents = decryptEnv(encrypted, key)
      path = encryptedPath
    } catch (encryptedError) {
      if (encryptedError.code === 'ENOENT') return {}
      throw encryptedError
    }
  }

  const parsed = parseEnvContents(contents)
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value
  }
  return parsed
}

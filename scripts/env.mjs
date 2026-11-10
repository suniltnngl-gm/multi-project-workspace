import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecipheriv, createHash } from 'node:crypto'
import dotenv from 'dotenv'

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_FILE = resolve(ROOT_DIR, '.env')

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

  const parsed = dotenv.parse(contents)
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value
  }
  return parsed
}

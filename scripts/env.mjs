import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_FILE = resolve(ROOT_DIR, '.env')

export function loadWorkspaceEnv({
  env = process.env,
  envFile = DEFAULT_ENV_FILE
} = {}) {
  let contents
  try {
    contents = readFileSync(envFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }

  const parsed = dotenv.parse(contents)
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value
  }
  return parsed
}

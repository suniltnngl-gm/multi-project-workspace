import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadWorkspaceEnv } from '../../../scripts/env.mjs'

let temporaryDirectory

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

test('workspace dotenv loader parses standard values and preserves shell overrides', async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'workspace-env-'))
  const envFile = join(temporaryDirectory, '.env')
  await writeFile(envFile, [
    'PORT=3200',
    'LOCAL_AI_CONTEXT=1024',
    '# comment',
    ''
  ].join('\n'))
  const env = { PORT: '4100' }

  const parsed = loadWorkspaceEnv({ env, envFile })

  assert.equal(parsed.PORT, '3200')
  assert.equal(env.PORT, '4100')
  assert.equal(env.LOCAL_AI_CONTEXT, '1024')
})

test('workspace launcher passes shell environment to child processes', () => {
  const launcher = fileURLToPath(new URL('../../../scripts/with-env.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [
    launcher,
    process.execPath,
    '-e',
    'process.stdout.write(process.env.WORKSPACE_TEST_VALUE)'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WORKSPACE_TEST_VALUE: 'inherited'
    }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'inherited')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPortableBundle,
  writePortableBundle,
  redactSecrets,
  isSecretPath
} from '../../../scripts/swarm-portable-pack.mjs'

const fakeSk = 'sk-' + ['abcdef', '1234567890', 'abcd'].join('')
const fakeGn = 'gn_' + 'reallysecret123'
const fakeEnvKey = 'sk-' + 'topleftsecret99'

function seedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'w4-portable-'))
  const repo = join(root, 'repo')
  const state = join(root, 'state')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'docs', 'ideas'), { recursive: true })
  mkdirSync(join(state, 'lessons'), { recursive: true })
  mkdirSync(join(state, 'queue', 'active'), { recursive: true })
  mkdirSync(join(state, 'queue', 'cases'), { recursive: true })

  writeFileSync(join(repo, 'scripts', 'swarm-relay.mjs'), 'export const RELAY = 1\n')
  writeFileSync(join(repo, 'scripts', 'swarm-secret-holder.mjs'), `const KEY = "${fakeSk}"\n`)
  writeFileSync(join(repo, 'scripts', 'not-swarm.mjs'), 'export const OTHER = 1\n')
  writeFileSync(join(repo, 'docs', 'ideas', 'idea.md'), '# idea\n')
  writeFileSync(join(state, 'lessons', 'lesson-register.json'), '{"lessons":[]}\n')
  writeFileSync(join(state, 'queue', 'active', 't1.json'), '{"id":"t1"}\n')
  writeFileSync(join(state, 'queue', 'cases', 'c1.json'), '{"id":"c1"}\n')
  writeFileSync(join(state, 'lessons', '.env'), `OPENAI_API_KEY=${fakeEnvKey}\n`)
  writeFileSync(join(repo, 'scripts', 'graphn.env'), `GRAPHN_API_KEY=${fakeGn}\n`)
  return { root, repo, state }
}

test('redactSecrets and isSecretPath', () => {
  assert.equal(redactSecrets(`key ${fakeSk} end`), 'key [REDACTED] end')
  assert.equal(redactSecrets('OPENAI_API_KEY=supersecretvalue'), 'OPENAI_API_KEY=[REDACTED]')
  assert.equal(redactSecrets('plain text'), 'plain text')
  assert.equal(isSecretPath('state/lessons/.env'), true)
  assert.equal(isSecretPath('workflows/swarm-relay.mjs'), false)
})

test('buildPortableBundle collects workflows/state/docs and excludes secret paths', () => {
  const { repo, state } = seedFixture()
  try {
    const bundle = buildPortableBundle({ repoDir: repo, stateDir: state })
    assert.equal(bundle.ok, true)
    const keys = [...bundle.files.keys()]
    assert.ok(keys.includes('workflows/swarm-relay.mjs'))
    assert.ok(keys.includes('state/lessons/lesson-register.json'))
    assert.ok(keys.includes('state/queue/active/t1.json'))
    assert.ok(keys.includes('state/queue/cases/c1.json'))
    assert.ok(keys.includes('docs/ideas/idea.md'))
    assert.ok(![...bundle.files.keys()].some((k) => k.endsWith('.env')), 'no .env paths in bundle')
    assert.equal(bundle.manifest.excludedSecrets, 1)
    assert.ok(bundle.manifest.redactedFiles >= 1, 'secret content redacted')
    assert.ok(!bundle.files.get('workflows/swarm-secret-holder.mjs').includes(fakeSk), 'secret key redacted in copied script')
    assert.equal(bundle.manifest.schema, 'portable-workspace/v1')
  } finally {
    rmSync(join(repo, '..'), { recursive: true, force: true })
  }
})

test('writePortableBundle writes files + manifest and round-trips on disk', () => {
  const { repo, state } = seedFixture()
  const out = mkdtempSync(join(tmpdir(), 'w4-out-'))
  try {
    const bundle = buildPortableBundle({ repoDir: repo, stateDir: state })
    const res = writePortableBundle(bundle, out)
    assert.equal(res.ok, true)
    assert.ok(existsSync(join(out, 'manifest.json')))
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.fileCount, bundle.manifest.fileCount)
    assert.equal(readFileSync(join(out, 'workflows', 'swarm-relay.mjs'), 'utf8'), 'export const RELAY = 1\n')
    assert.ok(existsSync(join(out, 'state', 'queue', 'cases', 'c1.json')))
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(join(repo, '..'), { recursive: true, force: true })
  }
})

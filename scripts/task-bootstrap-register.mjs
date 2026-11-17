#!/usr/bin/env node
import { createDatabase } from '../apps/api/src/database.js'

function parse(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_argument:'+key)
    values[key.slice(2)] = argv[++i]
  }
  const allowed = new Set(['title', 'description', 'authorization-ref', 'idempotency-key', 'expected-generation', 'database'])
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error('unsupported_argument:'+key)
  for (const key of ['title', 'authorization-ref', 'idempotency-key', 'expected-generation']) if (!values[key]) throw new Error('missing_argument:'+key)
  const expectedGeneration = Number(values['expected-generation'])
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('invalid_expected_generation')
  if (expectedGeneration !== 9) throw new Error('phaseA_bootstrap_expected_generation_must_be_9')
  return { values, expectedGeneration }
}

try {
  const { values, expectedGeneration } = parse(process.argv.slice(2))
  const db = createDatabase(values.database)
  try {
    const result = db.registerTaskBootstrap({
      task: { title: values.title, description: values.description ?? '', project: 'curl-ai-bridge' },
      authorizationRef: values['authorization-ref'],
      idempotencyKey: values['idempotency-key'],
      expectedGeneration
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally { db.close() }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

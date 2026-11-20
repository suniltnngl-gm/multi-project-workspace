import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('sp004-contract-freeze', () => {
  const schemaPath = (name) => path.resolve(__dirname, '../../src/toolchain/schemas', name)

  test('pins dispatch-execution.v1.schema.json', () => {
    const content = readFileSync(schemaPath('dispatch-execution.v1.schema.json'), 'utf8')
    assert.doesNotThrow(() => JSON.parse(content))
  })

  test('pins lease-record.v1.schema.json', () => {
    const content = readFileSync(schemaPath('lease-record.v1.schema.json'), 'utf8')
    assert.doesNotThrow(() => JSON.parse(content))
  })
})

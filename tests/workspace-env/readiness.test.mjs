import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateReadiness,
  getPythonVenvState,
  isPythonVersionCompatible,
} from '../../scripts/workspace-env.mjs'

const agyAvailable = { source: 'agy-cli', plugins: [] }
const pythonReady = {
  exists: true,
  version: 'Python 3.14.10',
  compatible: true,
  matchesPreferredPin: true,
  preferredPin: '3.14',
}

assert.equal(isPythonVersionCompatible('Python 3.11.9'), false)
assert.equal(isPythonVersionCompatible('Python 3.12.0'), true)
assert.equal(isPythonVersionCompatible('Python 3.14.10'), true)
assert.equal(isPythonVersionCompatible('Python 4.0.0'), true)
assert.equal(isPythonVersionCompatible('not-python'), false)

const coreWithoutOptionalTooling = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [],
  python: { exists: false, compatible: false },
  agy: agyAvailable,
})
assert.equal(coreWithoutOptionalTooling.executionReady, true)
assert.equal(coreWithoutOptionalTooling.toolingReady, false)
assert.equal(coreWithoutOptionalTooling.ok, false)
assert.equal(coreWithoutOptionalTooling.diagnostics[0].code, 'PYTHON_TOOLING_VENV_MISSING')
assert.equal(coreWithoutOptionalTooling.diagnostics[0].lane, 'tooling')

const pythonOperationWithoutVenv = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [],
  python: { exists: false, compatible: false },
  agy: agyAvailable,
  operation: 'python',
})
assert.equal(pythonOperationWithoutVenv.executionReady, false)
assert.equal(pythonOperationWithoutVenv.toolingReady, false)
assert.equal(pythonOperationWithoutVenv.diagnostics[0].lane, 'execution')

const incompatiblePythonOperation = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [],
  python: { exists: true, compatible: false },
  agy: agyAvailable,
  operation: 'python',
})
assert.equal(incompatiblePythonOperation.executionReady, false)
assert.equal(incompatiblePythonOperation.toolingReady, false)
assert.equal(incompatiblePythonOperation.diagnostics[0].code, 'PYTHON_TOOLING_VERSION_UNSUPPORTED')

const missingRequiredEnv = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [{ key: 'REQUIRED_TEST_KEY', present: false }],
  python: pythonReady,
  agy: agyAvailable,
})
assert.equal(missingRequiredEnv.executionReady, false)
assert.equal(missingRequiredEnv.toolingReady, true)
assert.equal(missingRequiredEnv.diagnostics[0].code, 'REQUIRED_ENV_MISSING')

const unavailablePlugins = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [],
  python: pythonReady,
  agy: { source: 'unavailable', plugins: [] },
})
assert.equal(unavailablePlugins.executionReady, true)
assert.equal(unavailablePlugins.toolingReady, false)
assert.equal(unavailablePlugins.diagnostics[0].code, 'AGY_PLUGIN_TOOLING_UNAVAILABLE')

const unsupportedNode = evaluateReadiness({
  nodeVersion: '20.0.0',
  requiredEnv: [],
  python: pythonReady,
  agy: agyAvailable,
})
assert.equal(unsupportedNode.executionReady, false)
assert.equal(unsupportedNode.toolingReady, true)
assert.equal(unsupportedNode.diagnostics[0].code, 'NODE_VERSION_UNSUPPORTED')

for (const readiness of [coreWithoutOptionalTooling, pythonOperationWithoutVenv, missingRequiredEnv, unavailablePlugins, unsupportedNode]) {
  assert.equal(readiness.ok, readiness.executionReady && readiness.toolingReady)
}
const fullyReady = evaluateReadiness({
  nodeVersion: '22.23.4',
  requiredEnv: [],
  python: pythonReady,
  agy: agyAvailable,
})
assert.equal(fullyReady.executionReady, true)
assert.equal(fullyReady.toolingReady, true)
assert.equal(fullyReady.ok, true)
assert.deepEqual(fullyReady.issues, [])

const root = mkdtempSync(join(tmpdir(), 'p3a-python-venv-'))
try {
  // A missing root .venv is not mistaken for a missing Python satellite venv.
  assert.equal(getPythonVenvState({}, { rootDir: root }).exists, false)
  const satelliteBin = join(root, 'apps', 'python', '.venv', 'bin')
  mkdirSync(satelliteBin, { recursive: true })
  writeFileSync(join(root, 'apps', 'python', '.python-version'), '3.14\n')
  writeFileSync(join(satelliteBin, 'python'), '# test fixture; never executed\n')
  const satellite = getPythonVenvState({}, {
    rootDir: root,
    probePython: () => ({ ok: true, stdout: 'Python 3.14.10' }),
  })
  assert.equal(satellite.exists, true)
  assert.equal(satellite.compatible, true)
  assert.equal(satellite.matchesPreferredPin, true)
  assert.equal(satellite.preferredPin, '3.14')

  const oldPython = getPythonVenvState({}, {
    rootDir: root,
    probePython: () => ({ ok: true, stdout: 'Python 3.11.9' }),
  })
  assert.equal(oldPython.exists, true)
  assert.equal(oldPython.compatible, false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('PASS: independent executionReady/toolingReady transitions')
console.log('PASS: legacy ok equals executionReady && toolingReady')
console.log('PASS: Python >=3.12 compatibility and 3.14 preferred pin diagnostics')
console.log('PASS: missing root venv does not mask the apps/python/.venv satellite')
console.log('PASS: missing/incompatible Python satellite diagnostics are operation-scoped')
console.log('PASS: missing required environment and optional plugin diagnostics are deterministic')

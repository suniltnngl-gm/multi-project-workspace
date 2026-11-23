import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRelayPlan } from '../../../scripts/swarm-relay.mjs'
import { computeEvidenceFingerprint, reconcileStaleDiscoveredTasks } from '../../../scripts/swarm-discover.mjs'

test('computeEvidenceFingerprint is deterministic and reconcileStaleDiscoveredTasks archives stale disc-* tasks', () => {
  const fp1 = computeEvidenceFingerprint({ source: 'git_diff', summary: 'dirty 2 files', headSha: 'abc1234' })
  const fp2 = computeEvidenceFingerprint({ source: 'git_diff', summary: 'dirty 2 files', headSha: 'abc1234' })
  assert.equal(fp1, fp2)
  assert.equal(fp1.length, 16)

  const root = mkdtempSync(join(tmpdir(), 'disc-reconcile-'))
  try {
    const qDir = join(root, 'active')
    const aDir = join(root, 'archive')
    execFileSync('mkdir', ['-p', qDir])
    writeFileSync(join(qDir, 'disc-dirty-tracked.json'), JSON.stringify({ taskId: 'disc-dirty-tracked', state: 'parked', priority: 'P1', jobs: [] }))
    const res = reconcileStaleDiscoveredTasks(qDir, [], { apply: true })
    assert.deepEqual(res.expired, ['disc-dirty-tracked'])
    assert.equal(existsSync(join(qDir, 'disc-dirty-tracked.json')), false)
    assert.equal(existsSync(join(aDir, 'disc-dirty-tracked.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildRelayPlan alternates hermes -> opencode -> hermes with noHardKill: true', () => {
  const plan = buildRelayPlan({
    mode: 'discover',
    siblings: ['hermes', 'opencode'],
    windows: 3,
    softWindowSec: 300,
    reportDir: '/tmp/relay-test'
  })
  assert.equal(plan.mode, 'discover')
  assert.equal(plan.noHardKill, true)
  assert.equal(plan.hardKill, false)
  assert.equal(plan.assignments.length, 3)
  assert.deepEqual(
    plan.assignments.map((a) => a.sibling),
    ['hermes', 'opencode', 'hermes']
  )
  assert.ok(plan.assignments[0].reportPath.endsWith('relay-discover-w1-hermes.json'))
  assert.ok(plan.assignments[1].reportPath.endsWith('relay-discover-w2-opencode.json'))
  assert.ok(plan.assignments[2].reportPath.endsWith('relay-discover-w3-hermes.json'))
})

test('swarm-relay.mjs --dry-run --json exits 0 with relay-plan/v1', () => {
  const scriptPath = resolve(new URL('../../../scripts/swarm-relay.mjs', import.meta.url).pathname)
  const out = execFileSync(process.execPath, [scriptPath, '--dry-run', '--json'], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  const plan = parsed.plan || parsed
  assert.equal(plan.version, 'relay-plan/v1')
  assert.equal(plan.noHardKill, true)
  assert.equal(plan.assignments.length, 3)
})

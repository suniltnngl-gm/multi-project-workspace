import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupOne, rotateBackups, backupRegistries } from '../../../scripts/swarm-backup.mjs'

test('#302: backupOne snapshots atomically; missing db reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-one-'))
  try {
    const db = join(dir, 'cases.sqlite')
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(db, 'fake-sqlite-bytes')
    const res = backupOne(db, join(dir, 'backups'), 'STAMP', 'cases')
    assert.equal(res.ok, true)
    assert.ok(existsSync(res.path))
    assert.ok(res.path.includes('cases-STAMP.sqlite'))
    assert.ok(!existsSync(`${res.path}.tmp`), 'atomic rename leaves no tmp file')
    const missing = backupOne(join(dir, 'nope.sqlite'), join(dir, 'backups'), 'STAMP', 'cases')
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'db_not_found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#302: rotateBackups keeps the newest N per label', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-rotate-'))
  try {
    for (const name of ['cases-a.sqlite', 'cases-b.sqlite', 'cases-c.sqlite', 'workspace-board-x.sqlite']) {
      writeFileSync(join(dir, name), 'x')
    }
    const removed = rotateBackups(dir, 'cases', { keep: 2 })
    assert.deepEqual(removed, ['cases-a.sqlite'])
    const left = readdirSync(dir).sort()
    assert.deepEqual(left, ['cases-b.sqlite', 'cases-c.sqlite', 'workspace-board-x.sqlite'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#302: backupRegistries snapshots cases + board and reports db_not_found gracefully', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-reg-'))
  try {
    mkdirSync(join(root, 'queue', 'cases'), { recursive: true })
    writeFileSync(join(root, 'queue', 'cases', 'cases.sqlite'), 'cases-bytes')
    const board = join(root, 'board.sqlite')
    writeFileSync(board, 'board-bytes')
    const res = backupRegistries({ stateDir: root, boardPath: board, stamp: 'S1' })
    assert.equal(res.ok, true)
    assert.equal(res.results.length, 2)
    assert.ok(res.results.every((r) => r.ok))
    assert.ok(existsSync(join(root, 'backups', 'sqlite', 'cases-S1.sqlite')))
    assert.ok(existsSync(join(root, 'backups', 'sqlite', 'workspace-board-S1.sqlite')))

    const partial = backupRegistries({ stateDir: root, boardPath: join(root, 'missing.sqlite'), stamp: 'S2' })
    assert.equal(partial.ok, true, 'missing board is reported, not fatal')
    assert.equal(partial.results.find((r) => r.label === 'workspace-board').reason, 'db_not_found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

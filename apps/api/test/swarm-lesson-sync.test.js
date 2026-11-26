import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLessonPaths, syncLessonRegister } from '../../../scripts/swarm-lesson-sync.mjs'

test('#228: lesson-register defaults resolve through the single state-root contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-state-'))
  try {
    const override = join(dir, 'primary')
    const legacy = join(dir, 'legacy')
    const paths = defaultLessonPaths({ SWARM_STATE_DIR: override, SWARM_STATE_ROOT: legacy })
    assert.equal(paths.lessonsPath, join(override, 'lessons', 'lesson-register.json'))
    assert.equal(paths.casesDir, join(override, 'queue', 'cases'))
    assert.equal(paths.queueDir, join(override, 'queue', 'active'))
    const legacyPaths = defaultLessonPaths({ SWARM_STATE_ROOT: legacy })
    assert.equal(legacyPaths.casesDir, join(legacy, 'queue', 'cases'))
    assert.equal(legacyPaths.queueDir, join(legacy, 'queue', 'active'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#228: syncLessonRegister still honours explicit paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-sync-'))
  try {
    const casesDir = join(dir, 'cases')
    const queueDir = join(dir, 'queue')
    mkdirSync(casesDir, { recursive: true })
    mkdirSync(queueDir, { recursive: true })
    const res = syncLessonRegister({
      lessonsPath: join(dir, 'lesson-register.json'),
      casesDir,
      queueDir,
      apply: false
    })
    assert.equal(res.ok, true)
    assert.equal(res.addedCount, 0)
    assert.equal(res.totalCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

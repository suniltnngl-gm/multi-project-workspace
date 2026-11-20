import * as nodeFs from 'node:fs'
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { parseIsoStrict } from './portability.js'

export const DEFAULT_GRACE_MS = 30 * 1000
export const DEFAULT_RUN_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_OBSERVATION_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_STORE_LEASE_TTL_MS = 15 * 60 * 1000
const RENEW_RENAME_BACKOFF_MS = [25, 50, 100]

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())
const defaultSleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Per-user state directory so the concurrency cap holds across all worktrees on a host.
 * Precedence: DISPATCH_STATE_DIR, $XDG_STATE_HOME/mpw-dispatch-state, (win32) %LOCALAPPDATA%\mpw-dispatch-state,
 * ~/.local/state/mpw-dispatch-state, then a per-user os.tmpdir() fallback. Never inside the repo.
 */
export function resolveDispatchStateDir({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
  tmpdir = os.tmpdir
} = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix
  if (env.DISPATCH_STATE_DIR) return path.resolve(env.DISPATCH_STATE_DIR)
  if (env.XDG_STATE_HOME && P.isAbsolute(env.XDG_STATE_HOME)) return P.join(env.XDG_STATE_HOME, 'mpw-dispatch-state')
  if (platform === 'win32' && env.LOCALAPPDATA) return P.join(env.LOCALAPPDATA, 'mpw-dispatch-state')
  let home = null
  try { home = homedir() } catch { home = null }
  if (home) return P.join(home, '.local', 'state', 'mpw-dispatch-state')
  const user = String(env.USER || env.USERNAME || 'user').replace(/[^A-Za-z0-9_.-]/g, '_')
  return P.join(tmpdir(), `mpw-dispatch-state-${user}`)
}

export function createLeaseStore({
  stateDir,
  now = () => Date.now(),
  fs = nodeFs,
  randomUUID = nodeRandomUUID,
  graceMs = DEFAULT_GRACE_MS,
  runRetentionMs = DEFAULT_RUN_RETENTION_MS,
  observationRetentionMs = DEFAULT_OBSERVATION_RETENTION_MS,
  hostname = os.hostname(),
  pid = process.pid,
  sleepSync = defaultSleepSync
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new TypeError('createLeaseStore: stateDir is required')
  const dirs = {
    lease: path.join(stateDir, 'leases'),
    run: path.join(stateDir, 'runs'),
    slot: path.join(stateDir, 'slots'),
    obs: path.join(stateDir, 'obs')
  }
  const hash = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 40)
  const fileFor = (kind, key) =>
    path.join(dirs[kind], kind === 'slot' ? `slot-${Number(key)}.json` : `${hash(key)}.${kind}.json`)
  const safeUnlink = (file) => { try { fs.unlinkSync(file) } catch { /* best effort */ } }
  const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  function readFile(file) {
    let raw
    let mtimeMs
    try {
      raw = fs.readFileSync(file, 'utf8')
      mtimeMs = fs.statSync(file).mtimeMs
    } catch (error) {
      if (error && error.code === 'ENOENT') return { missing: true }
      throw error
    }
    try {
      const record = JSON.parse(raw)
      if (record && typeof record === 'object' && typeof record.token === 'string' && parseIsoStrict(record.expiresAt) !== null) {
        return { record, mtimeMs }
      }
    } catch { /* fall through: unparseable */ }
    return { record: null, corrupt: true, mtimeMs }
  }

  // Expired record, or an unparseable file (crash between open and write) older than graceMs.
  const isStale = (read, nowMs) =>
    read.record ? parseIsoStrict(read.record.expiresAt) <= nowMs : nowMs > read.mtimeMs + graceMs

  function createExclusive(file, record) {
    ensureDir(path.dirname(file))
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(record))
      fs.fsyncSync(fd)
    } catch (error) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
      safeUnlink(file)
      throw error
    }
    fs.closeSync(fd)
  }

  function replaceViaTmp(file, record) {
    const tmp = `${file}.${randomUUID()}.tmp`
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(record))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // Windows can fail rename with EPERM/EBUSY while another process is reading the target.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        return true
      } catch (error) {
        const transient = error && (error.code === 'EPERM' || error.code === 'EBUSY')
        if (!transient || attempt >= RENEW_RENAME_BACKOFF_MS.length) {
          safeUnlink(tmp)
          return false
        }
        sleepSync(RENEW_RENAME_BACKOFF_MS[attempt])
      }
    }
  }

  /**
   * Atomic reap: claim by renaming the file away (only one reaper wins; others see ENOENT), then re-read.
   * If the claimed inode turns out to be live (a renewal slipped in before the claim), it is put back with
   * renameSync(claimed, final) -- unless a fresh file is already installed at final, in which case the newer
   * file wins and the claimed inode is unlinked. (No link(..., wx): Hermes REVISE fix 2.)
   */
  function reapFile(file) {
    const claimed = `${file}.reap.${randomUUID()}`
    try {
      fs.renameSync(file, claimed)
    } catch (error) {
      if (error && error.code === 'ENOENT') return 'lost_race'
      throw error
    }
    const read = readFile(claimed)
    if (!read.missing && !isStale(read, now())) {
      if (!readFile(file).missing) { safeUnlink(claimed); return 'renewal_won' }
      try {
        fs.renameSync(claimed, file)
        return 'restored'
      } catch {
        safeUnlink(claimed)
        return 'renewal_won'
      }
    }
    safeUnlink(claimed)
    return 'reaped'
  }

  function claimAndRemove(file) {
    const claimed = `${file}.reap.${randomUUID()}`
    try {
      fs.renameSync(file, claimed)
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
    safeUnlink(claimed)
    return true
  }

  const makeRecord = (kind, key, { holder, ttlMs, extra = {} }) => {
    const nowMs = now()
    return {
      v: 1,
      kind,
      key: String(key),
      holder: holder ?? null,
      token: randomUUID(),
      pid,
      hostname,
      acquiredAt: iso(nowMs),
      expiresAt: iso(nowMs + ttlMs),
      ...extra
    }
  }
  const handleOf = (kind, key, record, ttlMs) => ({
    kind, key: String(key), file: fileFor(kind, key), token: record.token, holder: record.holder, ttlMs, expiresAt: record.expiresAt
  })

  function acquireFile(kind, key, { holder = null, ttlMs = DEFAULT_STORE_LEASE_TTL_MS, reentry = false, extra } = {}) {
    const file = fileFor(kind, key)
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = makeRecord(kind, key, { holder, ttlMs, extra })
      try {
        createExclusive(file, record)
        return { ok: true, handle: handleOf(kind, key, record, ttlMs) }
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
      const cur = readFile(file)
      if (cur.missing) continue
      if (isStale(cur, now())) { reapFile(file); continue }
      if (reentry && cur.record && holder !== null && cur.record.holder === holder) {
        return { ok: true, reentry: true, handle: handleOf(kind, key, cur.record, ttlMs) }
      }
      return {
        ok: false,
        reason: 'lease_held',
        holder: cur.record?.holder ?? null,
        expiresAt: cur.record ? cur.record.expiresAt : iso(cur.mtimeMs + graceMs)
      }
    }
    return { ok: false, reason: 'lease_held', holder: null, expiresAt: null }
  }

  function renew(handle) {
    try {
      const nowMs = now()
      const cur = readFile(handle.file)
      if (cur.missing || !cur.record || cur.record.token !== handle.token) return { ok: false, reason: 'lease_lost' }
      if (parseIsoStrict(cur.record.expiresAt) <= nowMs) return { ok: false, reason: 'lease_lost' }
      const expiresAt = iso(nowMs + handle.ttlMs)
      const next = { ...cur.record, expiresAt }
      if (next.kind === 'run' && next.status === 'running') next.leaseExpiresAt = expiresAt
      if (!replaceViaTmp(handle.file, next)) return { ok: false, reason: 'renew_failed' }
      const confirm = readFile(handle.file)
      if (confirm.missing || !confirm.record || confirm.record.token !== handle.token) return { ok: false, reason: 'lease_lost' }
      handle.expiresAt = expiresAt
      return { ok: true, expiresAt }
    } catch (error) {
      return { ok: false, reason: 'renew_failed', error: error?.code || 'error' }
    }
  }

  // Idempotent and never throws, so it is safe in `finally`.
  function release(handle) {
    try {
      const cur = readFile(handle.file)
      if (cur.missing) return { ok: true, alreadyReleased: true }
      if (!cur.record || cur.record.token !== handle.token) return { ok: false, reason: 'not_owner' }
      fs.unlinkSync(handle.file)
      return { ok: true }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, alreadyReleased: true }
      return { ok: false, reason: 'release_failed', error: error?.code || 'error' }
    }
  }

  const acquireLease = ({ compositeKey, holder, ttlMs }) => acquireFile('lease', compositeKey, { holder, ttlMs, reentry: true })

  /**
   * Single-flight run record. On EEXIST the existing record decides (Hermes REVISE fix 1):
   * running+live -> await_in_flight; succeeded (no forceRetry) -> blocked already_completed;
   * failed (or succeeded+forceRetry, or running+expired, or retention elapsed) -> replace and proceed.
   */
  function acquireRun({ idempotencyKey, compositeKey = null, holder = idempotencyKey, ttlMs = DEFAULT_STORE_LEASE_TTL_MS, forceRetry = false }) {
    const file = fileFor('run', idempotencyKey)
    let staleRunReaped = false
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = makeRecord('run', idempotencyKey, { holder, ttlMs, extra: { status: 'running', compositeKey, leaseExpiresAt: null } })
      record.leaseExpiresAt = record.expiresAt
      try {
        createExclusive(file, record)
        return { ok: true, staleRunReaped, handle: handleOf('run', idempotencyKey, record, ttlMs) }
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
      const cur = readFile(file)
      if (cur.missing) continue
      const nowMs = now()
      const stale = isStale(cur, nowMs)
      if (!cur.record) {
        if (stale) { reapFile(file); continue }
        return { ok: false, outcome: 'await_in_flight', reason: `await_in_flight:${idempotencyKey}`, nextEligibleAt: iso(cur.mtimeMs + graceMs) }
      }
      const status = cur.record.status
      if (status === 'running') {
        if (!stale) return { ok: false, outcome: 'await_in_flight', reason: `await_in_flight:${idempotencyKey}`, nextEligibleAt: cur.record.expiresAt }
        if (reapFile(file) === 'reaped') staleRunReaped = true
        continue
      }
      if (status === 'succeeded' && !forceRetry && !stale) {
        return { ok: false, outcome: 'blocked', reason: `already_completed:${idempotencyKey}` }
      }
      claimAndRemove(file) // failed / forceRetry / retention elapsed -> replace
    }
    return { ok: false, outcome: 'await_in_flight', reason: `await_in_flight:${idempotencyKey}`, nextEligibleAt: null }
  }

  function finalizeRun(handle, status) {
    try {
      const nowMs = now()
      const cur = readFile(handle.file)
      if (cur.missing || !cur.record || cur.record.token !== handle.token) return { ok: false, reason: 'lease_lost' }
      const next = { ...cur.record, status, finishedAt: iso(nowMs), leaseExpiresAt: iso(nowMs), expiresAt: iso(nowMs + runRetentionMs) }
      return replaceViaTmp(handle.file, next) ? { ok: true } : { ok: false, reason: 'finalize_failed' }
    } catch (error) {
      return { ok: false, reason: 'finalize_failed', error: error?.code || 'error' }
    }
  }

  function listJson(dir, suffix = '.json') {
    try { return fs.readdirSync(dir).filter((n) => n.endsWith(suffix)) } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  function countActiveSlots() {
    const nowMs = now()
    const expiries = []
    for (const name of listJson(dirs.slot).filter((n) => /^slot-\d+\.json$/.test(n))) {
      const read = readFile(path.join(dirs.slot, name))
      if (read.missing || isStale(read, nowMs)) continue
      expiries.push(read.record ? parseIsoStrict(read.record.expiresAt) : read.mtimeMs + graceMs)
    }
    return { count: expiries.length, expiries }
  }

  function acquireSlot({ max, holder = null, ttlMs = DEFAULT_STORE_LEASE_TTL_MS }) {
    const expiries = []
    for (let i = 0; i < max; i++) {
      const res = acquireFile('slot', i, { holder, ttlMs, reentry: false })
      if (res.ok) return res
      if (res.expiresAt) expiries.push(parseIsoStrict(res.expiresAt))
    }
    const valid = expiries.filter((e) => e !== null)
    return { ok: false, reason: 'resource_gate_busy', nextEligibleAt: valid.length ? iso(Math.min(...valid)) : null }
  }

  function readObservations() {
    const nowMs = now()
    const out = []
    for (const name of listJson(dirs.obs).sort()) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dirs.obs, name), 'utf8'))
        const at = parseIsoStrict(o?.observedAt)
        if (at !== null && nowMs - at <= observationRetentionMs) out.push(o)
      } catch { /* skip unreadable */ }
    }
    return out
  }

  function recordObservation({ scope, target, kind, retryAfterMs }) {
    const nowMs = now()
    const prior = readObservations().filter((o) => o.scope === scope && String(o.target) === String(target))
    let run = 0
    for (let i = prior.length - 1; i >= 0 && prior[i].kind !== 'ok'; i--) run++
    const record = { scope, target: String(target), kind, observedAt: iso(nowMs), consecutive: run + 1 }
    if (typeof retryAfterMs === 'number') record.retryAfterMs = retryAfterMs
    const file = path.join(dirs.obs, `${String(nowMs).padStart(15, '0')}-${randomUUID()}.json`)
    createExclusive(file, record)
    return record
  }

  /** Read-only: exact input shape for the SP-003 planner (`leases`, `inFlight`, `providerObservations`). */
  function snapshot() {
    const nowMs = now()
    const leases = []
    for (const name of listJson(dirs.lease)) {
      const r = readFile(path.join(dirs.lease, name))
      if (r.record) leases.push({ compositeKey: r.record.key, holder: r.record.holder, acquiredAt: r.record.acquiredAt, expiresAt: r.record.expiresAt })
    }
    const inFlight = []
    for (const name of listJson(dirs.run)) {
      const r = readFile(path.join(dirs.run, name))
      if (!r.record) continue
      if (r.record.status !== 'running' && isStale(r, nowMs)) continue
      inFlight.push({
        idempotencyKey: r.record.key,
        compositeKey: r.record.compositeKey ?? null,
        startedAt: r.record.acquiredAt,
        leaseExpiresAt: r.record.leaseExpiresAt ?? r.record.expiresAt,
        status: r.record.status
      })
    }
    return { leases, inFlight, providerObservations: readObservations() }
  }

  /** Explicit, executor-only. Removes expired leases/runs/slots, old observations and abandoned tmp/reap files. */
  function reap() {
    const nowMs = now()
    const stats = { reaped: 0, restored: 0, lostRace: 0, renewalWon: 0, tmpRemoved: 0, observationsRemoved: 0 }
    for (const dir of [dirs.lease, dirs.run, dirs.slot]) {
      let names = []
      try { names = fs.readdirSync(dir) } catch (error) { if (!error || error.code !== 'ENOENT') throw error }
      for (const name of names) {
        const file = path.join(dir, name)
        if (name.endsWith('.json')) {
          const read = readFile(file)
          if (read.missing || !isStale(read, nowMs)) continue
          const res = reapFile(file)
          if (res === 'reaped') stats.reaped++
          else if (res === 'restored') stats.restored++
          else if (res === 'lost_race') stats.lostRace++
          else stats.renewalWon++
        } else if (/\.(tmp|reap\.[0-9a-f-]+)$/.test(name)) {
          try {
            if (nowMs - fs.statSync(file).mtimeMs > graceMs) { fs.unlinkSync(file); stats.tmpRemoved++ }
          } catch { /* raced */ }
        }
      }
    }
    for (const name of listJson(dirs.obs)) {
      const file = path.join(dirs.obs, name)
      try {
        const o = JSON.parse(fs.readFileSync(file, 'utf8'))
        const at = parseIsoStrict(o?.observedAt)
        if (at === null || nowMs - at > observationRetentionMs) { fs.unlinkSync(file); stats.observationsRemoved++ }
      } catch { /* leave unreadable files */ }
    }
    return stats
  }

  return {
    stateDir,
    dirs,
    fileFor,
    acquireLease,
    acquireRun,
    acquireSlot,
    countActiveSlots,
    renew,
    release,
    finalizeRun,
    recordObservation,
    readObservations,
    snapshot,
    reap
  }
}

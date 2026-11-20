const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Strict ISO-8601 parse: requires Z or an explicit offset so results never depend on local TZ. Returns epoch ms or null. */
export function parseIsoStrict(value) {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

/** Path-like repositories are separator-normalised (and case-folded on win32 only); logical names are untouched. */
export function normalizeRepository(value, platform = process.platform) {
  if (value === undefined || value === null) return null
  const s = String(value)
  if (!(/[\\/]/.test(s) || /^[A-Za-z]:/.test(s))) return s
  let out = s.replace(/\\/g, '/').replace(/\/+$/, '')
  if (out === '') out = '/'
  return platform === 'win32' ? out.toLowerCase() : out
}

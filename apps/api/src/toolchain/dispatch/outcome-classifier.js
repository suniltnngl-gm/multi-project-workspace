const RATE = /\b429\b|rate[\s_-]?limit|too many requests|quota exceeded|resource[_\s]exhausted/i
const S503 = /\b503\b|service unavailable|overloaded/i
const S504 = /\b504\b|gateway time-?out|upstream (request )?time-?out|upstream connect error/i

/**
 * Pure classification of a finished child. A LOCAL timeout (we sent SIGTERM/SIGKILL) is NOT evidence
 * that the provider is unhealthy, so it never produces a provider/model cooldown on its own. An observation
 * is emitted only when stderr/exit indicates an upstream failure (429/503/504/upstream timeout).
 */
export function classifyOutcome({ exitCode = null, signal = null, timedOut = false, stderrTail = '' } = {}) {
  const text = String(stderrTail || '')
  let upstream = null
  if (RATE.test(text)) upstream = { kind: 'rate_limited', reason: 'upstream_rate_limited' }
  else if (S503.test(text)) upstream = { kind: 'unavailable_503', reason: 'upstream_unavailable_503' }
  else if (S504.test(text)) upstream = { kind: 'unavailable', retryAfterMs: 120000, reason: 'upstream_timeout_504' }

  let outcome = 'succeeded'
  if (timedOut) outcome = 'timed_out'
  else if (exitCode !== 0 || signal) outcome = 'failed'
  return { outcome, upstream, localTimeout: timedOut && !upstream }
}

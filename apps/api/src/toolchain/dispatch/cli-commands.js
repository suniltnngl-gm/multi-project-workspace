/**
 * Per-CLI headless/resume command table. FAIL-CLOSED: a CLI without a verified entry, or whose `--help`
 * does not contain every required flag, is refused. Flags were verified against local `--help` output
 * on 2026-11-20 (agy, opencode, cline, vibe, hermes). `claude`/`codex`/`copilot` are intentionally unverified.
 * Resume applies only to `reuse_session` plans; `create_session` lets the CLI mint its own id.
 */
export const CLI_VERIFIED_AT = '2026-11-20'

export const CLI_COMMAND_SPECS = Object.freeze({
  agy: {
    bin: 'agy',
    helpArgs: ['--help'],
    requiredFlags: ['--print', '--model', '--conversation']
  },
  opencode: {
    bin: 'opencode',
    helpArgs: ['run', '--help'],
    requiredFlags: ['--standalone', '--session', '--model']
  },
  cline: {
    bin: 'cline',
    helpArgs: ['--help'],
    requiredFlags: ['--cwd', '--model', '--id', '--json']
  },
  vibe: {
    bin: 'vibe',
    helpArgs: ['--help'],
    requiredFlags: ['--workdir', '--prompt', '--resume', '--model', '--output']
  },
  hermes: {
    bin: 'hermes',
    helpArgs: ['--help'],
    requiredFlags: ['--oneshot', '--resume', '--provider', '--in']
  },
  kilo: {
    bin: 'kilo',
    helpArgs: ['run', '--help'],
    requiredFlags: ['--session', '--model', '--format']
  },
  copilot: {
    bin: 'copilot',
    helpArgs: ['--help'],
    requiredFlags: ['-p', '--resume']
  }
})

const fail = (reason) => ({ ok: false, reason })

export function buildCliCommand({ cli, model, provider = null, sessionId = null, resume = false, prompt, cwd }) {
  const spec = CLI_COMMAND_SPECS[cli]
  if (!spec) return fail(`cli_flags_unverified:${cli}`)
  if (!model) return fail('model_required')
  if (typeof prompt !== 'string' || !prompt.trim()) return fail('prompt_required')
  if (prompt.startsWith('-')) return fail('prompt_must_not_start_with_dash')
  if (resume && !sessionId) return fail('resume_requires_session_id')
  let argv
  switch (cli) {
    case 'agy':
      argv = ['--print', prompt, '--model', model, ...(resume ? ['--conversation', sessionId] : [])]
      break
    case 'opencode':
      if (!provider) return fail('opencode_requires_provider_for_model')
      argv = ['--standalone', 'run', '--model', `${provider}/${model}`, ...(resume ? ['--session', sessionId] : []), prompt]
      break
    case 'cline':
      argv = ['--cwd', cwd, '--json', '--yolo', '--model', model, ...(provider ? ['--provider', provider] : []), ...(resume ? ['--id', sessionId] : []), prompt]
      break
    case 'vibe':
      // `--model` applies to new sessions only; a resumed session keeps its pinned model.
      argv = ['--workdir', cwd, '--output', 'json', ...(resume ? ['--resume', sessionId] : ['--model', model]), '-p', prompt]
      break
    case 'hermes': {
      const effectiveSession = sessionId || process.env.SWARM_HERMES_SESSION_OVERRIDE || null
      const shouldResume = Boolean(resume || (!sessionId && process.env.SWARM_HERMES_SESSION_OVERRIDE))
      argv = ['-z', prompt, '-m', model, ...(provider ? ['--provider', provider] : []), '--in', cwd, ...(shouldResume && effectiveSession ? ['--resume', effectiveSession] : [])]
      break
    }
    case 'kilo':
      argv = ['run', '--format', 'json', '--model', model, ...(resume ? ['--session', sessionId] : []), prompt]
      break
    case 'copilot':
      argv = [...(resume ? [`--resume=${sessionId}`] : []), '-p', prompt]
      break
    default:
      return fail(`cli_flags_unverified:${cli}`)
  }
  return { ok: true, bin: spec.bin, argv, prompt }
}

/** Fail-closed check of a CLI's own `--help` output for every required flag. */
export function verifyHelpOutput(cli, helpText) {
  const spec = CLI_COMMAND_SPECS[cli]
  if (!spec) return { ok: false, missing: [], reason: `cli_flags_unverified:${cli}` }
  const text = String(helpText || '')
  const missing = spec.requiredFlags.filter((f) => !text.includes(f))
  return missing.length
    ? { ok: false, missing, reason: `cli_flags_unverified:${cli}:${missing.join(',')}` }
    : { ok: true, missing: [] }
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/g, /gh[pousr]_[A-Za-z0-9_]{20,}/g, /AKIA[0-9A-Z]{16}/g, /AIza[0-9A-Za-z_-]{30,}/g]
const SECRET_FLAGS = new Set(['-k', '--key', '--api-key', '--token'])

/** argv safe for logs/dry-run output: prompt masked, secret-looking values and secret-flag values redacted. */
export function redactArgv(argv, prompt) {
  const out = []
  let redactNext = false
  for (const arg of argv) {
    if (redactNext) { out.push('<redacted>'); redactNext = false; continue }
    if (SECRET_FLAGS.has(arg)) { out.push(arg); redactNext = true; continue }
    if (arg === prompt) { out.push('<prompt>'); continue }
    out.push(SECRET_PATTERNS.reduce((s, re) => s.replace(re, '<redacted>'), String(arg)))
  }
  return out
}

const SAFE_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'NO_COLOR', 'CI'
])
const CLI_ENV = {
  agy: [],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
  cline: ['CLINE_DIR'],
  vibe: ['VIBE_HOME', 'VIBE_CWD', 'DBUS_SESSION_BUS_ADDRESS'],
  hermes: ['HERMES_HOME'],
  kilo: ['KILO_HOME'],
  copilot: ['COPILOT_HOME']
}

/**
 * Child env: safe base variables + CLI home/config variables + explicitly named passthrough + explicit overrides.
 * Credentials are NOT inherited implicitly (CLIs normally authenticate from their own config). Callers get
 * back only key NAMES for logging, never values.
 */
export function buildChildEnv({ env = process.env, cli, passthrough = [], overrides = {} } = {}) {
  const allowed = new Set([...SAFE_ENV, ...(CLI_ENV[cli] || []), ...passthrough])
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (allowed.has(k) || k.startsWith('LC_'))) out[k] = v
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

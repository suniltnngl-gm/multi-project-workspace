#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolveDispatchTarget } from '../apps/api/src/toolchain/dispatch/session-pool-dispatcher.js'

const argv = process.argv.slice(2)
const opts = {}
const flags = new Set(['--json'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (flags.has(a)) opts[a.slice(2)] = true
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
}
const list = (v) => (v ? String(v).split(',').filter(Boolean) : [])

let sessions = []
if (opts.registry) {
  const parsed = JSON.parse(readFileSync(opts.registry, 'utf8'))
  sessions = Array.isArray(parsed) ? parsed : parsed.sessions || []
}

const plan = resolveDispatchTarget({
  sessions,
  request: {
    role: opts.role,
    repository: opts.repo,
    workItem: opts['work-item'],
    cli: opts.cli,
    model: opts.model,
    gateway: opts.gateway,
    provider: opts.provider
  },
  unavailableModels: list(opts['unavailable-model']),
  fallbackCandidates: list(opts['fallback-model']).map((model) => ({ model }))
})

if (opts.json) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
} else {
  const s = plan.selectedSession
  process.stdout.write([
    `Session Pool Plan (${plan.schemaVersion}, read-only)`,
    `action=${plan.action} fallbackUsed=${plan.fallbackUsed} routingKey=${plan.routingKey}`,
    s ? `session=${s.compositeKey ?? '(new)'} model=${s.model} cache=${s.cacheState}` : 'session=none',
    `reasons: ${plan.reasons.join(', ')}`
  ].join('\n') + '\n')
}
process.exit(plan.action === 'blocked' ? 2 : 0)

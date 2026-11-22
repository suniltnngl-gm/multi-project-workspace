#!/usr/bin/env node
/**
 * Swarm Notification CLI (`swarm notify`):
 * - Manual alert: `swarm notify --title "..." --body "..." [--severity info|warn|critical]`
 * - Remote watcher: `swarm notify --check-remote` (checks Kaggle GPU/TPU, Colab sessions,
 *   and GitHub Actions CI; fires Ubuntu desktop `notify-send` + JSONL log ONLY on state change)
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  emitNotification,
  diffRemoteStates,
  loadRemoteState,
  saveRemoteState
} from '../apps/api/src/toolchain/dispatch/notifier.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-notify.mjs [options]
      --title <text>              Notification title
      --body <text>               Notification body
      --severity <info|warn|critical>
      --source <swarm|kaggle|colab|github>
      --check-remote              Poll Kaggle, Colab, and GitHub CI; notify on state transitions
      --no-desktop                Skip Ubuntu notify-send
      --dry-run                   Preview only (no writes or popups)
      --json                      Output JSON
  -h, --help                      Show this help
`)
  process.exit(0)
}

const opts = {
  title: null,
  body: '',
  severity: 'info',
  source: 'swarm',
  checkRemote: false,
  desktop: true,
  dryRun: false,
  json: false
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--check-remote') opts.checkRemote = true
  else if (a === '--no-desktop') opts.desktop = false
  else if (a === '--dry-run') opts.dryRun = true
  else if (a === '--title') opts.title = argv[++i]
  else if (a === '--body') opts.body = argv[++i]
  else if (a === '--severity') opts.severity = argv[++i]
  else if (a === '--source') opts.source = argv[++i]
}

const run = (bin, args, cwd) => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
  return `${r.stdout || ''} ${r.stderr || ''}`.trim()
}

if (opts.checkRemote) {
  const mpwDir = resolve(new URL('..', import.meta.url).pathname)
  const kGpu = run('kaggle', ['kernels', 'status', 'edmundrosariosunil/kaggle-qwen-coder'])
  const kTpu = run('kaggle', ['kernels', 'status', 'edmundrosariosunil/kaggle-tpu-smoke'])
  const colab = run('colab', ['sessions'])
  const colabUsage = run('colab', ['usage'])
  const ghCi = run('gh', ['run', 'list', '--limit', '1', '--json', 'databaseId,status,conclusion'], mpwDir)

  const rateMatch = colabUsage.match(/Usage rate:\s*([0-9.]+)\/hr/i)
  const colabRate = rateMatch ? Number(rateMatch[1]) : 0
  const current = {
    kaggleGpu: (kGpu.match(/KernelWorkerStatus\.[A-Z]+/) || ['UNKNOWN'])[0],
    kaggleTpu: (kTpu.match(/KernelWorkerStatus\.[A-Z]+/) || ['UNKNOWN'])[0],
    colabSessions: /No active sessions/i.test(colab) ? 'none' : (colab.split(/\r?\n/).find((l) => /Hardware:/i.test(l)) || 'active').trim(),
    colabBurnRate: colabRate > 0 ? `BURNING:${colabRate}/hr` : '0.00/hr',
    githubCi: ghCi.slice(0, 140)
  }

  const prev = loadRemoteState()
  const transitions = diffRemoteStates(prev, current)
  const emitted = []
  for (const tr of transitions) {
    const sev = /ERROR|failure|BURNING/i.test(tr.after) ? 'critical' : 'info'
    emitted.push(emitNotification({
      title: `${tr.key} changed`,
      body: `${tr.before ?? 'initial'} -> ${tr.after}`,
      severity: sev,
      source: tr.key.startsWith('kaggle') ? 'kaggle' : tr.key.startsWith('colab') ? 'colab' : 'github',
      desktop: opts.desktop,
      dryRun: opts.dryRun
    }))
  }
  if (!opts.dryRun) saveRemoteState(undefined, current)
  const payload = { ok: true, current, transitions, notifiedCount: emitted.length }
  process.stdout.write(opts.json ? `${JSON.stringify(payload, null, 2)}\n` : `remote-check: ${transitions.length} transition(s)\n`)
  process.exit(0)
}

const res = emitNotification(opts)
process.stdout.write(opts.json ? `${JSON.stringify(res, null, 2)}\n` : `notified: [${opts.source}] ${res.record.title}\n`)

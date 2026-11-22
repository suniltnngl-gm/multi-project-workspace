#!/usr/bin/env node
/**
 * Lightweight direct tool-calling CLI (`swarm direct`, <30 MB RAM).
 * Supports Cloudflare Workers AI (`cloudflare`) and Vercel AI Gateway (`vercel`)
 * with allowlisted local tools (`read_file`, `git_grep`, opt-in `protected_write`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runDirectToolLoop } from '../apps/api/src/toolchain/dispatch/direct-tool-loop.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-direct.mjs --provider <cloudflare|vercel> --prompt <text> [options]
      --provider <cloudflare|vercel>  Direct endpoint (default: cloudflare)
  -p, --prompt <text>                 Prompt text (required)
      --repo <dir>                    Repository root for local tools (default: cwd)
      --max-turns <n>                 Max tool-loop turns (default: 4)
      --allow-writes                  Enable protected_write tool (default: read-only)
      --json                          Output JSON
  -h, --help                          Show this help
`)
  process.exit(0)
}

const opts = { provider: 'cloudflare', prompt: '', repoDir: process.cwd(), maxTurns: 4, allowWrites: false, json: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--allow-writes') opts.allowWrites = true
  else if (a === '--provider') opts.provider = argv[++i]
  else if (a === '--prompt' || a === '-p') opts.prompt = argv[++i]
  else if (a === '--repo') opts.repoDir = resolve(argv[++i])
  else if (a === '--max-turns') opts.maxTurns = Number(argv[++i]) || 4
}

if (!opts.prompt.trim()) {
  process.stderr.write('swarm-direct: missing --prompt <text>\n')
  process.exit(1)
}

function readEnvVal(paths, keyName) {
  if (process.env[keyName]) return process.env[keyName]
  for (const p of paths) {
    if (!existsSync(p)) continue
    const m = readFileSync(p, 'utf8').match(new RegExp(`^(?:export\\s+)?${keyName}=(.+)$`, 'm'))
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const home = homedir()
let callModel

if (opts.provider === 'cloudflare') {
  const paths = [join(home, 'Code/AI/cloudflare-ai/.env'), join(home, 'Code/ENV.env')]
  const tok = readEnvVal(paths, 'CLOUDFLARE_API_TOKEN')
  const acc = readEnvVal(paths, 'CLOUDFLARE_ACCOUNT_ID')
  if (!tok || !acc) { process.stderr.write('swarm-direct: missing CLOUDFLARE_API_TOKEN/ACCOUNT_ID\n'); process.exit(1) }
  callModel = async (messages) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    }).then((x) => x.json())
    return r?.result?.response ?? ''
  }
} else if (opts.provider === 'vercel') {
  const paths = [join(home, 'Code/AI/vercel/.env'), join(home, 'Code/ENV.env')]
  const key = readEnvVal(paths, 'AI_GATEWAY_API_KEY')
  if (!key) { process.stderr.write('swarm-direct: missing AI_GATEWAY_API_KEY\n'); process.exit(1) }
  callModel = async (messages) => {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages })
    }).then((x) => x.json())
    return r?.choices?.[0]?.message?.content ?? ''
  }
} else {
  process.stderr.write(`swarm-direct: unsupported provider '${opts.provider}'\n`)
  process.exit(1)
}

const t0 = Date.now()
const res = await runDirectToolLoop({
  callModel,
  prompt: opts.prompt,
  repoDir: opts.repoDir,
  maxTurns: opts.maxTurns,
  allowWrites: opts.allowWrites
})
const out = { ...res, provider: opts.provider, durationMs: Date.now() - t0 }
process.stdout.write(opts.json ? `${JSON.stringify(out, null, 2)}\n` : `${res.finalAnswer || ''}\n`)
process.exit(res.ok ? 0 : 1)

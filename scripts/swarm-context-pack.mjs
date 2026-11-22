#!/usr/bin/env node
/**
 * Zero-LLM local discovery & bounded context packer (Task #172, Week 2).
 *
 * Pre-packs git status, git diff, git grep matches, and targeted file excerpts
 * into a bounded prompt bundle before invoking local-llama-cli or cloud siblings.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4)
}

function safeGit(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

export const POOL_MAX_CHARS = Object.freeze({
  'console-groq': 6000,
  'opencode-console-groq': 6000
})

export function buildContextPack({
  repoDir = process.cwd(),
  query = null,
  files = [],
  includeDiff = false,
  sinceSha = null,
  pool = null,
  maxChars = 8000,
  maxGrepLines = 25
} = {}) {
  const poolCap = pool && POOL_MAX_CHARS[pool] ? POOL_MAX_CHARS[pool] : maxChars
  const effectiveMaxChars = Math.min(maxChars, poolCap)
  const root = resolve(repoDir)
  const sections = []

  if (sinceSha && String(sinceSha).trim()) {
    const ref = String(sinceSha).trim()
    const logOut = safeGit(root, ['log', '--oneline', `${ref}..HEAD`])
    if (logOut) sections.push({ name: `git_delta_log:${ref}..HEAD`, content: logOut.split(/\r?\n/).slice(0, 30).join('\n') })
    const statOut = safeGit(root, ['diff', '--stat', `${ref}..HEAD`])
    if (statOut) sections.push({ name: `git_delta_stat:${ref}..HEAD`, content: statOut })
  }

  const status = safeGit(root, ['status', '--short'])
  if (status) {
    sections.push({ name: 'git_status', content: status.split(/\r?\n/).slice(0, 30).join('\n') })
  }

  if (includeDiff) {
    const diffStat = safeGit(root, ['diff', '--stat'])
    if (diffStat) sections.push({ name: 'git_diff_stat', content: diffStat })
  }

  if (query && String(query).trim()) {
    const grepOut = safeGit(root, ['grep', '-n', '-I', '--max-count', '5', String(query).trim()])
    if (grepOut) {
      sections.push({
        name: 'git_grep',
        content: grepOut.split(/\r?\n/).slice(0, maxGrepLines).join('\n')
      })
    }
  }

  for (const f of files) {
    const abs = resolve(root, f)
    if (!existsSync(abs)) continue
    const rel = relative(root, abs)
    const raw = readFileSync(abs, 'utf8')
    sections.push({ name: `file:${rel}`, content: raw })
  }

  let text = sections.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')
  let truncated = false
  if (text.length > effectiveMaxChars) {
    text = `${text.slice(0, Math.max(0, effectiveMaxChars - 24))}\n...[truncated ${text.length - effectiveMaxChars} chars]`
    truncated = true
  }

  return {
    ok: true,
    repo: root,
    sectionCount: sections.length,
    sections: sections.map((s) => s.name),
    charCount: text.length,
    estimatedTokens: estimateTokens(text),
    truncated,
    text
  }
}

const argv = process.argv.slice(2)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (isMain) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-context-pack.mjs [options]
      --repo <dir>          Repository root (default: cwd)
  -q, --query <pattern>     Run bounded git grep -n
      --files <a,b,c>       Comma-separated file paths to include
      --diff                Include git diff --stat
      --since-sha <sha>     Include git log/diff delta since <sha>
      --pool <name>         Apply pool-specific char cap (e.g. console-groq=6000)
      --max-chars <n>       Max character budget (default: 8000)
  -o, --out <path>          Write packed context to file
      --json                Output JSON metadata + text
  -h, --help                Show this help
`)
    process.exit(0)
  }
  const opts = {
    repoDir: process.cwd(),
    query: null,
    files: [],
    includeDiff: false,
    sinceSha: null,
    maxChars: 8000,
    out: null,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--diff') opts.includeDiff = true
    else if (a === '--since-sha') opts.sinceSha = argv[++i]
    else if (a === '--pool') opts.pool = argv[++i]
    else if (a === '--repo') opts.repoDir = argv[++i]
    else if (a === '--query' || a === '-q') opts.query = argv[++i]
    else if (a === '--files') opts.files = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--max-chars') opts.maxChars = Number(argv[++i]) || 8000
    else if (a === '--out' || a === '-o') opts.out = argv[++i]
  }

  const pack = buildContextPack(opts)
  if (opts.out) {
    writeFileSync(opts.out, `${pack.text}\n`, 'utf8')
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...pack, outFile: opts.out || null }, null, 2)}\n`)
  } else {
    process.stdout.write(`${pack.text}\n`)
  }
}

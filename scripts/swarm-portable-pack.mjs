#!/usr/bin/env node
/**
 * W4 portable workspace bundle (#292 / #297).
 *
 * Zero-LLM packer that assembles a self-contained, reconstructible workspace
 * bundle: manifest, workflow scripts, lessons subset, queue/cases snapshot and
 * ideas docs — with all secret-bearing content excluded or redacted.
 *
 * Secrets policy (fail closed): .env / key-file names are excluded outright;
 * any copied text matching secret patterns (sk-…, gn_…, Bearer tokens, key=value
 * assignment with KEY/TOKEN/SECRET in the name) is redacted to [REDACTED].
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

export const SECRET_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|gn_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{16,})/g
export const SECRET_ASSIGN_PATTERN = /^\s*[A-Za-z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*\s*=\s*\S+.*$/gm
export const SECRET_FILENAME_PATTERN = /(^|\/)\.env($|\.|[^/]*$)|(^|\/)[^/]*\.pem$|(^|\/)[^/]*credentials[^/]*$|(^|\/)[^/]*graphn\.env$/i

export function redactSecrets(text) {
  return String(text || '')
    .replace(SECRET_KEY_PATTERN, '[REDACTED]')
    .replace(SECRET_ASSIGN_PATTERN, (line) => `${line.split('=')[0].trim()}=[REDACTED]`)
}

export function isSecretPath(relPath) {
  return SECRET_FILENAME_PATTERN.test(String(relPath || ''))
}

function listFilesRecursive(dir, { maxFiles = 400, maxBytes = 512 * 1024 } = {}) {
  if (!dir || !existsSync(dir)) return []
  const out = []
  const walk = (cur) => {
    if (out.length >= maxFiles) return
    for (const name of readdirSync(cur).sort()) {
      const abs = join(cur, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile() && st.size <= maxBytes) out.push(abs)
      if (out.length >= maxFiles) return
    }
  }
  walk(dir)
  return out
}

/**
 * Build the portable bundle as an in-memory file map { relPath -> content }.
 * Everything is derived from the repo + state dirs; nothing is mutated.
 */
export function buildPortableBundle({
  repoDir = process.cwd(),
  stateDir = join(process.env.HOME || '', '.local', 'state', 'curl-ai-bridge'),
  maxFileBytes = 256 * 1024
} = {}) {
  const files = new Map()
  let excludedSecrets = 0
  let redactedFiles = 0

  const put = (relPath, content) => {
    if (isSecretPath(relPath)) {
      excludedSecrets++
      return
    }
    const text = redactSecrets(content)
    if (text !== content) redactedFiles++
    files.set(relPath, text)
  }

  // 1. Workflow scripts (the swarm loop itself).
  const scriptsDir = join(repoDir, 'scripts')
  if (existsSync(scriptsDir)) {
    for (const abs of listFilesRecursive(scriptsDir)) {
      const name = basename(abs)
      if (/^swarm-.*\.mjs$/.test(name)) {
        const raw = readFileSync(abs, 'utf8')
        if (raw.length <= maxFileBytes) put(join('workflows', name), raw)
      }
    }
  }

  // 2. Lessons subset (decision lessons + register).
  const lessonsDir = join(stateDir, 'lessons')
  for (const abs of listFilesRecursive(lessonsDir, { maxFiles: 50 })) {
    put(join('state', 'lessons', relative(lessonsDir, abs)), readFileSync(abs, 'utf8'))
  }

  // 3. Queue + cases snapshot.
  const queueDir = join(stateDir, 'queue')
  for (const sub of ['active', 'cases']) {
    for (const abs of listFilesRecursive(join(queueDir, sub), { maxFiles: 100 })) {
      put(join('state', 'queue', sub, relative(join(queueDir, sub), abs)), readFileSync(abs, 'utf8'))
    }
  }

  // 4. Ideas docs (portable knowledge).
  const ideasDir = join(repoDir, 'docs', 'ideas')
  for (const abs of listFilesRecursive(ideasDir, { maxFiles: 100 })) {
    put(join('docs', 'ideas', relative(ideasDir, abs)), readFileSync(abs, 'utf8'))
  }

  const manifest = {
    schema: 'portable-workspace/v1',
    createdAt: new Date().toISOString(),
    repoDir,
    stateDir,
    fileCount: files.size,
    excludedSecrets,
    redactedFiles,
    contents: {
      workflows: [...files.keys()].filter((p) => p.startsWith('workflows/')),
      state: [...files.keys()].filter((p) => p.startsWith('state/')),
      docs: [...files.keys()].filter((p) => p.startsWith('docs/'))
    }
  }

  return {
    ok: true,
    manifest,
    files,
    totalChars: [...files.values()].reduce((n, c) => n + c.length, 0)
  }
}

/** Write the bundle to an output directory. Returns the manifest summary. */
export function writePortableBundle(bundle, outDir) {
  if (!outDir) throw new Error('writePortableBundle: outDir required')
  mkdirSync(outDir, { recursive: true })
  for (const [rel, content] of bundle.files) {
    const abs = join(outDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  const manifestPath = join(outDir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`)
  return { ok: true, outDir, manifestPath, fileCount: bundle.manifest.fileCount }
}

const isMain = process.argv[1] && process.argv[1].endsWith('swarm-portable-pack.mjs')

if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node scripts/swarm-portable-pack.mjs [options]
      --repo <dir>       Repo root (default: cwd)
      --state <dir>      State root (default: ~/.local/state/curl-ai-bridge)
  -o, --out <dir>        Write bundle here (required to persist; prints summary otherwise)
      --json             Output full JSON summary
  -h, --help             Show this help
`)
    process.exit(0)
  }
  const opt = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : null
  }
  const bundle = buildPortableBundle({ repoDir: opt('--repo') || process.cwd(), stateDir: opt('--state') || undefined })
  const out = opt('--out')
  if (out) {
    const res = writePortableBundle(bundle, out)
    process.stdout.write(JSON.stringify({ ...res, excludedSecrets: bundle.manifest.excludedSecrets, redactedFiles: bundle.manifest.redactedFiles }) + '\n')
  } else {
    const { manifest, totalChars } = bundle
    process.stdout.write(JSON.stringify({ ok: true, fileCount: manifest.fileCount, totalChars, excludedSecrets: manifest.excludedSecrets, redactedFiles: manifest.redactedFiles, workflows: manifest.contents.workflows.length, state: manifest.contents.state.length, docs: manifest.contents.docs.length }) + '\n')
  }
}

/**
 * WFL-309 (#308) — pre-implementation redundancy scan.
 *
 * Before implementing an operator directive, two read-only scans establish
 * whether the concept already exists canonically:
 *  1. codebase scan — canonical terms against repo source/docs;
 *  2. prompt-history scan — operator session logs (CLI-specific locations:
 *     vibe, codex, opencode, swarm sessions) for prior phrasings/ratifications.
 *
 * Anti-goal this prevents: repeated/paraphrased operator messages spawning
 * redundant parallel concepts, duplicate implementations, split-brain state.
 * Read-only by construction: no writes, bounded walk (file count + size).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.jsonl', '.sh', '.ps1', '.txt'])
const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_FILE_BYTES = 512 * 1024

function walkFiles (root, { maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch { continue }
    for (const e of entries) {
      if (out.length >= maxFiles) break
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue
        stack.push(p)
      } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
        try {
          if (statSync(p).size > maxFileBytes) continue
        } catch { continue }
        out.push(p)
      }
    }
  }
  return out
}

function scanFiles (files, terms) {
  const hits = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const term of terms) {
        if (lines[i].toLowerCase().includes(term.toLowerCase())) {
          hits.push({ path: file, line: i + 1, term, text: lines[i].trim().slice(0, 200) })
        }
      }
    }
  }
  return hits
}

/** Canonical prompt-history roots: CLI-specific operator session locations. */
export function promptHistoryRoots (env = process.env) {
  const home = env.HOME || homedir()
  return [
    join(home, '.vibe'),
    join(home, '.codex'),
    join(home, '.local', 'share', 'opencode'),
    join(home, '.config', 'opencode'),
    join(home, '.local', 'state', 'curl-ai-bridge', 'sessions')
  ].filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
}

/**
 * Scan the codebase under repoDir (scripts/, apps/, docs/, tests via whole-tree
 * walk) for occurrences of the given terms. Read-only, bounded.
 */
export function scanCodebaseForConcept ({ terms, repoDir, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const list = normalizeTerms(terms)
  if (!repoDir) throw new Error('repo_dir_required')
  const files = walkFiles(repoDir, { maxFiles })
  return { terms: list, filesScanned: files.length, hits: scanFiles(files, list) }
}

/** Scan operator prompt-history roots for the given terms. Read-only, bounded. */
export function scanPromptHistory ({ terms, env = process.env, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const list = normalizeTerms(terms)
  const roots = promptHistoryRoots(env)
  const files = roots.flatMap((r) => walkFiles(r, { maxFiles }))
  return { terms: list, roots, filesScanned: files.length, hits: scanFiles(files, list) }
}

/**
 * Full pre-implementation scan: codebase + prompt history in one verdict.
 * summary.duplicateRisk is true when the exact canonical term already exists
 * in code (extend, don't re-create).
 */
export function preImplementationScan ({ terms, repoDir, env = process.env, maxFiles } = {}) {
  const code = scanCodebaseForConcept({ terms, repoDir, maxFiles })
  const history = scanPromptHistory({ terms, env, maxFiles })
  return {
    terms: code.terms,
    code: { filesScanned: code.filesScanned, hitCount: code.hits.length, hits: code.hits.slice(0, 50) },
    history: { roots: history.roots, filesScanned: history.filesScanned, hitCount: history.hits.length, hits: history.hits.slice(0, 50) },
    summary: {
      duplicateRisk: code.hits.length > 0,
      historyPrecedent: history.hits.length > 0
    }
  }
}

function normalizeTerms (terms) {
  const list = (Array.isArray(terms) ? terms : String(terms || '').split(','))
    .map((t) => String(t).trim()).filter(Boolean)
  if (!list.length) throw new Error('terms_required')
  return list
}

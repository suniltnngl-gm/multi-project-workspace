#!/usr/bin/env node
/**
 * Swarm JSONL session compactor CLI (`swarm compact`).
 * Defaults to --dry-run. Pass --apply to compact with protected single-file backup.
 */
import { resolve } from 'node:path'
import { compactSessionFile } from '../apps/api/src/toolchain/dispatch/session-compactor.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`Usage: node scripts/swarm-compact.mjs --file <session.jsonl> [options]
      --file <path>          Path to JSONL session file (required)
      --keep-recent <n>      Verbatim recent turns to keep (default: 4)
      --max-chars <n>        Max summary character budget (default: 1200)
      --dry-run              Preview compaction only (default)
      --apply                Write compacted file with protected single-file backup
      --json                 Output JSON
  -h, --help                 Show this help
`)
  process.exit(0)
}

const opts = { file: null, keepRecent: 4, maxSummaryChars: 1200, apply: false, json: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') opts.json = true
  else if (a === '--apply') opts.apply = true
  else if (a === '--dry-run') opts.apply = false
  else if (a === '--file' || a === '-f') opts.file = resolve(argv[++i])
  else if (a === '--keep-recent') opts.keepRecent = Number(argv[++i]) || 4
  else if (a === '--max-chars') opts.maxSummaryChars = Number(argv[++i]) || 1200
}

if (!opts.file) {
  process.stderr.write('swarm-compact: missing --file <session.jsonl>\n')
  process.exit(1)
}

const res = compactSessionFile(opts.file, opts)
process.stdout.write(opts.json ? `${JSON.stringify(res, null, 2)}\n` : `compact: ${res.beforeCount} -> ${res.afterCount} turns (folded ${res.foldedCount})\n`)
process.exit(res.ok ? 0 : 1)

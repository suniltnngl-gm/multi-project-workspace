#!/usr/bin/env node
/**
 * Step 5 Offload: Zero-AGY Independent Diff Review & Test Gate (`swarm review`).
 *
 * 1. Deterministic $0 gates: `git diff --check` (whitespace/conflict markers), secret scan,
 *    and optional focused `node --test <file>`.
 * 2. Optional $0 LLM sibling verdict via `swarm-direct.mjs` (`cloudflare` / `vercel`).
 * 3. Emits `{ verdict: "ACCEPT"|"REJECT", reason, reviewedAt }` (and writes `--verdict-out`).
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { statePaths } from './swarm-state-paths.mjs'
import { fileURLToPath } from 'node:url'
import { protectedWriteFile } from '../apps/api/src/toolchain/dispatch/mutation-guard.js'
import { redactSecrets } from '../apps/api/src/toolchain/dispatch/session-handoff.js'

export function evaluateDeterministicDiff({ diffText = '', diffCheckExitCode = 0, testExitCode = 0 } = {}) {
  if (diffCheckExitCode !== 0) {
    return { ok: false, verdict: 'REJECT', reason: 'git_diff_check_failed' }
  }
  if (testExitCode !== 0) {
    return { ok: false, verdict: 'REJECT', reason: 'unit_tests_failed' }
  }
  const addedOrRaw = diffText.includes('\n+')
    ? diffText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n')
    : diffText
  const redacted = redactSecrets(addedOrRaw)
  if (redacted !== addedOrRaw) {
    return { ok: false, verdict: 'REJECT', reason: 'secret_pattern_detected_in_diff' }
  }
  if (/\b(git\s+push\s+--force|git\s+reset\s+--hard|git\s+checkout\s+(?:--\s+)?\.|git\s+restore\s+(?:--staged\s+--worktree\s+|--worktree\s+)?\.)(?:\s|$)/.test(addedOrRaw)) {
    return { ok: false, verdict: 'REJECT', reason: 'unrecoverable_command_in_diff' }
  }
  return { ok: true, verdict: 'ACCEPT', reason: 'deterministic_gates_passed' }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: swarm review [--repo <dir>] [--test <test_file>] [--llm] [--provider cloudflare|vercel] [--verdict-out <file>] [--json]')
    process.exit(0)
  }
  const flag = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb }
  const repoDir = resolve(flag('--repo', resolve(new URL('..', import.meta.url).pathname)))
  const testFile = flag('--test', null)
  const verdictOut = flag('--verdict-out', null)
  const useLlm = argv.includes('--llm')
  const provider = flag('--provider', 'cloudflare')

  const diffCheck = spawnSync('git', ['-C', repoDir, 'diff', '--check'], { encoding: 'utf8', timeout: 5000 })
  const diffRes = spawnSync('git', ['-C', repoDir, 'diff', 'HEAD'], { encoding: 'utf8', timeout: 5000 })
  let testExitCode = 0
  if (testFile) {
    const tr = spawnSync(process.execPath, ['--test', resolve(repoDir, testFile)], { cwd: resolve(repoDir, 'apps/api'), encoding: 'utf8', timeout: 60_000 })
    testExitCode = tr.status ?? 1
  }

  let result = evaluateDeterministicDiff({
    diffText: diffRes.stdout || '',
    diffCheckExitCode: diffCheck.status ?? 1,
    testExitCode
  })

  if (result.ok && useLlm && (diffRes.stdout || '').trim()) {
    const directCli = resolve(new URL('./swarm-direct.mjs', import.meta.url).pathname)
    const snippet = String(diffRes.stdout || '').slice(0, 3500)
    const lr = spawnSync(
      process.execPath,
      [directCli, '--provider', provider, '--prompt', `Review this git diff. Reply in <=3 bullets and end with VERDICT: ACCEPT or VERDICT: REJECT.\n${snippet}`],
      { encoding: 'utf8', timeout: 30_000 }
    )
    const out = String(lr.stdout || '')
    if (/VERDICT:\s*REJECT/i.test(out)) {
      result = { ok: false, verdict: 'REJECT', reason: `llm_${provider}_rejected`, notes: out.trim() }
    } else {
      result = { ok: true, verdict: 'ACCEPT', reason: `deterministic_and_llm_${provider}_accepted`, notes: out.trim() }
    }
  }

  const headRes = spawnSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5000 })
  const headSha = (headRes.stdout || '').trim() || 'unknown'
  const { reportsDir } = statePaths()
  const defaultVerdictPath = join(reportsDir, `review-latest-${headSha}.json`)
  const payload = { ...result, headSha, reviewedAt: new Date().toISOString() }
  const outPath = resolve(verdictOut || defaultVerdictPath)
  protectedWriteFile(outPath, `${JSON.stringify(payload, null, 2)}\n`)
  if (argv.includes('--json')) console.log(JSON.stringify({ ...payload, verdictPath: outPath }, null, 2))
  else console.log(`swarm review: VERDICT: ${payload.verdict} (${payload.reason}) -> ${outPath}`)
  process.exit(payload.verdict === 'ACCEPT' ? 0 : 1)
}

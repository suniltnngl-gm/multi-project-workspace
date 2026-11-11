// Objective: Run allowlisted deterministic checks in bounded subprocesses.
// Requirements: Only fixed commands from the allowlist run; every run has a timeout and captured output.
// Decisions: spawn without a shell so request bodies can never inject commands; checks run sequentially and resolve to structured pass, fail, timeout, or error states.
// Relevant Files: apps/api/src/localVerifier.js, apps/api/src/app.js, apps/api/test/verifier.test.js
// Important Context: User file. Deliberately separate from the model registry: verification is deterministic, not an LLM backend.
// Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import { spawn } from 'node:child_process'

const MAX_OUTPUT_LENGTH = 64 * 1024

/**
 * Fixed allowlist of deterministic checks. Request bodies select entries by
 * id and can never supply commands, arguments, or timeouts of their own.
 * There is no typecheck entry because the workspace has no typecheck step.
 */
const DEFAULT_CHECKS = [
  {
    id: 'lint',
    title: 'Lint',
    command: 'npm',
    args: ['run', 'lint'],
    timeoutMs: 120000
  },
  {
    id: 'web-tests',
    title: 'Web tests',
    command: 'npm',
    args: ['test', '--workspace', 'apps/web'],
    timeoutMs: 300000
  },
  {
    id: 'api-tests',
    title: 'API tests',
    command: 'npm',
    args: ['test', '--workspace', 'apps/api'],
    timeoutMs: 300000
  },
  {
    id: 'python-tests',
    title: 'Python tests',
    command: 'uv',
    args: ['run', '--project', 'apps/python', 'python', '-m', 'unittest', 'discover', '-s', 'apps/python/tests'],
    timeoutMs: 300000,
    env: { PYTHONPATH: 'apps/python/src' }
  },
  {
    id: 'build',
    title: 'Web build',
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: 300000
  }
]

export class VerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VerificationError'
  }
}

export function createLocalVerifier({ rootDir, checks = DEFAULT_CHECKS } = {}) {
  if (!rootDir || typeof rootDir !== 'string') {
    throw new VerificationError('A local verifier requires a repository root directory.')
  }

  function listChecks() {
    return checks.map(({ id, title, command, args, timeoutMs }) => ({
      id, title, command, args, timeoutMs
    }))
  }

  function runCheck(check) {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      let output = ''
      let truncated = false
      const append = (chunk) => {
        if (output.length >= MAX_OUTPUT_LENGTH) {
          truncated = true
          return
        }
        const text = chunk.toString('utf8')
        if (output.length + text.length > MAX_OUTPUT_LENGTH) {
          output += text.slice(0, MAX_OUTPUT_LENGTH - output.length)
          truncated = true
          return
        }
        output += text
      }
      let timedOut = false
      const child = spawn(check.command, check.args, {
        cwd: rootDir,
        env: { ...process.env, ...check.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, check.timeoutMs)
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({
          id: check.id,
          title: check.title,
          state: 'error',
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          output,
          outputTruncated: truncated,
          error: error.message
        })
      })
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer)
        resolve({
          id: check.id,
          title: check.title,
          state: timedOut ? 'timeout' : (exitCode === 0 ? 'pass' : 'fail'),
          exitCode,
          signal: signal ?? null,
          durationMs: Date.now() - startedAt,
          output,
          outputTruncated: truncated
        })
      })
    })
  }

  async function runChecks(requestedChecks) {
    let selected = checks
    if (requestedChecks !== undefined) {
      if (!Array.isArray(requestedChecks) || requestedChecks.some((id) => typeof id !== 'string')) {
        throw new VerificationError('checks must be an array of check ids.')
      }
      const known = new Map(checks.map((check) => [check.id, check]))
      const unknown = requestedChecks.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        throw new VerificationError(
          `Unknown check: ${unknown.join(', ')}. Allowed checks: ${checks.map((check) => check.id).join(', ')}.`
        )
      }
      selected = [...new Set(requestedChecks)].map((id) => known.get(id))
    }
    const results = []
    for (const check of selected) {
      results.push(await runCheck(check))
    }
    return {
      passed: results.length > 0 && results.every((result) => result.state === 'pass'),
      results
    }
  }

  return { listChecks, runChecks }
}

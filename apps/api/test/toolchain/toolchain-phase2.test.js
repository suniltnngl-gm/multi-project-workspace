import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanToolchain } from '../../src/toolchain/index.js'
import {
  TOOLCHAIN_ENV_ALLOWLIST,
  loadToolchainEnvConfig,
  parseDotEnv
} from '../../src/toolchain/configuration/env-config-loader.js'
import { runToolchainDoctor } from '../../src/toolchain/diagnostics/toolchain-doctor.js'
import { generateToolchainPlan } from '../../src/toolchain/configuration/shell-config-generator.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

test('parseDotEnv extracts only allowlisted toolchain keys and never leaks secrets', () => {
  const parsed = parseDotEnv([
    '# comment',
    'NPM_CONFIG_PREFIX="/home/dev/\\"quoted\\"/.npm-global"',
    'export UV_CACHE_DIR=/tmp/uv-cache # inline comment',
    'OPENAI_API_KEY=sk-secret-must-not-leak',
    'GITHUB_TOKEN=ghp_secret_must_not_leak',
    'AGY_BIN=/home/dev/.local/bin/agy'
  ].join('\n'))

  assert.equal(parsed.NPM_CONFIG_PREFIX, '/home/dev/"quoted"/.npm-global')
  assert.equal(parsed.UV_CACHE_DIR, '/tmp/uv-cache')
  assert.equal(parsed.AGY_BIN, '/home/dev/.local/bin/agy')
  assert.equal('OPENAI_API_KEY' in parsed, false)
  assert.equal('GITHUB_TOKEN' in parsed, false)
  assert.ok(TOOLCHAIN_ENV_ALLOWLIST.includes('UV_BIN'))
  assert.ok(TOOLCHAIN_ENV_ALLOWLIST.includes('NPM_CONFIG_PREFIX'))
})

test('loadToolchainEnvConfig enforces precedence: process.env > .env.local > .env > discovery', () => {
  const files = {
    '/proj/.env': 'UV_BIN=/from/dotenv/uv\nNPM_CONFIG_PREFIX=/from/dotenv/npm\nGH_BIN=/from/dotenv/gh\n',
    '/proj/.env.local': 'UV_BIN=/from/local/uv\nNPM_CONFIG_PREFIX=/from/local/npm\n'
  }
  const fakeInventory = {
    node: { active: { path: '/discovered/node' }, npm: { globalPrefix: '/discovered/npm' }, managers: { fnm: {}, nvm: {} } },
    python: { active: { path: '/discovered/python3' }, uv: { path: '/discovered/uv' } },
    utilities: [{ name: 'git', available: true, path: '/usr/bin/git' }],
    aiClis: [{ name: 'agy', available: true, path: '/discovered/agy' }]
  }

  const config = loadToolchainEnvConfig({
    cwd: '/proj',
    env: { UV_BIN: '/from/env/uv', SECRET_TOKEN: 'do-not-expose' },
    inventory: fakeInventory,
    readText: (p) => files[p] || null
  })

  assert.equal(config.readOnly, true)
  assert.equal(config.values.UV_BIN, '/from/env/uv')
  assert.equal(config.sources.UV_BIN, 'process.env')
  assert.equal(config.values.NPM_CONFIG_PREFIX, '/from/local/npm')
  assert.equal(config.sources.NPM_CONFIG_PREFIX, '.env.local')
  assert.equal(config.values.GH_BIN, '/from/dotenv/gh')
  assert.equal(config.sources.GH_BIN, '.env')
  assert.equal(config.values.NODE_BIN, '/discovered/node')
  assert.equal(config.sources.NODE_BIN, 'discovery')
  assert.equal(config.values.AGY_BIN, '/discovered/agy')
  assert.equal('SECRET_TOKEN' in config.values, false)
})

test('runToolchainDoctor flags broken symlinks, missing Node/git, and inactive .venv', () => {
  const existing = new Set(['/proj/.venv/bin/python', '/proj/.venv/bin/activate'])
  const broken = new Set(['/home/dev/.local/bin/jq'])
  const inv = scanToolchain({
    platform: 'linux',
    cwd: '/proj',
    env: { HOME: '/home/dev', PATH: '/home/dev/.local/bin' },
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: (p) => broken.has(p),
    readText: () => null,
    runCommand: () => ({ ok: false, stdout: '', stderr: '' })
  })

  const report = runToolchainDoctor(inv)
  assert.equal(report.mode, 'doctor')
  assert.equal(report.readOnly, true)
  assert.equal(report.healthy, false)
  assert.ok(report.checks.some((c) => c.area === 'symlink' && c.level === 'error'))
  assert.ok(report.checks.some((c) => c.area === 'node' && c.level === 'error'))
  assert.ok(report.checks.some((c) => c.area === 'venv' && c.level === 'warn'))
})

test('generateToolchainPlan emits idempotent, read-only snippets for bash, PS 5.1, pwsh 7, cmd, and dotenv', () => {
  const existing = new Set([
    'C:\\Proj\\.venv\\Scripts\\python.exe',
    'C:\\Proj\\.venv\\Scripts\\Activate.ps1',
    'C:\\Proj\\.venv\\Scripts\\activate.bat',
    'C:\\Users\\dev\\.local\\bin\\uv.exe'
  ])
  const inv = scanToolchain({
    platform: 'win32',
    cwd: 'C:\\Proj',
    env: {
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      PATH: 'C:\\Users\\dev\\.local\\bin'
    },
    fileExists: (p) => existing.has(p),
    isBrokenSymlink: () => false,
    runCommand: () => ({ ok: true, stdout: '1.0.0', stderr: '' })
  })
  const envConfig = loadToolchainEnvConfig({ cwd: 'C:\\Proj', env: {}, inventory: inv, readText: () => null })
  const plan = generateToolchainPlan(inv, envConfig)

  assert.equal(plan.mode, 'plan')
  assert.equal(plan.readOnly, true)
  assert.equal(plan.applied, false)
  assert.match(plan.snippets.powershell5, /Activate\.ps1/)
  assert.match(plan.snippets.pwsh7, /\$env:Path/)
  assert.match(plan.snippets.cmd, /activate\.bat/)
  assert.match(plan.snippets.dotenv, /UV_BIN=/)
})

test('shell snippets escape adversarial paths and dotenv rejects newline injection', () => {
  const adversarialInventory = {
    os: { family: 'windows', isWindows: true },
    node: { npm: { globalBin: "C:\\Users\\o'connor;Write-Host pwned\\$(whoami)\\npm" } },
    python: {
      uv: { installRoot: 'C:\\safe\\uv' },
      projectVenv: {
        activationScripts: {
          bash: "/tmp/o'connor/$(id)/activate",
          powershell: "C:\\Proj\\o'connor\\Activate.ps1",
          cmd: 'C:\\Proj\\&calc.exe\\activate.bat'
        }
      }
    }
  }
  const envConfig = loadToolchainEnvConfig({
    cwd: '/proj',
    env: {
      NODE_BIN: '/usr/bin/node\nINJECTED_VAR=evil',
      UV_BIN: '/home/dev/my tools/uv'
    },
    readText: () => null
  })
  assert.equal('NODE_BIN' in envConfig.values, false, 'newline-poisoned env value must be rejected')
  assert.equal(envConfig.values.UV_BIN, '/home/dev/my tools/uv')

  const plan = generateToolchainPlan(adversarialInventory, {
    values: {
      NODE_BIN: '/usr/bin/node\nINJECTED_VAR=evil',
      UV_BIN: '/home/dev/my tools/uv'
    }
  })

  // PowerShell single quotes must be doubled (no unescaped single quote breaking out)
  assert.match(plan.snippets.powershell5, /o''connor/)
  // Bash POSIX single-quote escaping wraps the entire path safely
  assert.match(plan.snippets.bash, /'\/tmp\/o'\\''connor\/\$\(id\)\/activate'/)
  // CMD must exclude paths with shell metacharacters (&, %, etc.) and never emit unquoted echo %PATH%
  assert.equal(plan.snippets.cmd.includes('calc.exe'), false)
  assert.equal(plan.snippets.cmd.includes('echo %PATH%'), false)
  assert.match(plan.snippets.cmd, /set "PATH=C:\\safe\\uv;%PATH%"/)
  // Dotenv must never emit injected lines
  assert.equal(plan.snippets.dotenv.includes('INJECTED_VAR'), false)
  assert.match(plan.snippets.dotenv, /UV_BIN="\/home\/dev\/my tools\/uv"/)
})

test('scripts/toolchain-doctor.mjs --json and toolchain-plan.mjs --json run read-only cleanly and doctor honors exit code contract', () => {
  const docOut = execFileSync(process.execPath, [resolve(repoRoot, 'scripts/toolchain-doctor.mjs'), '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const doc = JSON.parse(docOut)
  assert.equal(doc.mode, 'doctor')
  assert.equal(doc.readOnly, true)
  assert.equal(doc.healthy, true)

  // Unhealthy environment (empty PATH) must exit with code 1 unless --no-fail is supplied
  let exitStatus = 0
  try {
    execFileSync(process.execPath, [resolve(repoRoot, 'scripts/toolchain-doctor.mjs'), '--json'], {
      cwd: repoRoot,
      env: { PATH: '' },
      encoding: 'utf8'
    })
  } catch (error) {
    exitStatus = error.status
  }
  assert.equal(exitStatus, 1)

  const planOut = execFileSync(process.execPath, [resolve(repoRoot, 'scripts/toolchain-plan.mjs'), '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const plan = JSON.parse(planOut)
  assert.equal(plan.mode, 'plan')
  assert.equal(plan.readOnly, true)
  assert.equal(plan.applied, false)
})

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './workspace-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [target = 'readiness', ...args] = process.argv.slice(2);
const descriptor = readJson(resolve(ROOT, 'workspace-repo.json'));
const run = (command, commandArgs, cwd = ROOT) => spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: { ...process.env, CI: process.env.CI ?? 'true' } });
if (target === 'readiness') {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  const pythonPin = descriptor.runtime.pythonPin;
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const pythonVersion = (python.stdout || python.stderr || '').match(/Python (\d+)\.(\d+)/);
  const pythonOk = Boolean(pythonVersion && (Number(pythonVersion[1]) > 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) >= 12)));
  const executionReady = nodeOk;
  const toolingReady = nodeOk && npm.status === 0 && uv.status === 0 && pythonOk;
  const report = {
    readinessVersion: 1,
    executionReady,
    toolingReady,
    diagnostics: [
      ...(!nodeOk ? [{ code: 'NODE_VERSION_UNSUPPORTED', severity: 'error', message: 'Node.js >=22 is required.' }] : []),
      ...(npm.status !== 0 ? [{ code: 'NPM_MISSING', severity: 'error', message: 'npm is required for workspace verification tooling.' }] : []),
      ...(uv.status !== 0 ? [{ code: 'UV_MISSING', severity: 'error', message: 'uv is required for Core Python tooling.' }] : []),
      ...(!pythonOk ? [{ code: 'PYTHON_VERSION_UNSUPPORTED', severity: 'error', message: 'Python >=3.12 is required.' }] : []),
      { code: 'PYTHON_PREFERRED_PIN', severity: 'info', message: `Preferred Python pin: ${pythonPin}` },
      { code: 'CONTRACT_SECURITY_ENFORCEMENT_DEFERRED', severity: 'info', message: 'P3-B through P3-F are not asserted as implemented by this readiness check.' }
    ]
  };
  console.log(JSON.stringify(report, null, 2));
  if (!toolingReady) process.exitCode = 1;
} else if (target === 'unit') {
  const result = run('npm', ['test']);
  process.exitCode = result.status ?? 1;
} else if (target === 'contract') {
  const result = run(process.execPath, ['scripts/workspace-federation.mjs', 'validate']);
  process.exitCode = result.status ?? 1;
} else if (target === 'portability') {
  const result = run(process.execPath, ['scripts/workspace-portability.mjs', ...args]);
  process.exitCode = result.status ?? 1;
} else {
  console.error('Usage: node scripts/workspace-verify.mjs [unit|contract|readiness|portability]');
  process.exitCode = 2;
}

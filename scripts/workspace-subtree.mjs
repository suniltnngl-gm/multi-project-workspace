#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './workspace-schema.mjs';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [phase = 'preflight', ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) if (args[i].startsWith('--')) options[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
const errors = [], warnings = [];
const fail = (message) => errors.push(message);
const inside = (root, target) => { const rel = relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
function canonicalRepo(input) {
  const candidate = resolve(input);
  const canonical = realpathSync(candidate);
  const git = spawnSync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Target is not a Git worktree.');
  const gitRoot = realpathSync(git.stdout.trim());
  if (gitRoot !== canonical) throw new Error('Target path must be the canonical Git repository root.');
  return canonical;
}
function containedFile(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).some((part) => part === '..' || part === '')) throw new Error(`${label} must be a normalized relative path.`);
  const candidate = resolve(root, relativePath);
  if (!inside(root, candidate)) throw new Error(`${label} escapes repository: ${relativePath}`);
  let cursor = root;
  for (const part of relativePath.split(/[\\/]/)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) throw new Error(`${label} does not exist: ${relativePath}`);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} traverses a symbolic link: ${relativePath}`);
  }
  const canonical = realpathSync(candidate);
  if (!inside(root, canonical)) throw new Error(`${label} canonical path escapes repository: ${relativePath}`);
  if (!lstatSync(canonical).isFile()) throw new Error(`${label} is not a regular file: ${relativePath}`);
  return canonical;
}
let repo, descriptor, descriptorPath, manifest = null;
try {
  repo = canonicalRepo(options.repo ?? ROOT);
  descriptorPath = containedFile(repo, options.descriptor ?? 'workspace-repo.json', 'Descriptor path');
  descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const schemaPath = containedFile(ROOT, 'schemas/workspace-repo.schema.json', 'Descriptor schema');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  errors.push(...validateSchema(descriptor, schema, '$descriptor'));
  const manifestPath = resolve(ROOT, 'workspace.manifest.json');
  if (existsSync(manifestPath)) {
    const canonicalManifest = containedFile(ROOT, 'workspace.manifest.json', 'Workspace manifest');
    manifest = JSON.parse(readFileSync(canonicalManifest, 'utf8'));
  }
} catch (error) { fail(error.message); }
if (descriptor && repo) {
  const manifestEntry = manifest?.repositories?.find((item) => item.repoId === descriptor.repoId) ?? null;
  if (manifest && !manifestEntry) fail('Repository is not registered in the workspace manifest.');
  if (descriptor.capabilityMetadata?.executionAuthority !== false) fail('Capability metadata must never grant execution authority.');
  if (descriptor.provenance?.authority !== 'descriptive-only') fail('Provenance must be descriptive-only.');
  if (descriptor.governance?.status === 'present') {
    try { containedFile(repo, descriptor.governance.file, 'Governance path'); } catch (error) { fail(error.message); }
  }
  if (descriptor.governance?.status === 'deferred-priority-2') warnings.push('AGENTS.md remains deferred under Priority 2; no governance compliance claim is made.');
  const npmManifest = resolve(repo, 'package.json');
  const npmLock = resolve(repo, 'package-lock.json');
  const pythonManifests = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = (awaitlessReaddir(dir)); } catch { return; }
    for (const entry of entries) {
      if (['.git', 'node_modules', '.venv'].includes(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name === 'pyproject.toml') pythonManifests.push(full);
    }
  };
  function awaitlessReaddir(dir) { return requireReaddir(dir, { withFileTypes: true }); }
  const { readdirSync: requireReaddir } = await import('node:fs');
  walk(repo);
  const hasNpm = existsSync(npmManifest);
  if (hasNpm) {
    if (!existsSync(npmLock)) fail('Root package.json requires package-lock.json.');
    if (descriptor.dependencyInstall?.manager !== 'npm' || descriptor.dependencyInstall?.lockfile !== 'package-lock.json') fail('npm manifest requires npm manager and package-lock.json descriptor declaration.');
    if (descriptor.dependencyInstall?.frozen !== true || !descriptor.dependencyInstall?.command?.includes('npm ci')) fail('npm install policy must declare frozen=true and use npm ci.');
  }
  if (pythonManifests.length) {
    if (descriptor.runtime?.pythonManager !== 'uv') fail('pyproject.toml requires runtime.pythonManager=uv.');
    for (const pyproject of pythonManifests) if (!existsSync(resolve(dirname(pyproject), 'uv.lock'))) fail(`Python manifest is missing adjacent uv.lock: ${relative(repo, pyproject)}`);
    if (descriptor.dependencyInstall?.frozen !== true || !descriptor.dependencyInstall?.command?.includes('uv sync --frozen')) fail('uv install policy must declare frozen=true and use uv sync --frozen.');
  }
  if (!hasNpm && !pythonManifests.length && (descriptor.dependencyInstall?.manager !== 'none' || descriptor.dependencyInstall?.policy !== 'no-package-manifest' || descriptor.dependencyInstall?.lockfile !== null)) fail('Repository without package manifests must declare manager=none, lockfile=null and no-package-manifest.');
  if (descriptor.dependencyInstall?.manager === 'npm' && !hasNpm) fail('Descriptor declares npm but package.json is absent.');
  if (descriptor.runtime?.pythonManager === 'uv' && !pythonManifests.length) fail('Descriptor declares uv but pyproject.toml is absent.');
  if (options.prefix) {
    const prefix = options.prefix.replaceAll('\\', '/');
    if (prefix.startsWith('/') || /^[A-Za-z]:/.test(prefix) || prefix.split('/').some((part) => part === '..' || part === '')) fail('Subtree prefix must be a normalized relative path without traversal.');
  }
  const tracked = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8' });
  if (tracked.status !== 0) fail('Target is not a Git worktree.');
  const paths = tracked.stdout.split('\0').filter(Boolean);
  const hostPattern = /(?:[A-Za-z]:\\Users\\[^\s"'<>]+|\/home\/[^\s"'<>]+|\/Users\/[^\s"'<>]+)/;
  for (const path of new Set([...paths, ...(descriptor.portabilityFiles ?? [])])) {
    let absolute;
    try { absolute = containedFile(repo, path, 'Repository file path'); } catch (error) {
      if ((descriptor.portabilityFiles ?? []).includes(path)) fail(error.message);
      continue;
    }
    const bytes = readFileSync(absolute);
    if (!bytes.includes(0) && hostPattern.test(bytes.toString('utf8'))) fail(`Host-specific absolute path found in ${path}`);
  }
}
const head = repo ? spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() : '';
const branch = repo ? spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim() : '';
if (phase === 'postflight' && options.expectedCommit && options.expectedCommit !== head) fail(`Postflight HEAD mismatch: expected ${options.expectedCommit}, found ${head}`);
if (!['preflight', 'postflight'].includes(phase)) fail('Phase must be preflight or postflight.');
const report = { valid: errors.length === 0, phase, operation: options.operation ?? 'inspect-only', repo: descriptor?.repoId ?? null, branch, commitSha: head, prefix: options.prefix ?? null, checks: { manifestRegistration: manifest ? Boolean(manifest.repositories.find((item) => item.repoId === descriptor?.repoId)) : 'not-applicable', descriptorSchema: errors.length === 0, pathsContained: !errors.some((error) => /escapes|symbolic link/.test(error)), governance: descriptor?.governance?.status ?? 'unavailable', hostPathPortability: !errors.some((error) => error.startsWith('Host-specific')), frozenLockfile: descriptor?.dependencyInstall?.policy ?? 'unavailable', provenance: 'descriptive-only', subtreeMutationExecuted: false }, warnings, errors };
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;

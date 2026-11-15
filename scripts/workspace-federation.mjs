#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSchema, readJson } from './workspace-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(ROOT, 'workspace.manifest.json');
const manifestSchemaPath = resolve(ROOT, 'schemas/workspace-manifest.schema.json');
const descriptorSchemaPath = resolve(ROOT, 'schemas/workspace-repo.schema.json');

function fail(message) { throw new Error(message); }
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
function validateManifest() {
  const manifest = readJson(manifestPath);
  const schema = readJson(manifestSchemaPath);
  assertSchema(manifest, schema, 'workspace.manifest.json');
  const ids = new Set();
  for (const entry of manifest.repositories) {
    if (ids.has(entry.repoId)) fail(`Duplicate repoId: ${entry.repoId}`);
    ids.add(entry.repoId);
    if (entry.capabilityMetadata.authority !== 'descriptive-only' || entry.capabilityMetadata.executionAuthority !== false) {
      fail(`Repository ${entry.repoId} capability metadata must remain descriptive-only`);
    }
    if (entry.path === '.') {
      const descriptor = readJson(resolve(ROOT, entry.descriptor));
      assertSchema(descriptor, readJson(descriptorSchemaPath), `${entry.repoId} descriptor`);
      if (descriptor.repoId !== entry.repoId || descriptor.role !== entry.role) fail(`Descriptor identity mismatch for ${entry.repoId}`);
    }
  }
  return manifest;
}
function validateDescriptor(repoRoot, descriptorFile, schemaFile) {
  const descriptorPath = resolve(repoRoot, descriptorFile);
  const schemaPath = resolve(schemaFile);
  const descriptor = readJson(descriptorPath);
  const schema = readJson(schemaPath);
  assertSchema(descriptor, schema, descriptorFile);
  if (descriptor.capabilityMetadata.authority !== 'descriptive-only' || descriptor.capabilityMetadata.executionAuthority !== false) fail('Descriptor cannot grant execution authority');
  if (descriptor.provenance.authority !== 'descriptive-only') fail('Provenance must be descriptive-only');
  return descriptor;
}
function emitProvenance(descriptor, repoRoot) {
  const { execFileSync } = awaitImportChildProcess();
  let commitSha = 'unavailable';
  try { commitSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  return {
    repo: descriptor.repoId,
    commitSha,
    contractVersion: descriptor.contractVersion,
    supportedModels: [...descriptor.capabilityMetadata.supportedModels],
    authority: 'descriptive-only',
    executionAuthority: false
  };
}
function awaitImportChildProcess() {
  return { execFileSync: requireExecFileSync };
}
import { execFileSync as requireExecFileSync } from 'node:child_process';

const [command = 'validate', ...args] = process.argv.slice(2);
try {
  if (command === 'validate') {
    const manifest = validateManifest();
    const result = [];
    for (const entry of manifest.repositories) {
      const workspaceBoundary = resolve(ROOT, '..');
      const repoRoot = resolve(ROOT, entry.path);
      if (!inside(workspaceBoundary, repoRoot)) fail(`Repository path escapes workspace boundary: ${entry.repoId}`);
      if (!inside(workspaceBoundary, realpathSync(repoRoot))) fail(`Repository real path escapes workspace boundary: ${entry.repoId}`);
      const descriptor = validateDescriptor(repoRoot, entry.descriptor, resolve(ROOT, 'schemas/workspace-repo.schema.json'));
      result.push(emitProvenance(descriptor, repoRoot));
    }
    console.log(JSON.stringify({ valid: true, manifestVersion: manifest.manifestVersion, contractVersion: manifest.contractVersion, repositories: result }, null, 2));
  } else if (command === 'descriptor') {
    const repoRoot = resolve(args[0] ?? ROOT);
    const descriptorFile = args[1] ?? 'workspace-repo.json';
    const schemaFile = args[2] ?? resolve(ROOT, 'schemas/workspace-repo.schema.json');
    const descriptor = validateDescriptor(repoRoot, descriptorFile, schemaFile);
    console.log(JSON.stringify({ valid: true, repo: descriptor.repoId, contractVersion: descriptor.contractVersion, authority: 'descriptive-only' }, null, 2));
  } else if (command === 'provenance') {
    const repoRoot = resolve(args[0] ?? ROOT);
    const descriptor = validateDescriptor(repoRoot, args[1] ?? 'workspace-repo.json', args[2] ?? resolve(ROOT, 'schemas/workspace-repo.schema.json'));
    console.log(JSON.stringify(emitProvenance(descriptor, repoRoot), null, 2));
  } else {
    fail('Usage: node scripts/workspace-federation.mjs [validate|descriptor <repo> [descriptor] [schema]|provenance <repo> [descriptor] [schema]]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

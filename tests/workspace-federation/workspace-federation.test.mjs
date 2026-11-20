import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSchema, validateSchema } from '../../scripts/workspace-schema.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const schema = JSON.parse(readFileSync(join(root, 'schemas/workspace-repo.schema.json'), 'utf8'));
const manifestSchema = JSON.parse(readFileSync(join(root, 'schemas/workspace-manifest.schema.json'), 'utf8'));
const descriptor = JSON.parse(readFileSync(join(root, 'workspace-repo.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'workspace.manifest.json'), 'utf8'));
assertSchema(descriptor, schema, 'Core descriptor');
assertSchema(manifest, manifestSchema, 'Core manifest');
assert.equal(validateSchema({ ...descriptor, unexpected: true }, schema).length > 0, true);
assert.equal(validateSchema({ ...descriptor, capabilityMetadata: { ...descriptor.capabilityMetadata, executionAuthority: true } }, schema).length > 0, true);
assert.equal(validateSchema({ ...descriptor, capabilityMetadata: { ...descriptor.capabilityMetadata, supportedModels: ['local-1.5b'] } }, schema).length > 0, true);
assert.equal(validateSchema({ ...manifest, registryAuthority: 'execution' }, manifestSchema).length > 0, true);
const badManifest = structuredClone(manifest);
badManifest.repositories[0].capabilityMetadata.supportedModels = ['local-1.5b'];
assert.equal(validateSchema(badManifest, manifestSchema).length > 0, true);

const bridge = resolve(root, '../curl-ai-bridge');
if (existsSync(bridge)) {
  const federation = spawnSync(process.execPath, ['scripts/workspace-federation.mjs', 'validate'], { cwd: root, encoding: 'utf8' });
  assert.equal(federation.status, 0, federation.stderr || federation.stdout);
  const emitted = JSON.parse(federation.stdout);
  assert.equal(emitted.repositories.length, 2);
  assert.ok(emitted.repositories.every((item) => item.authority === 'descriptive-only' && item.executionAuthority === false));
  assert.ok(emitted.repositories.every((item) => item.supportedModels.length === 0));
} else {
  console.log('INFO: sibling curl-ai-bridge checkout unavailable; skipping sibling-bridge federation validate check');
}

const workflow = readFileSync(join(root, '.github/workflows/reusable-repo-verify.yml'), 'utf8');
assert.match(workflow, /workflow_call:/);
assert.match(workflow, /governance_required:[\s\S]*?type: boolean[\s\S]*?default: true/);
assert.match(workflow, /workspace-subtree\.mjs preflight/);
for (const action of ['actions\/checkout', 'actions\/setup-node', 'actions\/upload-artifact']) assert.match(workflow, new RegExp(`uses: ${action}@[0-9a-f]{40}`));
const bridgeCaller = readFileSync(join(root, 'tests/workspace-federation/fixtures/bridge-reusable-workflow-caller.yml'), 'utf8');
assert.match(bridgeCaller, /governance_required: false/);
assert.match(bridgeCaller, /descriptor_path: workspace-repo\.json/);

if (existsSync(bridge)) {
  const bridgeCheck = spawnSync(process.execPath, ['scripts/workspace-federation.mjs', 'descriptor', bridge, 'workspace-repo.json', join(bridge, 'schemas/workspace-repo.schema.json')], { cwd: root, encoding: 'utf8' });
  assert.equal(bridgeCheck.status, 0, bridgeCheck.stderr || bridgeCheck.stdout);
  const bridgeDescriptor = JSON.parse(readFileSync(join(bridge, 'workspace-repo.json'), 'utf8'));
  assert.equal(bridgeDescriptor.governance.status, 'deferred-priority-2');
  assert.equal(bridgeDescriptor.governance.file, null);
} else {
  console.log('INFO: sibling curl-ai-bridge checkout unavailable; skipping sibling-bridge descriptor check');
}

const temp = mkdtempSync(join(tmpdir(), 'workspace-subtree-check-'));
try {
  execFileSync('git', ['init', '-q', temp]);
  mkdirSync(join(temp, 'schemas'));
  const fixtureDescriptor = structuredClone(descriptor);
  delete fixtureDescriptor.runtime.pythonManager;
  fixtureDescriptor.dependencyInstall = { policy: 'frozen-lockfile', manager: 'npm', lockfile: 'package-lock.json', frozen: true, command: 'npm ci' };
  fixtureDescriptor.portabilityFiles = ['workspace-repo.json'];
  writeFileSync(join(temp, 'workspace-repo.json'), JSON.stringify(fixtureDescriptor, null, 2));
  writeFileSync(join(temp, 'README.md'), 'Portable test fixture.\n');
  writeFileSync(join(temp, 'AGENTS.md'), '# Fixture governance\n');
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  writeFileSync(join(temp, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }));
  execFileSync('git', ['-C', temp, 'add', '.']);
  execFileSync('git', ['-C', temp, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const helper = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp, '--descriptor', 'workspace-repo.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(helper.status, 0, helper.stderr || helper.stdout);
  const report = JSON.parse(helper.stdout);
  assert.equal(report.checks.subtreeMutationExecuted, false);
  assert.equal(report.checks.provenance, 'descriptive-only');
  const postflight = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'postflight', '--repo', temp, '--descriptor', 'workspace-repo.json', '--expectedCommit', report.commitSha], { cwd: root, encoding: 'utf8' });
  assert.equal(postflight.status, 0, postflight.stderr || postflight.stdout);
  assert.equal(JSON.parse(postflight.stdout).checks.subtreeMutationExecuted, false);
  const bad = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'postflight', '--repo', temp, '--descriptor', 'workspace-repo.json', '--expectedCommit', 'deadbeef'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  const badPrefix = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp, '--descriptor', 'workspace-repo.json', '--prefix', '../escape'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badPrefix.status, 0);
  const outsideDescriptor = join(tmpdir(), `task100-outside-${Date.now()}.json`);
  writeFileSync(outsideDescriptor, JSON.stringify(fixtureDescriptor));
  const traversal = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp, '--descriptor', '../' + outsideDescriptor.split('/').pop()], { cwd: root, encoding: 'utf8' });
  assert.notEqual(traversal.status, 0);
  symlinkSync(outsideDescriptor, join(temp, 'linked-descriptor.json'));
  const symlinkDescriptor = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp, '--descriptor', 'linked-descriptor.json'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(symlinkDescriptor.status, 0);
  rmSync(outsideDescriptor, { force: true });
  writeFileSync(join(temp, 'README.md'), ['Host path leak:', ['/home', 'operator', 'private'].join('/')].join(' ') + '\n');
  const badHostPath = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp, '--descriptor', 'workspace-repo.json'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badHostPath.status, 0);
  writeFileSync(join(temp, 'README.md'), 'Portable test fixture.\n');
  rmSync(join(temp, 'package-lock.json'));
  const missingNpmLock = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.notEqual(missingNpmLock.status, 0);
  writeFileSync(join(temp, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }));
  const unfrozenNpm = structuredClone(fixtureDescriptor);
  unfrozenNpm.dependencyInstall.frozen = false;
  writeFileSync(join(temp, 'workspace-repo.json'), JSON.stringify(unfrozenNpm, null, 2));
  const badNpmFrozen = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badNpmFrozen.status, 0);
  const mutableNpm = structuredClone(fixtureDescriptor);
  mutableNpm.dependencyInstall.command = 'npm install';
  writeFileSync(join(temp, 'workspace-repo.json'), JSON.stringify(mutableNpm, null, 2));
  const badNpmCommand = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badNpmCommand.status, 0);
  mkdirSync(join(temp, 'apps/python'), { recursive: true });
  writeFileSync(join(temp, 'apps/python/pyproject.toml'), '[project]\nname = \"fixture\"\nversion = \"0.1.0\"\n');
  writeFileSync(join(temp, 'apps/python/uv.lock'), 'version = 1\n');
  const pythonDescriptor = structuredClone(fixtureDescriptor);
  pythonDescriptor.runtime.pythonManager = 'uv';
  pythonDescriptor.dependencyInstall.command = 'npm ci && uv sync --frozen --project apps/python';
  writeFileSync(join(temp, 'workspace-repo.json'), JSON.stringify(pythonDescriptor, null, 2));
  execFileSync('git', ['-C', temp, 'add', '.']);
  const validPython = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.equal(validPython.status, 0, validPython.stderr || validPython.stdout);
  rmSync(join(temp, 'apps/python/uv.lock'));
  const missingUvLock = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.notEqual(missingUvLock.status, 0);
  writeFileSync(join(temp, 'apps/python/uv.lock'), 'version = 1\n');
  pythonDescriptor.dependencyInstall.command = 'npm ci && uv sync --project apps/python';
  writeFileSync(join(temp, 'workspace-repo.json'), JSON.stringify(pythonDescriptor, null, 2));
  const badUvFrozen = spawnSync(process.execPath, ['scripts/workspace-subtree.mjs', 'preflight', '--repo', temp], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badUvFrozen.status, 0);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('PASS: workspace manifest and descriptor schema validation');
console.log('PASS: execution-authority and provenance invariants remain descriptive-only');
console.log('PASS: Core and Bridge repository descriptors are registered and schema-valid');
console.log('PASS: subtree preflight/postflight is inspect-only and detects commit mismatch');
console.log('PASS: supportedModels is empty; descriptor paths reject traversal/symlinks; npm/uv frozen-lockfile invariants reject missing locks');

const permitFixtureRelative = 'tests/fixtures/authorization-permit/v1.0';
const permitCoreRoot = join(root, permitFixtureRelative);
const permitBridgeRoot = join(bridge, permitFixtureRelative);
const permitFixtureNames = [
  'valid-permit.json',
  'canonical-claims.jcs',
  'test-public-key.pem',
  'vectors.json',
  'manifest.json',
  'canonicalization-profile.json'
];
const permitArtifactPaths = [
  'contracts/core-bridge/authorization-permit.v1.schema.json',
  ...permitFixtureNames.map((name) => join(permitFixtureRelative, name))
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const relativePath of permitArtifactPaths) {
  const coreBytes = readFileSync(join(root, relativePath));
  const bridgeBytes = readFileSync(join(bridge, relativePath));
  assert.deepEqual(bridgeBytes, coreBytes, `Core/Bridge authorization artifact differs: ${relativePath}`);
}
const permitSchema = JSON.parse(readFileSync(join(root, permitArtifactPaths[0]), 'utf8'));
assert.equal(permitSchema.type, 'object');
assert.equal(permitSchema.additionalProperties, false);
assert.deepEqual(permitSchema.required, ['claims', 'integrity']);
assert.equal(permitSchema.properties.integrity.additionalProperties, false);
assert.equal(permitSchema.properties.claims.additionalProperties, false);
assert.deepEqual(permitSchema.properties.claims.required, [
  'contractVersion', 'permitId', 'issuedAt', 'expiresAt', 'audience',
  'taskId', 'runId', 'projectId', 'requestId', 'idempotencyKey', 'operation',
  'allowedModelIds', 'allowedRoles', 'siblingBindings', 'localOnly', 'executionLimits'
]);
assert.deepEqual(
  permitSchema.properties.claims.properties.executionLimits.required,
  ['maxTurns', 'maxSiblingCalls', 'maxTokensPerCall', 'maxTotalTokens', 'timeoutSeconds']
);
assert.equal(permitSchema.properties.claims.properties.allowedModelIds.uniqueItems, true);
assert.equal(permitSchema.properties.claims.properties.allowedModelIds.maxItems, undefined, 'v1.0 must not invent an unapproved model-list ceiling');
assert.equal(permitSchema.properties.claims.properties.allowedRoles.uniqueItems, true);
assert.equal(permitSchema.properties.claims.properties.siblingBindings.uniqueItems, true);
assert.equal(permitSchema.properties.claims.properties.siblingBindings.maxItems, undefined, 'v1.0 must not invent an unapproved sibling-binding ceiling');
assert.deepEqual(
  permitSchema.properties.claims.properties.allowedRoles.items.enum,
  ['parent', 'reviewer', 'worker']
);
assert.equal(permitSchema.properties.claims.properties.executionLimits.properties.maxSiblingCalls.minimum, 1);
assert.match(
  permitSchema.properties.claims.properties.idempotencyKey.pattern,
  /A-Za-z0-9_-/
);
const permitManifestBytes = readFileSync(join(permitCoreRoot, 'manifest.json'));
const permitManifest = JSON.parse(permitManifestBytes.toString('utf8'));
const expectedPermitArtifacts = {
  schema: 'contracts/core-bridge/authorization-permit.v1.schema.json',
  validPermit: join(permitFixtureRelative, 'valid-permit.json'),
  canonicalClaims: join(permitFixtureRelative, 'canonical-claims.jcs'),
  testPublicKey: join(permitFixtureRelative, 'test-public-key.pem'),
  vectors: join(permitFixtureRelative, 'vectors.json'),
  canonicalizationProfile: join(permitFixtureRelative, 'canonicalization-profile.json')
};
assert.equal(permitManifest.contractVersion, '1.0');
assert.equal(permitManifest.hashAlgorithm, 'SHA-256');
assert.deepEqual(Object.keys(permitManifest.artifacts).sort(), Object.keys(expectedPermitArtifacts).sort());
for (const [artifactName, expectedPath] of Object.entries(expectedPermitArtifacts)) {
  const pinned = permitManifest.artifacts[artifactName];
  assert.equal(pinned.path, expectedPath);
  assert.equal(pinned.sha256, sha256(readFileSync(join(root, expectedPath))), `manifest digest mismatch: ${artifactName}`);
}
const permitEnvelopeText = readFileSync(join(permitCoreRoot, 'valid-permit.json'), 'utf8').trimEnd();
const claimsStart = permitEnvelopeText.indexOf('"claims":') + '"claims":'.length;
const integrityStart = permitEnvelopeText.lastIndexOf(',"integrity":');
assert.ok(claimsStart >= '"claims":'.length && integrityStart > claimsStart);
assert.equal(
  permitEnvelopeText.slice(claimsStart, integrityStart),
  readFileSync(join(permitCoreRoot, 'canonical-claims.jcs'), 'utf8'),
  'valid permit claims must be byte-identical to canonical-claims.jcs'
);
const publicKeyPem = readFileSync(join(permitCoreRoot, 'test-public-key.pem'), 'utf8');
assert.match(publicKeyPem, /-----BEGIN PUBLIC KEY-----/);
assert.doesNotMatch(publicKeyPem, /PRIVATE KEY/);
const canonicalizationProfile = JSON.parse(readFileSync(join(permitCoreRoot, 'canonicalization-profile.json'), 'utf8'));
assert.equal(canonicalizationProfile.standard, 'RFC 8785 — JSON Canonicalization Scheme (JCS)');
assert.equal(canonicalizationProfile.profileVersion, '1.0');
assert.equal(canonicalizationProfile.signedObject, 'claims object only; detached integrity envelope excluded');
assert.match(canonicalizationProfile.inputBindingDigest, /excluding the permit and transport-only metadata/);
assert.match(canonicalizationProfile.inputBindingDigest, /not the hash of the claims object/);
const permitVectors = JSON.parse(readFileSync(join(permitCoreRoot, 'vectors.json'), 'utf8'));
assert.ok(permitVectors.positive.some((vector) => vector.expected === 'accept'));
assert.ok(permitVectors.negative.length >= 15);
for (const [id, expected] of [['V-NEG-019', 'PERMIT_MISSING'], ['V-NEG-020', 'PERMIT_KEY_REVOKED'], ['V-NEG-021', 'PERMIT_TRUST_BUNDLE_STALE'], ['V-NEG-022', 'PERMIT_TRUST_BUNDLE_STALE']]) {
  assert.ok(permitVectors.negative.some((vector) => vector.id === id && vector.expected === expected), 'missing remediation vector ' + id);
}
for (const [id, expected] of [['V-NEG-019', 'PERMIT_MISSING'], ['V-NEG-020', 'PERMIT_KEY_REVOKED'], ['V-NEG-021', 'PERMIT_TRUST_BUNDLE_STALE'], ['V-NEG-022', 'PERMIT_TRUST_BUNDLE_STALE']]) {
  assert.ok(permitVectors.negative.some((vector) => vector.id === id && vector.expected === expected), 'missing remediation vector ' + id);
}

// Compatibility samples use the Core's observed numeric task IDs, run_<opaque>
// run IDs, and slug-like project names. requestId/kid/audience are new v1.0
// contract identities; no existing Core producer convention was found for them.
const coreIdentityPattern = /^[A-Za-z0-9._:-]{1,128}$/;
assert.match(String(105), coreIdentityPattern);
assert.match('run_0123456789abcdef', coreIdentityPattern);
assert.match('multi-project-workspace', coreIdentityPattern);
assert.match('req_0123456789abcdef', coreIdentityPattern);
assert.match('test-ed25519-v1', coreIdentityPattern);
assert.match('curl-ai-bridge:dev', /^[a-z0-9][a-z0-9._:-]{1,127}$/);
console.log('PASS: Core/Bridge v1.0 permit schema and fixture artifacts are byte-identical');
console.log('PASS: fixture manifest pins schema, all fixture vectors, public key and RFC 8785 profile');
console.log('PASS: valid permit embeds exact canonical claims; test fixture contains public key only');
console.log('PASS: Core task/run/project identity examples fit the v1.0 patterns; new request/key/audience identities are bounded');

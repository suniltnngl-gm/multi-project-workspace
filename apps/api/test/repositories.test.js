import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/database.js'

let directory
let alphaRoot
let betaRoot
let gammaRoot
let database
let server
let baseUrl

const alphaHeader = [
  '# Objective: Alpha shared note.',
  '# Requirements: Stay in the alpha repository.',
  ''
].join('\n')
const betaHeader = [
  '# Objective: Beta shared note.',
  '# Requirements: Stay in the beta repository.',
  ''
].join('\n')

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-repositories-'))
  alphaRoot = join(directory, 'alpha')
  betaRoot = join(directory, 'beta')
  gammaRoot = join(directory, 'gamma')
  for (const root of [alphaRoot, betaRoot, gammaRoot]) {
    await mkdir(join(root, 'docs'), { recursive: true })
  }
  await writeFile(join(alphaRoot, 'docs', 'shared.md'), alphaHeader)
  await writeFile(join(betaRoot, 'docs', 'shared.md'), betaHeader)
  await writeFile(join(gammaRoot, 'README.md'), '# Objective: Gamma note.\n')

  database = createDatabase(join(directory, 'repositories.sqlite'), { rootDir: alphaRoot })
  server = createApp(database).listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('the rootDir option registers the primary repository as id 1', () => {
  const primary = database.getRepository(1)
  assert.ok(primary, 'repository id 1 exists')
  assert.equal(primary.name, 'alpha')
  assert.equal(primary.rootPath, alphaRoot)

  const listed = database.listRepositories()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].fileCount, 0)
  assert.equal(listed[0].folderCount, 0)
  assert.equal(listed[0].worktreeCount, 0)
})

test('ensureRepository is idempotent and suffixes colliding names', () => {
  const again = database.ensureRepository(alphaRoot)
  assert.equal(again.created, false)
  assert.equal(again.repository.id, 1)

  const beta = database.ensureRepository(betaRoot)
  assert.equal(beta.created, true)
  assert.equal(beta.repository.name, 'beta')
  assert.equal(beta.repository.id, 2)

  // A third root with the same basename as a registered repository takes a
  // numeric suffix instead of failing.
  const betaAgain = join(directory, 'nested', 'beta')
  const suffixed = database.ensureRepository(betaAgain)
  assert.equal(suffixed.created, true)
  assert.equal(suffixed.repository.name, 'beta-2')

  // An explicitly requested name that is already taken still throws, so
  // callers validate user-provided names before reaching here.
  assert.throws(() => database.ensureRepository(gammaRoot, { name: 'beta' }))
})

test('repository routes list, show, and validate registrations', async () => {
  const listResponse = await fetch(`${baseUrl}/api/repositories`)
  assert.equal(listResponse.status, 200)
  const repositories = await listResponse.json()
  assert.ok(repositories.some((repository) => repository.name === 'alpha'))
  assert.ok(repositories.some((repository) => repository.name === 'beta-2'))

  const showResponse = await fetch(`${baseUrl}/api/repositories/1`)
  assert.equal(showResponse.status, 200)
  assert.equal((await showResponse.json()).name, 'alpha')

  assert.equal((await fetch(`${baseUrl}/api/repositories/999`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/api/repositories/nope`)).status, 400)

  // Later 409 checks need an existing directory that is not yet registered
  // and does not overlap any registered root.
  await mkdir(join(directory, 'other'), { recursive: true })

  const createResponse = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: gammaRoot, name: 'gamma' })
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.equal(created.name, 'gamma')
  assert.equal(created.rootPath, gammaRoot)

  // Duplicate roots, taken names, and overlapping roots are rejected.
  const duplicateRoot = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: gammaRoot })
  })
  assert.equal(duplicateRoot.status, 409)

  const duplicateName = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: join(directory, 'other'), name: 'gamma' })
  })
  assert.equal(duplicateName.status, 409)

  await mkdir(join(gammaRoot, 'nested'), { recursive: true })
  const nested = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: join(gammaRoot, 'nested') })
  })
  assert.equal(nested.status, 409)

  const containing = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: directory })
  })
  assert.equal(containing.status, 409)

  const missing = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: join(directory, 'does-not-exist') })
  })
  assert.equal(missing.status, 400)

  const blank = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'no-root' })
  })
  assert.equal(blank.status, 400)

  const badName = await fetch(`${baseUrl}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: join(directory, 'other'), name: '  ' })
  })
  assert.equal(badName.status, 400)
})

test('scans accept a root and track the same relative path per repository', async () => {
  const alphaScan = await fetch(`${baseUrl}/api/files/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: alphaRoot })
  })
  assert.equal(alphaScan.status, 200)
  const alphaResult = await alphaScan.json()
  assert.equal(alphaResult.repositoryId, 1)
  assert.ok(alphaResult.paths.includes('docs/shared.md'))

  const betaScan = await fetch(`${baseUrl}/api/files/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: betaRoot })
  })
  assert.equal(betaScan.status, 200)
  const betaResult = await betaScan.json()
  assert.equal(betaResult.repositoryId, database.getRepositoryByName('beta').id)
  assert.ok(betaResult.paths.includes('docs/shared.md'))

  const files = await (await fetch(`${baseUrl}/api/files`)).json()
  const shared = files.filter((file) => file.path === 'docs/shared.md')
  assert.equal(shared.length, 2)
  const alphaRow = shared.find((file) => file.repository === 'alpha')
  const betaRow = shared.find((file) => file.repository === 'beta')
  assert.ok(alphaRow, 'the alpha row exists')
  assert.ok(betaRow, 'the beta row exists')
  assert.notEqual(alphaRow.id, betaRow.id)
  assert.equal(alphaRow.objective, 'Alpha shared note.')
  assert.equal(betaRow.objective, 'Beta shared note.')

  // Folder scans accept the same root scoping.
  const folderScan = await fetch(`${baseUrl}/api/folders/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: betaRoot })
  })
  assert.equal(folderScan.status, 200)
  const betaFolders = await folderScan.json()
  assert.ok(betaFolders.paths.includes('docs'))

  // A root that is not a directory is rejected rather than registered.
  const missingRoot = await fetch(`${baseUrl}/api/files/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: join(directory, 'nope') })
  })
  assert.equal(missingRoot.status, 400)
})

test('repository filters scope file and folder listings', async () => {
  const betaFiles = await (await fetch(`${baseUrl}/api/files?repository=beta`)).json()
  assert.ok(betaFiles.length > 0)
  assert.ok(betaFiles.every((file) => file.repository === 'beta'))
  assert.ok(betaFiles.some((file) => file.path === 'docs/shared.md'))

  const alphaFiles = await (await fetch(`${baseUrl}/api/files?repository=alpha`)).json()
  assert.ok(alphaFiles.every((file) => file.repository === 'alpha'))

  const betaFolders = await (await fetch(`${baseUrl}/api/folders?repository=beta`)).json()
  assert.ok(betaFolders.some((folder) => folder.path === 'docs'))
  assert.ok(betaFolders.every((folder) => folder.repositoryId === database.getRepositoryByName('beta').id))

  assert.equal(
    (await fetch(`${baseUrl}/api/files?repository=unknown`)).status, 404
  )
  assert.equal(
    (await fetch(`${baseUrl}/api/folders?repository=unknown`)).status, 404
  )
})

test('file and folder creation is scoped by repository', async () => {
  // The same path may exist in another repository; only the primary copy
  // conflicts when no repository is requested.
  const duplicatePrimary = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/shared.md', objective: 'Duplicate' })
  })
  assert.equal(duplicatePrimary.status, 409)

  const inBeta = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'docs/created.md',
      objective: 'Created in beta',
      repository: 'beta'
    })
  })
  assert.equal(inBeta.status, 201)
  const createdFile = await inBeta.json()
  assert.equal(createdFile.repository, 'beta')
  assert.equal(createdFile.repositoryId, database.getRepositoryByName('beta').id)

  const inUnknown = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/other.md', repository: 'unknown' })
  })
  assert.equal(inUnknown.status, 404)

  // The repository scope is create-only, like source_job_id on tasks.
  const patchRepository = await fetch(`${baseUrl}/api/files/${createdFile.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository: 'alpha' })
  })
  assert.equal(patchRepository.status, 400)

  const folderInGamma = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/from-test', objective: 'Gamma folder', repository: 'gamma' })
  })
  assert.equal(folderInGamma.status, 201)
  assert.equal((await folderInGamma.json()).repository, 'gamma')

  const folderUnknown = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'docs/other', repository: 'unknown' })
  })
  assert.equal(folderUnknown.status, 404)

  const deleteFile = await fetch(`${baseUrl}/api/files/${createdFile.id}`, { method: 'DELETE' })
  assert.equal(deleteFile.status, 204)
})

test('worktree scans associate rows with their repository', () => {
  const result = database.scanGitWorktrees([
    {
      repositoryRoot: alphaRoot,
      worktreePath: join(directory, 'alpha-wt'),
      branch: 'feature/alpha',
      headCommit: 'abc123',
      remoteUrl: ''
    },
    {
      repositoryRoot: gammaRoot,
      worktreePath: join(directory, 'gamma-wt'),
      branch: 'main',
      headCommit: 'def456',
      remoteUrl: 'https://example.com/gamma.git'
    }
  ])
  assert.equal(result.total, 2)

  const worktrees = database.listGitWorktrees()
  const alphaWorktree = worktrees.find((worktree) => worktree.worktreePath.endsWith('alpha-wt'))
  const gammaWorktree = worktrees.find((worktree) => worktree.worktreePath.endsWith('gamma-wt'))
  assert.equal(alphaWorktree.repositoryId, 1)
  assert.equal(alphaWorktree.repository, 'alpha')
  assert.equal(gammaWorktree.repository, 'gamma')

  // Counts reflect the associations.
  const repositories = database.listRepositories()
  assert.equal(repositories.find((repository) => repository.name === 'alpha').worktreeCount, 1)
  assert.equal(repositories.find((repository) => repository.name === 'gamma').worktreeCount, 1)
})

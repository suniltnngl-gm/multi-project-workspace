import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,mkdirSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { createProjectWriterLeasesStore } from '../src/db/projectWriterLeases.js'
import schema from '../../../schemas/project-writer-lease.schema.json' with {type:'json'}
function dbFixture(){const dir=mkdtempSync(join(tmpdir(),'lease-test-')),db=new Database(join(dir,'db.sqlite'));db.exec("CREATE TABLE repositories(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT); INSERT INTO repositories VALUES(1,'multi-project-workspace','/workspace'); INSERT INTO repositories VALUES(4,'curl-ai-bridge','/bridge'); CREATE TABLE project_writer_lease_state(project_id TEXT PRIMARY KEY,fencing_generation INTEGER,current_lease_id TEXT,updated_at TEXT); CREATE TABLE project_writer_leases(lease_id TEXT PRIMARY KEY,project_id TEXT,task_id INTEGER,run_id TEXT,worker_id TEXT,owner_id TEXT,repositories_json TEXT,allowlist_json TEXT,allowlist_sha256 TEXT,binding_sha256 TEXT,authorization_ref TEXT,fencing_generation INTEGER,acquired_at TEXT,heartbeat_at TEXT,expires_at TEXT,status TEXT,idempotency_key TEXT UNIQUE); CREATE TABLE project_writer_lease_events(event_id TEXT PRIMARY KEY,project_id TEXT,lease_id TEXT,fencing_generation INTEGER,event_type TEXT,idempotency_key TEXT UNIQUE,occurred_at TEXT,details_json TEXT)");return {dir,db}}
test('schema is strict Draft 2020-12 with monotonic fencing field',()=>{assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.fencing_generation.minimum,1)})
test('acquire, conflict, renew, release, expiry reclaim and monotonic generations',()=>{const {dir,db}=dbFixture();let now=10000;const s=createProjectWriterLeasesStore(db,{clock:()=>now});const input={projectId:'curl-ai-bridge',taskId:144,runId:'run',workerId:'worker-a',authorizationRef:'task:144',ttlMs:1000,repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:'/workspace',branch:'master',headCommit:'a'.repeat(40)},{repositoryId:4,name:'curl-ai-bridge',rootPath:'/bridge',branch:'main',headCommit:'b'.repeat(40)}],allowlist:{files:[],mutations:['tasks','task_events']},idempotencyKey:'one'};const a=s.acquire(input);assert.equal(a.fencingGeneration,1);assert.throws(()=>s.acquire({...input,workerId:'b',idempotencyKey:'two'}),/writer_lease_conflict/);assert.equal(s.assertCurrentWriterLease(a.leaseId,1,[],{mutation:'tasks'}).leaseId,a.leaseId);s.renew(a.leaseId,1,'worker-a',1000);s.release(a.leaseId,1,'worker-a');assert.equal(s.release(a.leaseId,1,'worker-a').status,'revoked');const b=s.acquire({...input,idempotencyKey:'two',workerId:'b'});assert.equal(b.fencingGeneration,2);now=Date.parse(b.expiresAt)+1;assert.equal(s.reclaimExpired('curl-ai-bridge').length,1);assert.equal(s.reclaimExpired('curl-ai-bridge').length,0);assert.equal(s.acquire({...input,idempotencyKey:'three',workerId:'c'}).fencingGeneration,3);db.close();rmSync(dir,{recursive:true,force:true})})

test('lease scope and allowlist tampering fail closed at assertion time',()=>{
 const {dir,db}=dbFixture(),store=createProjectWriterLeasesStore(db)
 const lease=store.acquire({taskId:144,runId:'tamper',workerId:'worker',authorizationRef:'test:tamper',repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:'/workspace',branch:'master',headCommit:'a'.repeat(40)},{repositoryId:4,name:'curl-ai-bridge',rootPath:'/bridge',branch:'main',headCommit:'b'.repeat(40)}],allowlist:{files:[{repositoryId:1,path:'one.txt',operations:['CREATE']}],mutations:['tasks','task_events']},idempotencyKey:'tamper'})
 db.prepare('UPDATE project_writer_leases SET allowlist_json=? WHERE lease_id=?').run(JSON.stringify({files:[{repositoryId:1,path:'two.txt',operations:['CREATE']}],mutations:['tasks','task_events']}),lease.leaseId)
 assert.throws(()=>store.assertCurrentWriterLease(lease.leaseId,1),/writer_lease_binding_tampered/)
 db.close();rmSync(dir,{recursive:true,force:true})
})

test('worktree pins are validated at acquisition time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-wt-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'lease-test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Lease Test'])
  writeFileSync(join(repo, 'f.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', 'f.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'fixture'])
  const branch = execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const wt = join(dir, 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt])
  const wtBranch = execFileSync('git', ['-C', wt, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
  const wtHead = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const sql = "CREATE TABLE repositories(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT); INSERT INTO repositories VALUES(1,'multi-project-workspace','" + repo.replace(/'/g, "''") + "'); INSERT INTO repositories VALUES(4,'curl-ai-bridge','/bridge'); CREATE TABLE project_writer_lease_state(project_id TEXT PRIMARY KEY,fencing_generation INTEGER,current_lease_id TEXT,updated_at TEXT); CREATE TABLE project_writer_leases(lease_id TEXT PRIMARY KEY,project_id TEXT,task_id INTEGER,run_id TEXT,worker_id TEXT,owner_id TEXT,repositories_json TEXT,allowlist_json TEXT,allowlist_sha256 TEXT,binding_sha256 TEXT,authorization_ref TEXT,fencing_generation INTEGER,acquired_at TEXT,heartbeat_at TEXT,expires_at TEXT,status TEXT,idempotency_key TEXT UNIQUE); CREATE TABLE project_writer_lease_events(event_id TEXT PRIMARY KEY,project_id TEXT,lease_id TEXT,fencing_generation INTEGER,event_type TEXT,idempotency_key TEXT UNIQUE,occurred_at TEXT,details_json TEXT); CREATE TABLE git_worktrees(id INTEGER PRIMARY KEY,repository_id INTEGER,repository_root TEXT,worktree_path TEXT UNIQUE,branch TEXT,head_commit TEXT,remote_url TEXT,created_at TEXT,updated_at TEXT)"
  const make = () => { const db = new Database(join(dir, 'db-' + Math.random().toString(36).slice(2) + '.sqlite')); db.exec(sql); return db }
  const register = (db) => db.prepare('INSERT INTO git_worktrees(repository_id,repository_root,worktree_path,branch,head_commit,remote_url,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)').run(repo, wt, wtBranch, wtHead, '', 'x', 'x')
  const pin = (extra = {}) => ({ repositoryId: 1, name: 'multi-project-workspace', rootPath: repo, branch, headCommit: head, worktreePath: wt, worktreeBranch: wtBranch, worktreeHead: wtHead, ...extra })
  const base = (repositories) => ({ projectId: 'curl-ai-bridge', taskId: 152, runId: 'fence001', workerId: 'w', authorizationRef: 'test:fence001', repositories, allowlist: { files: [], mutations: ['tasks', 'task_events'] }, idempotencyKey: 'k' + Math.random().toString(36).slice(2) })
  const repos = (first) => [first, { repositoryId: 4, name: 'curl-ai-bridge', rootPath: '/bridge', branch: 'main', headCommit: 'b'.repeat(40) }]
  let db = make(); register(db); assert.equal(createProjectWriterLeasesStore(db).acquire(base(repos(pin()))).fencingGeneration, 1); db.close()
  db = make(); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin()))), /writer_worktree_not_registered/); db.close()
  db = make(); register(db); db.prepare('UPDATE git_worktrees SET head_commit=?').run('c'.repeat(40)); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin()))), /writer_worktree_registration_stale/); db.close()
  db = make(); db.prepare('INSERT INTO git_worktrees(repository_id,repository_root,worktree_path,branch,head_commit,remote_url,created_at,updated_at) VALUES(4,?,?,?,?,?,?,?)').run(repo, wt, wtBranch, wtHead, '', 'x', 'x'); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin()))), /writer_worktree_repository_mismatch/); db.close()
  db = make(); const notWt = join(dir, 'notwt'); mkdirSync(notWt); db.prepare('INSERT INTO git_worktrees(repository_id,repository_root,worktree_path,branch,head_commit,remote_url,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)').run(repo, notWt, wtBranch, wtHead, '', 'x', 'x'); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin({ worktreePath: notWt })))), /writer_worktree_not_a_worktree/); db.close()
  db = make(); db.prepare('INSERT INTO git_worktrees(repository_id,repository_root,worktree_path,branch,head_commit,remote_url,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)').run(repo, repo, branch, head, '', 'x', 'x'); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin({ worktreePath: repo, worktreeBranch: branch, worktreeHead: head })))), /writer_worktree_alias_rejected/); db.close()
  db = make(); register(db); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin({ worktreeBranch: 'other' })))), /writer_worktree_branch_changed/); db.close()
  db = make(); register(db); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin({ worktreeHead: 'd'.repeat(40) })))), /writer_worktree_head_changed/); db.close()
  db = make(); register(db); assert.throws(() => createProjectWriterLeasesStore(db).acquire(base(repos(pin({ headCommit: 'e'.repeat(40) })))), /writer_lease_repository_anchor_changed/); db.close()
  rmSync(dir, { recursive: true, force: true })
})

import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import Database from 'better-sqlite3'
import {createProjectWriterLeaseGuard,TASK142_RESERVED_PATHS} from '../src/projectWriterLease.js'
test('rejects traversal, symlink escape and Task 142 reserved paths',()=>{const d=mkdtempSync(join(tmpdir(),'guard-')),r=join(d,'repo'),o=join(d,'outside');mkdirSync(r);mkdirSync(o);writeFileSync(join(r,'ok.txt'),'old');symlinkSync(o,join(r,'link'));const db=new Database(join(d,'db.sqlite')),lease={allowlist:{files:[{repositoryId:1,path:'ok.txt',operations:['MODIFY']}]},repositories:[],projectId:'curl-ai-bridge',ownerId:'owner'},store={assertCurrentWriterLease:()=>lease},guard=createProjectWriterLeaseGuard({connection:db,leaseStore:store,repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:r}]});assert.throws(()=>guard.assertCurrentWriterLease('x',1,[{repositoryId:1,path:'../outside/x',operation:'MODIFY'}]),/traversal_rejected/);assert.throws(()=>guard.assertCurrentWriterLease('x',1,[{repositoryId:1,path:'link/x',operation:'MODIFY'}]),/symlink_rejected/);assert.ok(TASK142_RESERVED_PATHS.includes('scripts/swarm-entry.sh'));db.close();rmSync(d,{recursive:true,force:true})})

import { createDatabase } from '../src/database.js'
import { execFileSync } from 'node:child_process'
test('managed task and event writes fail closed without lease and pass with current fenced generation',()=>{
 const d=mkdtempSync(join(tmpdir(),'task-fence-')),dbPath=join(d,'workspace.sqlite'),repoRoot=process.cwd(),bridgeRoot=join(d,'bridge-repo')
 mkdirSync(bridgeRoot);execFileSync('git',['init','-q',bridgeRoot]);execFileSync('git',['-C',bridgeRoot,'config','user.email','lease-test@example.invalid']);execFileSync('git',['-C',bridgeRoot,'config','user.name','Lease Test']);writeFileSync(join(bridgeRoot,'README.md'),'fixture\n');execFileSync('git',['-C',bridgeRoot,'add','README.md']);execFileSync('git',['-C',bridgeRoot,'commit','-qm','fixture'])
 const seed=new Database(dbPath);seed.exec('CREATE TABLE repositories(id INTEGER PRIMARY KEY,name TEXT UNIQUE,root_path TEXT UNIQUE,created_at TEXT,updated_at TEXT)');seed.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(1,'multi-project-workspace',repoRoot,new Date().toISOString(),new Date().toISOString());seed.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(4,'curl-ai-bridge',bridgeRoot,new Date().toISOString(),new Date().toISOString());seed.close()
 const db=createDatabase(dbPath,{rootDir:repoRoot})
 try {
  const branch=execFileSync('git',['-C',repoRoot,'branch','--show-current'],{encoding:'utf8'}).trim()
  const head=execFileSync('git',['-C',repoRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),bridgeBranch=execFileSync('git',['-C',bridgeRoot,'branch','--show-current'],{encoding:'utf8'}).trim(),bridgeHead=execFileSync('git',['-C',bridgeRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const fixtureTask=db.createTask({title:'fenced mutation test',project:'workspace'})
  const lease=db.writerLeases.acquire({taskId:fixtureTask.id,runId:'mutation-test',workerId:'mutation-test-worker',authorizationRef:'test:mutation-guard',repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repoRoot,branch,headCommit:head},{repositoryId:4,name:'curl-ai-bridge',rootPath:bridgeRoot,branch:bridgeBranch,headCommit:bridgeHead}],allowlist:{files:[],mutations:['tasks','task_events']},idempotencyKey:'mutation-test-lease'})
  assert.throws(()=>db.createTask({title:'must fail',project:'curl-ai-bridge'}),/writer_lease_task_scope_missing/)
  const old={id:process.env.PROJECT_WRITER_LEASE_ID,generation:process.env.PROJECT_WRITER_FENCING_GENERATION,owner:process.env.PROJECT_WRITER_OWNER_ID}
  process.env.PROJECT_WRITER_LEASE_ID=lease.leaseId;process.env.PROJECT_WRITER_FENCING_GENERATION=String(lease.fencingGeneration);process.env.PROJECT_WRITER_OWNER_ID='mutation-test-worker'
  try {
   assert.throws(()=>db.createTask({title:'unbound task creation',project:'curl-ai-bridge'}),/writer_lease_task_scope_missing/)
   const task=fixtureTask
   assert.ok(task.id>0)
   const scoped=db.updateTask(task.id,{project:'curl-ai-bridge'})
   assert.equal(scoped.project,'curl-ai-bridge')
   const updated=db.updateTask(task.id,{description:'updated under lease'})
   assert.equal(updated.description,'updated under lease')
   assert.ok(db.listTaskActivity(task.id).length>=3)
  } finally {
   if(old.id===undefined)delete process.env.PROJECT_WRITER_LEASE_ID;else process.env.PROJECT_WRITER_LEASE_ID=old.id
   if(old.generation===undefined)delete process.env.PROJECT_WRITER_FENCING_GENERATION;else process.env.PROJECT_WRITER_FENCING_GENERATION=old.generation
   if(old.owner===undefined)delete process.env.PROJECT_WRITER_OWNER_ID;else process.env.PROJECT_WRITER_OWNER_ID=old.owner
  }
 } finally {db.close();rmSync(d,{recursive:true,force:true})}
})

test('broker performs atomic allowlisted file replacement against pinned Git HEAD',()=>{
 const d=mkdtempSync(join(tmpdir(),'file-fence-')),repo=join(d,'repo');mkdirSync(repo)
 execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'config','user.email','lease-test@example.invalid']);execFileSync('git',['-C',repo,'config','user.name','Lease Test']);writeFileSync(join(repo,'target.txt'),'before');execFileSync('git',['-C',repo,'add','target.txt']);execFileSync('git',['-C',repo,'commit','-qm','fixture'])
 const branch=execFileSync('git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim(),head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),db=new Database(join(d,'db.sqlite'))
 const lease={allowlist:{files:[{repositoryId:1,path:'target.txt',operations:['MODIFY']}],mutations:['tasks','task_events']},repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repo,branch,headCommit:head},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo,branch,headCommit:head}],projectId:'curl-ai-bridge',ownerId:'owner',fencingGeneration:1}
 const store={assertCurrentWriterLease:()=>lease},guard=createProjectWriterLeaseGuard({connection:db,leaseStore:store,repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repo},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo}]})
 const result=guard.withFencedMutation('lease-1',1,{repositoryId:1,path:'target.txt',operation:'MODIFY'},'after')
 assert.equal(readFileSync(join(repo,'target.txt'),'utf8'),'after');assert.equal(result.generation,1)
 assert.throws(()=>guard.withFencedMutation('lease-1',1,{repositoryId:1,path:'target.txt',operation:'CREATE'},'bad'),/not_allowlisted/)
 db.close();rmSync(d,{recursive:true,force:true})
})

test('worktree-bound mutation verifies canonical and worktree anchors independently',()=>{
 const d=mkdtempSync(join(tmpdir(),'guard-wt-')),repo=join(d,'repo');mkdirSync(repo)
 execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'config','user.email','lease-test@example.invalid']);execFileSync('git',['-C',repo,'config','user.name','Lease Test']);writeFileSync(join(repo,'f.txt'),'x');execFileSync('git',['-C',repo,'add','f.txt']);execFileSync('git',['-C',repo,'commit','-qm','fixture'])
 const branch=execFileSync('git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim(),head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),wt=join(d,'wt')
 execFileSync('git',['-C',repo,'worktree','add','-q','-b','wt-branch',wt])
 const wtBranch=execFileSync('git',['-C',wt,'branch','--show-current'],{encoding:'utf8'}).trim(),wtHead=execFileSync('git',['-C',wt,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
 const db=new Database(join(d,'db.sqlite'))
 const lease={allowlist:{files:[{repositoryId:1,path:'f.txt',operations:['MODIFY']}],mutations:['tasks','task_events']},repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repo,branch,headCommit:head,worktreePath:wt,worktreeBranch:wtBranch,worktreeHead:wtHead},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo,branch,headCommit:head}],projectId:'curl-ai-bridge',ownerId:'owner'}
 const store={assertCurrentWriterLease:()=>lease},worktrees=[{repositoryId:1,repositoryRoot:repo,worktreePath:wt,branch:wtBranch,headCommit:wtHead}]
 const guard=createProjectWriterLeaseGuard({connection:db,leaseStore:store,repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repo},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo}],worktrees})
 assert.equal(guard.withFencedMutation('x',1,{repositoryId:1,path:'f.txt',operation:'MODIFY'},'changed').path,'f.txt')
 assert.equal(readFileSync(join(wt,'f.txt'),'utf8'),'changed');assert.equal(readFileSync(join(repo,'f.txt'),'utf8'),'x')
 execFileSync('git',['-C',wt,'add','f.txt']);execFileSync('git',['-C',wt,'commit','-qm','wt commit'])
 assert.throws(()=>guard.assertCurrentWriterLease('x',1,[{repositoryId:1,path:'f.txt',operation:'MODIFY'}]),/writer_worktree_head_changed/)
 writeFileSync(join(repo,'f.txt'),'canonical2');execFileSync('git',['-C',repo,'add','-A']);execFileSync('git',['-C',repo,'commit','-qm','canonical commit'])
 assert.throws(()=>guard.assertCurrentWriterLease('x',1,[{repositoryId:1,path:'f.txt',operation:'MODIFY'}]),/writer_repository_anchor_changed/)
 db.close();rmSync(d,{recursive:true,force:true})
})

test('worktree registration replacement and symlinked parents fail closed',()=>{
 const d=mkdtempSync(join(tmpdir(),'guard-wt2-')),repo=join(d,'repo');mkdirSync(repo)
 execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'config','user.email','lease-test@example.invalid']);execFileSync('git',['-C',repo,'config','user.name','Lease Test']);writeFileSync(join(repo,'f.txt'),'x');execFileSync('git',['-C',repo,'add','f.txt']);execFileSync('git',['-C',repo,'commit','-qm','fixture'])
 const branch=execFileSync('git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim(),head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),wt=join(d,'wt')
 execFileSync('git',['-C',repo,'worktree','add','-q','-b','wt-branch',wt])
 const wtBranch=execFileSync('git',['-C',wt,'branch','--show-current'],{encoding:'utf8'}).trim(),wtHead=execFileSync('git',['-C',wt,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
 const db=new Database(join(d,'db.sqlite'))
 const lease={allowlist:{files:[],mutations:['tasks','task_events']},repositories:[{repositoryId:1,name:'multi-project-workspace',rootPath:repo,branch,headCommit:head,worktreePath:wt,worktreeBranch:wtBranch,worktreeHead:wtHead},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo,branch,headCommit:head}],projectId:'curl-ai-bridge',ownerId:'owner'}
 const store={assertCurrentWriterLease:()=>lease}
 const repos=[{repositoryId:1,name:'multi-project-workspace',rootPath:repo},{repositoryId:4,name:'curl-ai-bridge',rootPath:repo}]
 const guard=createProjectWriterLeaseGuard({connection:db,leaseStore:store,repositories:repos,worktrees:[{repositoryId:1,repositoryRoot:repo,worktreePath:wt,branch:wtBranch,headCommit:wtHead}]})
 assert.doesNotThrow(()=>guard.assertCurrentWriterLease('x',1,[]))
 const replaced=createProjectWriterLeaseGuard({connection:db,leaseStore:store,repositories:repos,worktrees:[{repositoryId:1,repositoryRoot:repo,worktreePath:join(d,'other'),branch:wtBranch,headCommit:wtHead}]})
 assert.throws(()=>replaced.assertCurrentWriterLease('x',1,[]),/writer_worktree_not_registered/)
 const link=join(d,'link');symlinkSync(d,link);const linkWt=join(link,'wt')
 const lease2={...lease,repositories:[{...lease.repositories[0],worktreePath:linkWt},lease.repositories[1]]}
 const store2={assertCurrentWriterLease:()=>lease2}
 const symlinked=createProjectWriterLeaseGuard({connection:db,leaseStore:store2,repositories:repos,worktrees:[{repositoryId:1,repositoryRoot:repo,worktreePath:linkWt,branch:wtBranch,headCommit:wtHead}]})
 assert.throws(()=>symlinked.assertCurrentWriterLease('x',1,[]),/worktree_path_symlink/)
 db.close();rmSync(d,{recursive:true,force:true})
})

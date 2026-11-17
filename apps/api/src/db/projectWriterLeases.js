// Local SQLite project-wide lease coordinator; not a multi-host distributed lock.
import { createHash, randomUUID } from 'node:crypto'
const stable = (v) => Array.isArray(v) ? '['+v.map(stable).join(',')+']' : v && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}' : JSON.stringify(v)
const digest = (v) => createHash('sha256').update(stable(v)).digest('hex')
const iso = (n) => new Date(n).toISOString()
export function createProjectWriterLeasesStore(db,{clock=()=>Date.now()}={}) {
 const leaseQ=db.prepare('SELECT * FROM project_writer_leases WHERE lease_id=?')
 const stateQ=db.prepare('SELECT * FROM project_writer_lease_state WHERE project_id=?')
 const event=db.prepare('INSERT OR IGNORE INTO project_writer_lease_events(event_id,project_id,lease_id,fencing_generation,event_type,idempotency_key,occurred_at,details_json) VALUES(?,?,?,?,?,?,?,?)')
 const map=(r)=>r&&({leaseId:r.lease_id,projectId:r.project_id,taskId:r.task_id,runId:r.run_id,workerId:r.worker_id,ownerId:r.owner_id,repositories:JSON.parse(r.repositories_json),allowlist:JSON.parse(r.allowlist_json),allowlistSha256:r.allowlist_sha256,bindingSha256:r.binding_sha256,authorizationRef:r.authorization_ref,fencingGeneration:r.fencing_generation,acquiredAt:r.acquired_at,heartbeatAt:r.heartbeat_at,expiresAt:r.expires_at,status:r.status,idempotencyKey:r.idempotency_key})
 function assertCurrentWriterLease(id,generation,targets=[],opts={}) {
  const r=leaseQ.get(id),now=opts.now??clock()
  if(!r||r.status!=='active') throw Error('writer_lease_not_active')
  if(r.fencing_generation!==generation) throw Error('writer_lease_stale_generation')
  if(Date.parse(r.expires_at)<=now) throw Error('writer_lease_expired')
  const s=stateQ.get(r.project_id); if(!s||s.fencing_generation!==generation||s.current_lease_id!==id) throw Error('writer_lease_superseded')
  if(opts.projectId&&opts.projectId!==r.project_id) throw Error('writer_lease_project_mismatch')
  if(opts.taskId!==undefined&&opts.taskId!==r.task_id) throw Error('writer_lease_task_scope_mismatch')
  if(opts.ownerId&&opts.ownerId!==r.owner_id) throw Error('writer_lease_owner_mismatch')
  const a=JSON.parse(r.allowlist_json),repositories=JSON.parse(r.repositories_json)
  const binding={projectId:r.project_id,taskId:r.task_id,runId:r.run_id,workerId:r.worker_id,ownerId:r.owner_id,repositories,allowlist:a,authorizationRef:r.authorization_ref}
  if(digest(a)!==r.allowlist_sha256||digest(binding)!==r.binding_sha256)throw Error('writer_lease_binding_tampered')
  for(const t of targets){const p=typeof t==='string'?t:t.path,op=typeof t==='string'?'MODIFY':t.operation;const x=a.files.find(y=>y.path===p);if(!x||!x.operations.includes(op))throw Error('writer_lease_path_not_allowlisted:'+p)}
  if(opts.mutation&&!(a.mutations||[]).includes(opts.mutation))throw Error('writer_lease_mutation_not_allowlisted:'+opts.mutation)
  return map(r)
 }
 const acquireTx=db.transaction((i)=>{
  const now=clock(),project=i.projectId||'curl-ai-bridge',owner=i.ownerId||i.workerId,repos=i.repositories||[],allow=i.allowlist||{files:[],mutations:['tasks','task_events']}
  if(!i.taskId||!i.runId||!i.workerId||!owner||!i.authorizationRef||repos.length!==2||!Array.isArray(allow.files)||!Array.isArray(allow.mutations))throw Error('writer_lease_identity_incomplete')
  if([...new Set(repos.map(r=>r.repositoryId))].sort((a,b)=>a-b).join(',')!=='1,4')throw Error('writer_lease_repository_set_invalid')
  const allowedRepoIds=new Set(repos.map(r=>r.repositoryId)),seenPaths=new Set()
  for(const f of allow.files){if(!allowedRepoIds.has(f.repositoryId)||typeof f.path!=='string'||f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(x=>!x||x==='.'||x==='..')||!Array.isArray(f.operations)||!f.operations.length||f.operations.some(op=>!['CREATE','MODIFY','DELETE'].includes(op)))throw Error('writer_lease_allowlist_invalid');const key=f.repositoryId+':'+f.path;if(seenPaths.has(key))throw Error('writer_lease_allowlist_duplicate');seenPaths.add(key)}
  if(allow.mutations.some(m=>!['tasks','task_events'].includes(m))||new Set(allow.mutations).size!==allow.mutations.length)throw Error('writer_lease_mutation_allowlist_invalid')
  for(const r of repos){const x=db.prepare('SELECT id,name,root_path FROM repositories WHERE id=?').get(r.repositoryId);if(!x||x.name!==r.name||x.root_path!==r.rootPath)throw Error('writer_lease_repository_not_registered:'+r.name);if(!r.branch||!/^[0-9a-f]{40,64}$/.test(r.headCommit||''))throw Error('writer_lease_repository_anchor_invalid:'+r.name)}
  const ah=digest(allow),binding={projectId:project,taskId:i.taskId,runId:i.runId,workerId:i.workerId,ownerId:owner,repositories:repos,allowlist:allow,authorizationRef:i.authorizationRef},bh=digest(binding),idem=i.idempotencyKey||randomUUID(),prior=db.prepare('SELECT * FROM project_writer_leases WHERE idempotency_key=?').get(idem)
  if(prior){if(prior.project_id!==project||prior.task_id!==i.taskId||prior.run_id!==i.runId||prior.worker_id!==i.workerId||prior.owner_id!==owner||prior.authorization_ref!==i.authorizationRef||prior.binding_sha256!==bh||prior.allowlist_sha256!==ah)throw Error('writer_lease_idempotency_conflict');return map(prior)}
  const overdue=db.prepare("SELECT * FROM project_writer_leases WHERE project_id=? AND status='active' AND expires_at<=?").all(project,iso(now))
  for(const stale of overdue){db.prepare("UPDATE project_writer_leases SET status='expired' WHERE lease_id=? AND status='active'").run(stale.lease_id);event.run(randomUUID(),project,stale.lease_id,stale.fencing_generation,'expired',stale.lease_id+':expired',iso(now),'{}')}
  if(db.prepare("SELECT 1 FROM project_writer_leases WHERE project_id=? AND status='active' AND expires_at>?").get(project,iso(now)))throw Error('writer_lease_conflict')
  const gen=(stateQ.get(project)?.fencing_generation||0)+1,id=i.leaseId||randomUUID(),at=iso(now),expires=iso(now+Math.max(1000,Math.min(300000,Number(i.ttlMs||30000))))
  db.prepare("INSERT INTO project_writer_leases(lease_id,project_id,task_id,run_id,worker_id,owner_id,repositories_json,allowlist_json,allowlist_sha256,binding_sha256,authorization_ref,fencing_generation,acquired_at,heartbeat_at,expires_at,status,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',?)").run(id,project,i.taskId,i.runId,i.workerId,owner,JSON.stringify(repos),JSON.stringify(allow),ah,bh,i.authorizationRef,gen,at,at,expires,idem)
  db.prepare('INSERT INTO project_writer_lease_state(project_id,fencing_generation,current_lease_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET fencing_generation=excluded.fencing_generation,current_lease_id=excluded.current_lease_id,updated_at=excluded.updated_at').run(project,gen,id,at)
  event.run(randomUUID(),project,id,gen,'acquired',idem+':acquired',at,JSON.stringify({workerId:i.workerId,taskId:i.taskId,allowlistSha256:ah}))
  return map(leaseQ.get(id))
 })
 const renewTx=db.transaction((id,g,owner,ttl=30000)=>{const l=assertCurrentWriterLease(id,g,[],{ownerId:owner}),now=clock(),expires=iso(now+Math.max(1000,Math.min(300000,Number(ttl))));db.prepare("UPDATE project_writer_leases SET heartbeat_at=?,expires_at=? WHERE lease_id=? AND status='active'").run(iso(now),expires,id);event.run(randomUUID(),l.projectId,id,g,'renewed',id+':renew:'+expires,iso(now),JSON.stringify({expiresAt:expires}));return map(leaseQ.get(id))})
 const releaseTx=db.transaction((id,g,owner,reason='released')=>{const r=leaseQ.get(id);if(!r)throw Error('writer_lease_not_found');if(r.fencing_generation!==g)throw Error('writer_lease_stale_generation');if(r.status==='revoked'||r.status==='expired')return map(r);const l=assertCurrentWriterLease(id,g,[],{ownerId:owner}),now=iso(clock());db.prepare("UPDATE project_writer_leases SET status='revoked',heartbeat_at=? WHERE lease_id=?").run(now,id);event.run(randomUUID(),l.projectId,id,g,'released',id+':released',now,JSON.stringify({reason}));return map(leaseQ.get(id))})
 const reclaimTx=db.transaction((project='curl-ai-bridge')=>{const now=iso(clock()),rows=db.prepare("SELECT * FROM project_writer_leases WHERE project_id=? AND status='active' AND expires_at<=?").all(project,now);for(const r of rows){db.prepare("UPDATE project_writer_leases SET status='expired' WHERE lease_id=? AND status='active'").run(r.lease_id);event.run(randomUUID(),project,r.lease_id,r.fencing_generation,'expired',r.lease_id+':expired',now,'{}')}return rows.map(r=>map(leaseQ.get(r.lease_id)))})
 return {acquire(input){return acquireTx.immediate(input)},renew(...args){return renewTx.immediate(...args)},release(...args){return releaseTx.immediate(...args)},reclaimExpired(...args){return reclaimTx.immediate(...args)},assertCurrentWriterLease,status(project='curl-ai-bridge'){const s=stateQ.get(project),r=s?.current_lease_id?leaseQ.get(s.current_lease_id):null;return {projectId:project,fencingGeneration:s?.fencing_generation||0,currentLease:map(r)}},getLease(id){return map(leaseQ.get(id))}}
}

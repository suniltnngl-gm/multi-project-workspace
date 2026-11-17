#!/usr/bin/env node
// Local-only CLI for project-wide fenced writer leases. No provider or network calls.
import { createDatabase } from '../apps/api/src/database.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const args=process.argv.slice(2),command=args.shift()||'status'
function opt(name,fallback=null){const i=args.indexOf('--'+name);return i<0?fallback:args[i+1]??fallback}
function required(name){const v=opt(name);if(!v)throw Error('missing --'+name);return v}
const db=createDatabase()
try {
 const leases=db.writerLeases
 if(command==='status'){console.log(JSON.stringify(leases.status(opt('project','curl-ai-bridge')),null,2))}
 else if(command==='reclaim-expired'){console.log(JSON.stringify(leases.reclaimExpired(opt('project','curl-ai-bridge')),null,2))}
 else if(command==='acquire'){
  const taskId=Number(required('task')),task=db.db.prepare('SELECT id,project,relevant_files,status,work_blocked,important_context FROM tasks WHERE id=?').get(taskId)
  if(!task)throw Error('task_not_found')
  if(task.status==='blocked'||task.work_blocked.trim())throw Error('task_blocked')
  if(!task.important_context.includes('state=complete')||!task.important_context.includes('disposition=ready_for_serialized_implementation'))throw Error('task_planning_gate_not_complete')
  const repositories=db.db.prepare('SELECT id AS repositoryId,name,root_path AS rootPath FROM repositories WHERE id IN (1,4) ORDER BY id').all().map(r=>({...r,branch:execFileSync('git',['-C',r.rootPath,'branch','--show-current'],{encoding:'utf8'}).trim(),headCommit:execFileSync('git',['-C',r.rootPath,'rev-parse','HEAD'],{encoding:'utf8'}).trim()}))
  const files=task.relevant_files.split(/\r?\n/).filter(Boolean).map(line=>{const m=line.match(/^(CREATE|MODIFY|DELETE)\s+([^\s]+)(?:\s+—.*)?$/);if(!m)throw Error('task_allowlist_line_invalid:'+line);return {repositoryId:1,path:m[2],operations:[m[1]]}})
  const lease=leases.acquire({projectId:opt('project',task.project),taskId,runId:required('run-id'),workerId:required('worker-id'),ownerId:opt('owner-id',opt('worker-id')),authorizationRef:required('auth-ref'),ttlMs:Number(opt('ttl-ms','30000')),idempotencyKey:opt('idempotency-key'),repositories,allowlist:{files,mutations:['tasks','task_events']}})
  console.log(JSON.stringify(lease,null,2))
 }
 else if(command==='renew'){console.log(JSON.stringify(leases.renew(required('lease'),Number(required('generation')),required('owner'),Number(opt('ttl-ms','30000'))),null,2))}
 else if(command==='release'){console.log(JSON.stringify(leases.release(required('lease'),Number(required('generation')),required('owner'),opt('reason','released')),null,2))}
 else if(command==='write'){
  const id=required('lease'),generation=Number(required('generation')),repoId=Number(required('repository-id')),path=required('path'),operation=required('operation'),content=readFileSync(required('content-file'))
  console.log(JSON.stringify(db.writerLeaseGuard.withFencedMutation(id,generation,{repositoryId:repoId,path,operation},content.toString('utf8')),null,2))
 }
 else if(command==='assert'){const id=required('lease'),generation=Number(required('generation'));console.log(JSON.stringify(db.writerLeaseGuard.assertCurrentWriterLease(id,generation,[],{mutation:opt('mutation')}),null,2))}
 else throw Error('unknown_command:'+command)
} finally { db.close() }

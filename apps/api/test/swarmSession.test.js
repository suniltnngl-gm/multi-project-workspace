import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSession,validateSession,runSession} from '../../../scripts/swarm-session.mjs'
const input={provider:'opencode',cli:'opencode',model:'m',project_id:'curl-ai-bridge',task_id:142,run_id:'r',now:'2026-11-16T00:00:00Z'}
test('session identity is provider/CLI/model/project/task/run scoped with unknown capabilities',()=>{const s=createSession(input);assert.equal(validateSession(s),true);assert.deepEqual(s.capabilities,{resume:'unknown',export:'unknown',import:'unknown'})})
test('metadata export/import are portable and native resume fails closed',()=>{const d=mkdtempSync(join(tmpdir(),'session '));try{writeFileSync(join(d,'s.json'),JSON.stringify(createSession(input)));assert.equal(runSession(['status','s.json'],d).valid,true);assert.equal(runSession(['export','s.json','--output','e.json'],d).metadata_only,true);assert.equal(runSession(['import','e.json','--output','i.json'],d).metadata_only,true);assert.throws(()=>runSession(['resume','s.json'],d),/capability_not_verified/)}finally{rmSync(d,{recursive:true,force:true})}})
test('session path traversal is rejected',()=>{const d=mkdtempSync(join(tmpdir(),'session '));try{assert.throws(()=>runSession(['status','../outside'],d),/path_rejected/)}finally{rmSync(d,{recursive:true,force:true})}})

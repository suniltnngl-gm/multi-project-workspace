import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const ROOT=new URL('../../../',import.meta.url).pathname,ENTRY=ROOT+'scripts/swarm-entry.sh'
test('Bash entrypoint syntax and paths containing spaces',()=>{const d=mkdtempSync(join(tmpdir(),'swarm entry '));try{mkdirSync(join(d,'scripts'));copyFileSync(ENTRY,join(d,'scripts/swarm-entry.sh'));for(const p of ['package.json','workspace.manifest.json','scripts/ai-swarm.mjs'])writeFileSync(join(d,p),'');assert.equal(spawnSync('bash',['-n',join(d,'scripts/swarm-entry.sh')]).status,0);const x=spawnSync('bash',[join(d,'scripts/swarm-entry.sh'),'status'],{encoding:'utf8'});assert.equal(x.status,0,x.stderr);assert.match(x.stdout,/Swarm entry ready/)}finally{rmSync(d,{recursive:true,force:true})}})
test('entrypoint refuses live run and missing root markers',()=>{const d=mkdtempSync(join(tmpdir(),'swarm root '));try{mkdirSync(join(d,'scripts'));copyFileSync(ENTRY,join(d,'scripts/swarm-entry.sh'));for(const p of ['package.json','workspace.manifest.json','scripts/ai-swarm.mjs'])writeFileSync(join(d,p),'');const x=spawnSync('bash',[join(d,'scripts/swarm-entry.sh'),'run'],{encoding:'utf8'});assert.notEqual(x.status,0);assert.match(x.stderr,/disabled/);rmSync(join(d,'workspace.manifest.json'));const y=spawnSync('bash',[join(d,'scripts/swarm-entry.sh'),'status'],{encoding:'utf8'});assert.notEqual(y.status,0)}finally{rmSync(d,{recursive:true,force:true})}})

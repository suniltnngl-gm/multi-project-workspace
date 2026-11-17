#!/usr/bin/env node
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
export function renderPrompt({task={},context={},prompt='',provider='unknown',model='unknown',root=ROOT}={}){const prefix=readFileSync(resolve(root,'prompts/swarm-system-prefix-v1.md'),'utf8').replace(/\r\n/g,'\n').trimEnd()+'\n',version=(prefix.match(/^Prefix-Version: (.+)$/m)||[])[1]||'unknown';return {static_prefix:{version,sha256:hash(prefix),content:prefix},cache_boundary:{algorithm:'sha256',fingerprint:hash({version,prefix,provider,model}),provider,model,provider_cache_hint:'none_unverified',dynamic_payload_excluded:true},dynamic_payload:{task,context,prompt}}}
function parse(a){const o={_:[]};for(let i=0;i<a.length;i++){if(a[i].startsWith('--')){const k=a[i].slice(2);o[k]=a[i+1]&&!a[i+1].startsWith('--')?a[++i]:true}else o._.push(a[i])}return o}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const o=parse(process.argv.slice(2));if(o._[0]!=='render')throw Error('usage: prompt render');console.log(JSON.stringify(renderPrompt({task:o['task-json']?JSON.parse(o['task-json']):{},context:o['context-json']?JSON.parse(o['context-json']):{},prompt:o.prompt||'',provider:o.provider||'unknown',model:o.model||'unknown'}),null,2))}catch(e){console.error(e.message);process.exitCode=2}}

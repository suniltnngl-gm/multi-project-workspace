#!/usr/bin/env node
import Ajv from 'ajv'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs'
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
export const VERSION='1.0.0';const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const CONTEXT_SCHEMA=JSON.parse(readFileSync(resolve(ROOT,'schemas/swarm-context-pack.schema.json'),'utf8'))
const ajv=new Ajv({allErrors:true,jsonPointers:true,schemaId:'auto',validateSchema:true})
const validateContextSchema=ajv.compile(CONTEXT_SCHEMA)
const secret=/(api.?key|token|password|secret|credential|authorization|private.?key)/i
export function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
export function stringify(v){return JSON.stringify(canonical(v))}
export function redact(v,k=''){if(secret.test(k))return '[REDACTED]';if(Array.isArray(v))return v.map(x=>redact(x));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([x])=>!secret.test(x)).map(([x,y])=>[x,redact(y,x)]));if(typeof v==='string')return v.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');return v}
export function digest(p){const x=structuredClone(p);delete x.integrity.sha256;return createHash('sha256').update(stringify(x)).digest('hex')}
function schemaErrors(){return (validateContextSchema.errors||[]).map(e=>({keyword:e.keyword,instancePath:e.dataPath||'',schemaPath:e.schemaPath,params:e.params,message:e.message||'schema validation failed'}))}
export function validatePack(p){if(!validateContextSchema(p)){const error=new Error('context_schema_invalid');error.code='context_schema_invalid';error.details=schemaErrors();throw error}if(digest(p)!==p.integrity.sha256)throw Error('context_digest_mismatch');return true}
export function buildPack(input){const x=redact(input);const p={schema_version:VERSION,pack_id:x.pack_id||randomUUID(),created_at:x.created_at||new Date().toISOString(),project:x.project,task:x.task,context:x.context,provenance:x.provenance||[],integrity:{algorithm:'sha256',sha256:''}};p.integrity.sha256=digest(p);validatePack(p);return p}
function safe(root,p){if(typeof p!=='string'||!p||isAbsolute(p)||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('context_path_rejected');const a=resolve(root,p),rel=relative(root,a);if(!rel||rel==='..'||rel.startsWith('..'+sep))throw Error('context_path_rejected');let c=root;for(const x of rel.split(sep)){c=resolve(c,x);if(existsSync(c)&&lstatSync(c).isSymbolicLink())throw Error('context_symlink_rejected')}return a}
function read(root,p){return JSON.parse(readFileSync(safe(root,p),'utf8'))}
function write(root,p,v,overwrite=false){const a=safe(root,p);if(existsSync(a)&&!overwrite)throw Error('context_target_exists');mkdirSync(dirname(a),{recursive:true});const t=a+'.tmp-'+randomUUID();writeFileSync(t,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});try{renameSync(t,a)}catch(e){rmSync(t,{force:true});throw e}}
function opts(a){const o={_:[]};for(let i=0;i<a.length;i++){if(a[i].startsWith('--')){const k=a[i].slice(2);o[k]=a[i+1]&&!a[i+1].startsWith('--')?a[++i]:true}else o._.push(a[i])}return o}
export function runContext(argv,root=ROOT){const o=opts(argv),[cmd,p]=o._;if(cmd==='build'){const pack=buildPack(read(root,o.input));write(root,o.output,pack,o.overwrite===true);return {valid:true,sha256:pack.integrity.sha256}}if(cmd==='validate'){const pack=read(root,p);validatePack(pack);return {valid:true,sha256:pack.integrity.sha256}}if(['export','import'].includes(cmd)){const pack=read(root,p);validatePack(pack);write(root,o.output,pack,o.overwrite===true);return {metadata_only:true,operation:cmd,sha256:pack.integrity.sha256}}throw Error('context_command_unsupported')}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(runContext(process.argv.slice(2)),null,2))}catch(e){console.error(JSON.stringify({error:{code:e.code||'context_operation_failed',message:e.message,details:e.details||[]}},null,2));process.exitCode=2}}

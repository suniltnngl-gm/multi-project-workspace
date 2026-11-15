import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
export const VERIFY_ONLY_RETENTION_MS = 390_000;
export function createInMemoryPermitKeyStore(){let value=null;return{persistent:false,async load(){return value?structuredClone(value):null;},async commit(next){value=structuredClone(next);}};}
export function createPermitKeyring({store,clock=()=>Date.now(),kidFactory=randomUUID,keyPairFactory=()=>generateKeyPairSync('ed25519'),production=false}={}){
 if(!store||typeof store.load!=='function'||typeof store.commit!=='function')throw new Error('Injected lifecycle store required');
 if(production&&store.persistent!==true)throw new Error('Production key issuance disabled without durable adapter');
 let state=null;const privateKeys=new Map();
 const now=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<=0)throw new Error('Invalid clock');if(state&&n<state.lastObservedNowMs)throw new Error('Clock rollback');return n;};
 const persist=async next=>{if(production&&store.persistent!==true)throw new Error('Durable lifecycle store required');await store.commit(next);state=next;};
 const snapshot=()=>state?structuredClone(state):null;
 const initialize=async()=>{
  state=await store.load();
  if(state&&(!Array.isArray(state.keys)||!Array.isArray(state.usedKids)||!Array.isArray(state.revokedKids)||!Number.isSafeInteger(state.lastObservedNowMs)||!Number.isSafeInteger(state.lastBundleRevision)||!Number.isSafeInteger(state.lastAcceptedIssuedAt)||!Number.isSafeInteger(state.acknowledgedRevision)||new Set(state.usedKids).size!==state.usedKids.length||new Set(state.revokedKids).size!==state.revokedKids.length||state.keys.some(k=>!k||typeof k.kid!=='string'||typeof k.publicKey!=='string'||!['PREPUBLISHED','ACTIVE','VERIFY_ONLY','REVOKED'].includes(k.status)||!state.usedKids.includes(k.kid))))throw new Error('Missing/corrupt lifecycle metadata');
  if(!state){if(production)throw new Error('Production lifecycle metadata is not provisioned');state={keys:[],usedKids:[],revokedKids:[],lastBundleRevision:0,lastAcceptedIssuedAt:0,lastObservedNowMs:now(),acknowledgedRevision:0};await persist(state);return snapshot();}
  const n=clock();if(!Number.isSafeInteger(n)||n<=0||n<state.lastObservedNowMs)throw new Error('Clock rollback or invalid clock during restart');
  let changed=false;const revoked=new Set(state.revokedKids);
  const keys=state.keys.map(k=>{
   if(k.status==='ACTIVE'){changed=true;const base=Number.isSafeInteger(k.lastSignedAt)?k.lastSignedAt:(Number.isSafeInteger(k.activatedAt)?k.activatedAt:state.lastObservedNowMs);return{...k,status:'VERIFY_ONLY',verifyUntil:base+VERIFY_ONLY_RETENTION_MS,restartedAt:n};}
   if(k.status==='PREPUBLISHED'){changed=true;revoked.add(k.kid);return{...k,status:'REVOKED',revokedAt:n};}
   return k;
  });
  if(changed)await persist({...state,keys,revokedKids:[...revoked],lastObservedNowMs:n});
  else if(n>state.lastObservedNowMs)await persist({...state,lastObservedNowMs:n});
  return snapshot();
 };
 const generate=async()=>{if(!state)await initialize();const n=now(),kid=kidFactory();if(typeof kid!=='string'||!kid||state.usedKids.includes(kid))throw new Error('kid reuse/invalid kid');const pair=keyPairFactory();privateKeys.set(kid,pair.privateKey);const entry={kid,status:'PREPUBLISHED',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),createdAt:n};await persist({...state,keys:[...state.keys,entry],usedKids:[...state.usedKids,kid],lastObservedNowMs:n});return{kid,publicKey:entry.publicKey,status:entry.status};};
 const acknowledgeBundle=async(revision)=>{if(!state)await initialize();const n=now();if(!Number.isSafeInteger(revision)||revision<state.acknowledgedRevision||revision>state.lastBundleRevision)throw new Error('Invalid Bridge acknowledgement revision');await persist({...state,acknowledgedRevision:revision,lastObservedNowMs:n});return snapshot();};
 const recordBundleIssued=async(revision,issuedAt)=>{if(!state)await initialize();const n=now();if(!Number.isSafeInteger(revision)||revision<=state.lastBundleRevision||!Number.isSafeInteger(issuedAt)||issuedAt<n-30000||issuedAt>n+30000||issuedAt<state.lastAcceptedIssuedAt)throw new Error('Trust bundle revision/issuedAt rollback');await persist({...state,lastBundleRevision:revision,lastAcceptedIssuedAt:issuedAt,lastObservedNowMs:n});return snapshot();};
 const activate=async(kid,ackRevision)=>{if(!state)await initialize();const key=state.keys.find(k=>k.kid===kid);if(!Number.isSafeInteger(ackRevision)||ackRevision<1||ackRevision>state.acknowledgedRevision)throw new Error('Bridge bundle acknowledgement required');if(!key||key.status!=='PREPUBLISHED'||!privateKeys.has(kid))throw new Error('Only runtime-held PREPUBLISHED key can activate');const n=now();await persist({...state,keys:state.keys.map(k=>k.kid===kid?{...k,status:'ACTIVE',activatedAt:n,acknowledgedRevision:ackRevision}:k),lastObservedNowMs:n});return snapshot();};
 const rotate=async kid=>{if(!state)await initialize();const key=state.keys.find(k=>k.kid===kid);if(!key||key.status!=='ACTIVE')throw new Error('Only ACTIVE key can rotate');const n=now();const verifyUntil=(Number.isSafeInteger(key.lastSignedAt)?key.lastSignedAt:(Number.isSafeInteger(key.activatedAt)?key.activatedAt:n))+VERIFY_ONLY_RETENTION_MS;await persist({...state,keys:state.keys.map(k=>k.kid===kid?{...k,status:'VERIFY_ONLY',verifyUntil}:k),lastObservedNowMs:n});privateKeys.delete(kid);return snapshot();};
 const revoke=async kid=>{if(!state)await initialize();if(!state.usedKids.includes(kid))throw new Error('Unknown kid');const n=now();privateKeys.delete(kid);await persist({...state,keys:state.keys.map(k=>k.kid===kid?{...k,status:'REVOKED',revokedAt:n}:k),revokedKids:[...new Set([...state.revokedKids,kid])],lastObservedNowMs:n});return snapshot();};
 const signer=async kid=>{if(!state)await initialize();const entry=state.keys.find(k=>k.kid===kid),key=privateKeys.get(kid);if(!entry||entry.status!=='ACTIVE'||!key)throw new Error('Only ACTIVE runtime key can sign');return{kid,async signJcs(bytes){const signature=sign(null,Buffer.from(bytes),key);const n=now();await persist({...state,keys:state.keys.map(k=>k.kid===kid?{...k,lastSignedAt:n}:k),lastObservedNowMs:n});return{kid,signature};}};};
 const publicTrust=async(at=now())=>{if(!state)await initialize();const keys={};for(const k of state.keys)if(k.status==='PREPUBLISHED'||k.status==='ACTIVE'||(k.status==='VERIFY_ONLY'&&at<k.verifyUntil))keys[k.kid]={publicKey:k.publicKey,status:k.status==='ACTIVE'?'active':k.status==='PREPUBLISHED'?'prepublished':'verify-only'};return{keys,revokedKids:[...state.revokedKids]};};
 return{production,initialize,generate,activate,rotate,revoke,signer,publicTrust,snapshot,acknowledgeBundle,recordBundleIssued};
}
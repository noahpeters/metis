import {createGithubAppJwt} from './github.mjs';
const uuid=/^[a-f0-9-]{36}$/;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
function requireValue(condition){if(!condition)throw Error('repository_service_rejected');}
function base64(bytes){return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decode(text){return Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
async function key(secret){requireValue(typeof secret==='string'&&secret.length>=32);return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function issueRepositoryCapability(env,claims,now=Math.floor(Date.now()/1000)){
  const body=base64(new TextEncoder().encode(JSON.stringify({...claims,expires:now+1800}))),signature=await crypto.subtle.sign('HMAC',await key(env.REPOSITORY_CAPABILITY_KEY),new TextEncoder().encode(body));return body+'.'+base64(new Uint8Array(signature));
}
export async function verifyRepositoryCapability(env,token,now=Math.floor(Date.now()/1000)){
  const parts=String(token).split('.');requireValue(parts.length===2&&await crypto.subtle.verify('HMAC',await key(env.REPOSITORY_CAPABILITY_KEY),decode(parts[1]),new TextEncoder().encode(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decode(parts[0])));requireValue(Number.isInteger(claims.expires)&&claims.expires>now&&claims.expires<=now+1800&&/^[a-z][a-z0-9_-]{0,63}$/.test(claims.binding)&&uuid.test(claims.taskId)&&uuid.test(claims.logicalTaskId)&&uuid.test(claims.executionId));return claims;
}
export function repositoryBinding(env,binding){
  const bindings=JSON.parse(env.REPOSITORY_PROVIDERS_JSON??'{}');requireValue(Object.hasOwn(bindings,binding));const config=bindings[binding],url=new URL(config.remote);
  requireValue(['github','artifacts'].includes(config.source?.adapter)&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&config.store?.origin&&config.store?.token);
  if(config.source.adapter==='github')requireValue(url.origin==='https://github.com'&&url.pathname==='/'+config.source.repository+'.git');
  else requireValue(url.hostname.endsWith('.artifacts.cloudflare.net')&&url.pathname==='/git/'+config.source.repository+'.git');
  requireValue(config.source.ref&&config.source.ref!=='HEAD');return {...config,binding};
}
export async function prepareRepositoryExecution(env,binding,task){
  const config=repositoryBinding(env,binding);requireValue(uuid.test(task.taskId)&&uuid.test(task.logicalTaskId)&&uuid.test(task.executionId??task.taskId));
  const origin=new URL(env.REPOSITORY_PUBLIC_ORIGIN);requireValue(origin.protocol==='https:'&&origin.origin===env.REPOSITORY_PUBLIC_ORIGIN);
  const token=await issueRepositoryCapability(env,{binding,taskId:task.taskId,logicalTaskId:task.logicalTaskId,executionId:task.executionId??task.taskId,source:config.source});const prefix=origin.origin+'/v1/repositories/'+binding;
  return {source:config.source,remote:prefix+'/git',authorization:'Bearer '+token,broker:{origin:prefix+'/commands',token},store:{origin:prefix+'/store',token},reviewOrigin:config.origin,executionTimeoutMs:config.executionTimeoutMs,setupCommands:config.setupCommands,capture:config.capture,taskUiOrigin:config.taskUiOrigin};
}
export async function providerAuthorization(env,config,write=false,fetchImpl=fetch){
  if(config.source.adapter!=='github') {const authorization=write?config.authorization:config.readAuthorization;requireValue(authorization);return {authorization};}
  if(env.GITHUB_APP_ID&&env.GITHUB_APP_INSTALLATION_ID&&env.GITHUB_APP_PRIVATE_KEY){
    const jwt=await createGithubAppJwt(env.GITHUB_APP_ID,env.GITHUB_APP_PRIVATE_KEY),r=await fetchImpl('https://api.github.com/app/installations/'+env.GITHUB_APP_INSTALLATION_ID+'/access_tokens',{method:'POST',redirect:'manual',headers:{authorization:'Bearer '+jwt,'content-type':'application/json','user-agent':'metis-repository-service','x-github-api-version':'2022-11-28'},body:JSON.stringify({repositories:[config.source.repository.split('/')[1]],permissions:write?{contents:'write',pull_requests:'write',issues:'write'}:{contents:'read'}}),signal:AbortSignal.timeout(30000)});requireValue(r.ok);const d=await r.json();requireValue(d.token);return {token:d.token,authorization:'Basic '+btoa('x-access-token:'+d.token)};
  }
  const token=write?config.token:config.readToken;requireValue(token);return {token,authorization:'Basic '+btoa('x-access-token:'+token)};
}
async function boundedJSON(request,max=1024*1024){const reader=request.body?.getReader();requireValue(reader);let count=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;requireValue(count<=max);chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}const bytes=new Uint8Array(count);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
async function storeCall(env,config,body){requireValue(env.REPOSITORY_STORE?.fetch);const r=await env.REPOSITORY_STORE.fetch(config.store.origin,{method:'POST',redirect:'manual',headers:{authorization:'Bearer '+config.store.token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});requireValue(r.ok);return r.json();}
const objectScope=claims=>JSON.stringify([claims.binding,claims.source.adapter,claims.source.repository]);
async function grant(env,binding,content){requireValue(/^sha256:[a-f0-9]{64}$/.test(content.ref)&&content.ref==='sha256:'+content.sha256);await env.DB.prepare('INSERT OR IGNORE INTO repository_object_grants(binding,ref) VALUES(?,?)').bind(binding,content.ref).run();}
async function grantReturnedContent(env,binding,value){if(!value||typeof value!=='object')return;if(typeof value.ref==='string'&&typeof value.sha256==='string')await grant(env,binding,value);for(const child of Object.values(value))if(child&&typeof child==='object')await grantReturnedContent(env,binding,child);}
async function requireGrantedContent(env,scope,value){
  const refs=new Set();
  const visit=item=>{if(!item||typeof item!=='object')return;const ref=typeof item.contentRef==='string'?item.contentRef:(typeof item.ref==='string'&&typeof item.sha256==='string'?item.ref:null);if(ref){requireValue(/^sha256:[a-f0-9]{64}$/.test(ref));refs.add(ref);}for(const child of Object.values(item))if(child&&typeof child==='object')visit(child);};visit(value);
  const all=[...refs];for(let i=0;i<all.length;i+=80){const batch=all.slice(i,i+80),rows=await env.DB.prepare('SELECT ref FROM repository_object_grants WHERE binding=? AND ref IN ('+batch.map(()=>'?').join(',')+')').bind(scope,...batch).all();requireValue(rows.results.length===batch.length);}
}
export async function repositoryServiceFetch(request,env,{fetchImpl=fetch,publish=command=>env.PUBLISHER.getByName('publisher').run(command)}={}){
  try{
    const url=new URL(request.url),match=/^\/v1\/repositories\/([a-z][a-z0-9_-]{0,63})\/(git(?:\/.*)?|store|commands)$/.exec(url.pathname);if(!match)return json({error:'not_found'},404);
    const claims=await verifyRepositoryCapability(env,(request.headers.get('authorization')??'').replace(/^Bearer /,''));requireValue(claims.binding===match[1]);const config=repositoryBinding(env,claims.binding),route=match[2];requireValue(claims.source?.adapter===config.source.adapter&&claims.source?.repository===config.source.repository&&claims.source?.ref===config.source.ref);
    if(route.startsWith('git/')){
      const suffix=route.slice(3),query=[...url.searchParams.entries()];
      requireValue((request.method==='GET'&&suffix==='/info/refs'&&query.length===1&&query[0][0]==='service'&&query[0][1]==='git-upload-pack')||(request.method==='POST'&&suffix==='/git-upload-pack'&&query.length===0&&request.headers.get('content-type')==='application/x-git-upload-pack-request'));
      const auth=await providerAuthorization(env,config,false,fetchImpl),headers={authorization:auth.authorization};const protocol=request.headers.get('git-protocol');if(protocol){requireValue(protocol==='version=2'||protocol==='version=1');headers['git-protocol']=protocol;}if(request.method==='POST')headers['content-type']='application/x-git-upload-pack-request';
      // Stream pack responses. Never buffer or store repository contents in D1.
      const response=await fetchImpl(config.remote+suffix+url.search,{method:request.method,headers,body:request.method==='POST'?request.body:undefined,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(120000)});
      if(!response.ok)return json({error:'repository_read_failed'},502);const type=response.headers.get('content-type');requireValue(type===(request.method==='GET'?'application/x-git-upload-pack-advertisement':'application/x-git-upload-pack-result'));return new Response(response.body,{status:200,headers:{'content-type':type,'cache-control':'no-store'}});
    }
    requireValue(request.method==='POST'&&!url.search);
    if(route==='store'){
      const body=await boundedJSON(request,8*1024*1024),execution='execution:'+claims.executionId;
      if(body.action==='put'){const content=await storeCall(env,config,body);await grant(env,objectScope(claims),content);return json(content);}
      if(body.action==='get'){requireValue(await env.DB.prepare('SELECT ref FROM repository_object_grants WHERE binding=? AND ref=?').bind(objectScope(claims),body.content?.ref??'').first());return json(await storeCall(env,config,body));}
      if(body.action==='read')requireValue(body.key===execution||body.key==='change:'+claims.logicalTaskId||/^publication:metis-review-[a-f0-9]{64}$/.test(body.key));
      else if(body.action==='save')requireValue(body.key===execution&&body.changeId===execution);
      else if(['lock','unlock'].includes(body.action))requireValue(body.changeId===execution);
      else throw Error('store_action_rejected');
      const value=await storeCall(env,config,body);if(body.action==='read'&&body.key.startsWith('publication:'))requireValue(!value||(value.intent?.taskId??value.receipt?.taskId)===claims.logicalTaskId);return json(value);
    }
    const body=await boundedJSON(request);requireValue(['publish','update','readChange','observe'].includes(body.operation));
    if(['publish','update'].includes(body.operation))await requireGrantedContent(env,objectScope(claims),body.intent);
    const value=await publish({claims,operation:body.operation,intent:body.intent,publication:body.publication});if(value.ok)await grantReturnedContent(env,objectScope(claims),value.value);return json(value);
  }catch{return json({error:'repository_service_rejected'},403);}
}

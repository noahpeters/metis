import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Exercise the real broker inside workerd: Node fetch accepts redirect:error,
// while Workers rejects it before sending a request, even with a valid token.
test('Worker Git proxy uses a supported redirect mode and refuses upstream redirects',async t=>{
 const root=new URL('../',import.meta.url).pathname;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-08-30',modulesRoot:root,modules:[
  {type:'ESModule',path:root+'edge-test.mjs',contents:`
   import {repositoryServiceFetch,issueRepositoryCapability} from './src/repository-service.mjs';
   export default {async fetch(request){
    const source={adapter:'github',repository:'example/project',ref:'main'},env={REPOSITORY_CAPABILITY_KEY:'x'.repeat(32),REPOSITORY_PROVIDERS_JSON:JSON.stringify({example:{source,remote:'https://github.com/example/project.git',readToken:'test-read-token',store:{origin:'https://store.example',token:'test-bridge'}}})};
    const token=await issueRepositoryCapability(env,{source,binding:'example',taskId:'1'.repeat(36),logicalTaskId:'2'.repeat(36),executionId:'1'.repeat(36)});
    const redirect=new URL(request.url).searchParams.has('redirect');
    return repositoryServiceFetch(new Request('https://broker.example/v1/repositories/example/git/info/refs?service=git-upload-pack',{headers:{authorization:'Bearer '+token}}),env,{fetchImpl:async(url,options)=>{
     // Validate RequestInit with native Workers fetch without external traffic.
     await fetch('data:text/plain,ok',{redirect:options.redirect});
     return redirect?new Response(null,{status:302,headers:{location:'https://elsewhere.example'}}):new Response('test advertisement',{headers:{'content-type':'application/x-git-upload-pack-advertisement'}});
    }});
   }};`},
  {type:'ESModule',path:root+'src/repository-service.mjs'},
  {type:'ESModule',path:root+'src/github.mjs'},
  {type:'ESModule',path:root+'runtime/repositories/deadline.mjs'}
 ]}));
 t.after(()=>mf.dispose());
 const response=await mf.dispatchFetch('http://test/');assert.equal(response.status,200);assert.equal(await response.text(),'test advertisement');
 assert.equal((await mf.dispatchFetch('http://test/?redirect')).status,502);
});

test('Worker broker locks, saves and reads D1 through a private authenticated service binding',async t=>{
 const root=new URL('../',import.meta.url).pathname;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-08-30',modulesRoot:root,workers:[
  {name:'broker',serviceBindings:{REPOSITORY_STORE:'store'},modules:[
   {type:'ESModule',path:root+'broker-test.mjs',contents:`
    import {repositoryServiceFetch,issueRepositoryCapability} from './src/repository-service.mjs';
    export default {async fetch(request,bindings){
     const source={adapter:'github',repository:'example/project',ref:'main'},env={...bindings,REPOSITORY_CAPABILITY_KEY:'x'.repeat(32),REPOSITORY_PROVIDERS_JSON:JSON.stringify({example:{source,remote:'https://github.com/example/project.git',readOnlyDiagnostic:new URL(request.url).searchParams.has('diagnostic'),store:{origin:'https://private.invalid/v1/repositories/store',token:new URL(request.url).searchParams.has('bad-auth')?'wrong':'test-bridge'}}})};
     const token=await issueRepositoryCapability(env,{source,binding:'example',taskId:'1'.repeat(36),logicalTaskId:'2'.repeat(36),executionId:'1'.repeat(36)});
     return repositoryServiceFetch(new Request('https://broker.example/v1/repositories/example/store',{method:'POST',headers:{authorization:'Bearer '+token},body:await request.text()}),env,{fetchImpl:()=>{throw Error('Public store transport is forbidden');}});
    }};`},
   {type:'ESModule',path:root+'src/repository-service.mjs'},
   {type:'ESModule',path:root+'src/github.mjs'},
  {type:'ESModule',path:root+'runtime/repositories/deadline.mjs'}
  ]},
  {name:'store',d1Databases:{DB:'store-test'},bindings:{REPOSITORY_STORE_TOKEN:'test-bridge'},modules:[
   {type:'ESModule',path:root+'store-test.mjs',contents:`import {repositoryStore} from './src/repository-store.mjs';export default {fetch(request,env){return repositoryStore(request,env);}};`},
   {type:'ESModule',path:root+'src/repository-store.mjs'}
  ]}
 ]}));
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB','store');
 const {readFile}=await import('node:fs/promises');await db.exec((await readFile(root+'migrations/0024_repository_store.sql','utf8')).split('ALTER TABLE')[0].replaceAll('\n',' '));
 const call=(body,path='')=>mf.dispatchFetch('http://broker/'+path,{method:'POST',body:JSON.stringify(body)});
 const changeId='execution:'+'1'.repeat(36),owner='test-owner';
 assert.equal((await call({action:'lock',changeId,owner})).status,200);
 assert.equal((await call({action:'save',key:changeId,changeId,owner,value:{state:'running'}})).status,200);
 let response=await call({action:'read',key:changeId});assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'running'});
 assert.equal((await call({action:'read',key:changeId},'?bad-auth')).status,403);
 const progressKey='progress:'+'1'.repeat(36);assert.equal((await call({action:'save',key:progressKey,changeId,owner,value:{commandCount:1}})).status,200);assert.equal((await call({action:'save',key:'progress:'+'9'.repeat(36),changeId,owner,value:{bad:true}})).status,403);assert.deepEqual(JSON.parse((await db.prepare('SELECT value FROM repository_records WHERE key=?').bind(progressKey).first()).value),{commandCount:1});
 const row=await db.prepare('SELECT value FROM repository_records WHERE key=?').bind(changeId).first();assert.deepEqual(JSON.parse(row.value),{state:'running'});
 assert.equal((await call({action:'unlock',changeId,owner})).status,200);
 assert.equal((await call({action:'lock',changeId,owner},'?diagnostic')).status,200);
 const lease=await db.prepare('SELECT expires_at-unixepoch() AS seconds FROM repository_locks WHERE change_id=?').bind(changeId).first();assert.ok(lease.seconds>=2699&&lease.seconds<=2700);
 await db.prepare('UPDATE repository_locks SET expires_at=expires_at-? WHERE change_id=?').bind(31*60,changeId).run();
 assert.equal((await call({action:'save',key:changeId,changeId,owner,value:{state:'completed'}},'?diagnostic')).status,200);
 assert.equal((await call({action:'unlock',changeId,owner},'?diagnostic')).status,200);
});

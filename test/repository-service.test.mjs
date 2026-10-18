import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {repositoryServiceFetch,issueRepositoryCapability,verifyRepositoryCapability,prepareRepositoryExecution,providerAuthorization} from '../src/repository-service.mjs';
import {repositoryStore} from '../src/repository-store.mjs';import {HttpRepositoryStore} from '../runtime/repositories/store.mjs';
const claims={source:{adapter:'github',repository:'example/project',ref:'main'},binding:'example',taskId:'1'.repeat(36),logicalTaskId:'2'.repeat(36),executionId:'1'.repeat(36)};
function fixture(t){const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());for(const file of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql','0023_native_tasks.sql','0024_repository_store.sql','0025_repository_object_grants.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(query){let values=[];return {bind(...args){values=args;return this;},async first(){return sql.prepare(query).get(...values)??null;},async run(){return {meta:{changes:Number(sql.prepare(query).run(...values).changes)}};},async all(){return {results:sql.prepare(query).all(...values)};}};},async batch(items){return Promise.all(items.map(s=>s.run()));}};
 const config={source:{adapter:'github',repository:'example/project',ref:'main'},remote:'https://github.com/example/project.git',token:'publisher-secret',readToken:'reader-secret',session:'operator-cookie',authorization:'provider-write-auth',store:{origin:'https://control.example/store',token:'private-store-secret'},capture:{output:'capture.png'},artifactsMedia:{apiToken:'media-secret'}};
 const env={DB,REPOSITORY_CAPABILITY_KEY:'x'.repeat(32),REPOSITORY_PUBLIC_ORIGIN:'https://broker.example',REPOSITORY_PROVIDERS_JSON:JSON.stringify({example:config})};
 return {env,config,sql,async request(path,options={},override={}){const token=await issueRepositoryCapability(env,claims);return repositoryServiceFetch(new Request('https://broker.example/v1/repositories/example/'+path,{...options,headers:{authorization:'Bearer '+token,...options.headers}}),env,override);}};
}
test('capabilities are signed, expire, and bind the task and repository; execution config excludes provider credentials',async t=>{
 const f=fixture(t),token=await issueRepositoryCapability(f.env,claims,1000);assert.equal((await verifyRepositoryCapability(f.env,token,1001)).binding,'example');await assert.rejects(verifyRepositoryCapability(f.env,token,2800));await assert.rejects(verifyRepositoryCapability(f.env,token+'bad',1001));
 const config=await prepareRepositoryExecution(f.env,'example',claims);assert.equal(config.source.repository,'example/project');assert.equal(config.remote,'https://broker.example/v1/repositories/example/git');
 for(const secret of ['publisher-secret','reader-secret','operator-cookie','provider-write-auth','private-store-secret','media-secret'])assert.ok(!JSON.stringify(config).includes(secret));assert.equal(config.artifactsMedia,undefined);
 const r=await repositoryServiceFetch(new Request('https://broker.example/v1/repositories/another/git/info/refs?service=git-upload-pack',{headers:{authorization:'Bearer '+await issueRepositoryCapability(f.env,claims)}}),f.env);assert.equal(r.status,403);
 const retargeted={...f.env,REPOSITORY_PROVIDERS_JSON:JSON.stringify({example:{...f.config,source:{...f.config.source,repository:'example/other'},remote:'https://github.com/example/other.git'}})};assert.equal((await repositoryServiceFetch(new Request('https://broker.example/v1/repositories/example/git/info/refs?service=git-upload-pack',{headers:{authorization:'Bearer '+await issueRepositoryCapability(f.env,claims)}}),retargeted)).status,403);
});
test('smart Git proxy streams advertisements/fetches and rejects all push, path, redirect and header escalation attempts',async t=>{
 const f=fixture(t);let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.ok(url.startsWith('https://github.com/example/project.git/'));assert.equal(options.headers.authorization,'Basic '+btoa('x-access-token:reader-secret'));assert.equal(options.redirect,'error');assert.equal(options.headers.cookie,undefined);return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('streamed Git pack'));c.close();}}),{headers:{'content-type':options.method==='GET'?'application/x-git-upload-pack-advertisement':'application/x-git-upload-pack-result'}});};
 let response=await f.request('git/info/refs?service=git-upload-pack',{}, {fetchImpl});assert.equal(response.status,200);assert.equal(await response.text(),'streamed Git pack');
 response=await f.request('git/git-upload-pack',{method:'POST',headers:{'content-type':'application/x-git-upload-pack-request','git-protocol':'version=2',cookie:'must-not-forward'},body:'0000'}, {fetchImpl});assert.equal(response.status,200);
 for(const [path,options] of [['git/info/refs?service=git-receive-pack',{}],['git/git-receive-pack',{method:'POST',body:'0000'}],['git/HEAD',{}],['git/info/refs?service=git-upload-pack&service=git-receive-pack',{}],['git/git-upload-pack',{method:'GET'}]])assert.equal((await f.request(path,options,{fetchImpl})).status,403);
 assert.equal(calls,2);
 assert.equal((await f.request('git/info/refs?service=git-upload-pack',{}, {fetchImpl:async()=>new Response('redirect',{status:302,headers:{location:'https://evil.example'}})})).status,502);
});
test('broker store fences execution writes and scopes durable blob reads to an enrolled binding',async t=>{
 const f=fixture(t);const fetchImpl=(url,options)=>repositoryStore(new Request(url,options),{DB:f.env.DB,REPOSITORY_STORE_TOKEN:f.config.store.token});
 const config=await prepareRepositoryExecution(f.env,'example',claims);const store=new HttpRepositoryStore({...config.store,fetchImpl:(url,options)=>repositoryServiceFetch(new Request(url,options),f.env,{fetchImpl})});
 const content=await store.put(Buffer.from([0,255,1]));assert.deepEqual(await store.get(content),Buffer.from([0,255,1]));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_object_grants').get().n,1);
 await store.lock('execution:'+claims.executionId,()=>store.save('execution:'+claims.executionId,{state:'completed'}));assert.equal((await store.read('execution:'+claims.executionId)).state,'completed');
 await assert.rejects(store.lock(claims.logicalTaskId,()=>{}));await assert.rejects(store.save('change:'+claims.logicalTaskId,{bad:true}));await assert.rejects(store.read('execution:'+'9'.repeat(36)));
 f.sql.prepare('DELETE FROM repository_object_grants').run();await assert.rejects(store.get(content));
});
test('only change package operations reach the publisher and source credentials stay outside request payloads',async t=>{
 const f=fixture(t);let count=0;
 const publish=async command=>{count++;assert.equal(command.claims.logicalTaskId,claims.logicalTaskId);assert.equal(command.operation,'publish');assert.equal(command.token,undefined);return {ok:true,value:{review:{id:'1'}}};};
 const response=await f.request('commands',{method:'POST',body:JSON.stringify({operation:'publish',intent:{sample:true},claims:{binding:'other'}})},{publish});assert.equal(response.status,200);assert.equal((await response.json()).value.review.id,'1');assert.equal(count,1);
 assert.equal((await f.request('commands',{method:'POST',body:JSON.stringify({operation:'publish',intent:{changeSet:{changes:[{after:{contentRef:'sha256:'+'a'.repeat(64)}}]}}})},{publish})).status,403);assert.equal(count,1);
 for(const operation of ['merge','approve','deploy','push'])assert.equal((await f.request('commands',{method:'POST',body:JSON.stringify({operation})},{publish})).status,403);assert.equal(count,1);
});
test('provider read authentication never falls back to an enrolled write credential',async t=>{const f=fixture(t);await assert.rejects(providerAuthorization(f.env,{...f.config,readToken:undefined},false));const artifacts={source:{adapter:'artifacts'},authorization:'write-only'};await assert.rejects(providerAuthorization(f.env,artifacts,false));assert.deepEqual(await providerAuthorization(f.env,{...artifacts,readAuthorization:'read-only'},false),{authorization:'read-only'});});
test('GitHub App tokens are minted for one repository with separate read and publishing permissions',async t=>{
 const {generateKeyPairSync}=await import('node:crypto'),f=fixture(t),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});Object.assign(f.env,{GITHUB_APP_ID:'123',GITHUB_APP_INSTALLATION_ID:'456',GITHUB_APP_PRIVATE_KEY:privateKey});const seen=[];
 const fetchImpl=async(url,options)=>{assert.equal(url,'https://api.github.com/app/installations/456/access_tokens');assert.match(options.headers.authorization,/^Bearer ey/);assert.equal(options.redirect,'error');seen.push(JSON.parse(options.body));return Response.json({token:'fresh-scoped-installation-token'});};
 const read=await providerAuthorization(f.env,f.config,false,fetchImpl),write=await providerAuthorization(f.env,f.config,true,fetchImpl);assert.equal(read.token,write.token);assert.deepEqual(seen,[{repositories:['project'],permissions:{contents:'read'}},{repositories:['project'],permissions:{contents:'write',pull_requests:'write',issues:'write'}}]);
});

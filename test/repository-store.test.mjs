import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {repositoryStore} from '../src/repository-store.mjs';
import {HttpRepositoryStore} from '../runtime/repositories/store.mjs';
function fixture(t){const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());for(const file of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql','0023_native_tasks.sql','0024_repository_store.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const DB={prepare(query){let values=[];return {bind(...args){values=args;return this;},async first(){return sql.prepare(query).get(...values)??null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...values).changes)}};}};},async batch(items){sql.exec('BEGIN');try{const out=[];for(const s of items)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const env={DB,REPOSITORY_STORE_TOKEN:'private-store-test-token'},fetchImpl=(url,options)=>repositoryStore(new Request(url,options),env);
  const client=()=>new HttpRepositoryStore({origin:'https://metis.example/v1/repositories/store',token:env.REPOSITORY_STORE_TOKEN,fetchImpl});return {sql,env,client,fetchImpl};
}
test('private D1 bridge stores and independently retrieves binary content across chunk boundaries',async t=>{const f=fixture(t),store=f.client();const bytes=Buffer.alloc(220000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;const content=await store.put(bytes);assert.deepEqual(await store.get(content),bytes);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_objects').get().n,1);assert.ok(f.sql.prepare('SELECT count(*) AS n FROM repository_object_chunks').get().n>1);await store.put(bytes);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_objects').get().n,1);
  await store.lock('change',async()=>{await store.save('publication:test',{phase:'prepared',content});assert.equal((await store.read('publication:test')).phase,'prepared');});assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_locks').get().n,0);
});
test('bridge authentication and content integrity fail closed',async t=>{const f=fixture(t);const unauthorized=await repositoryStore(new Request('https://metis.example/v1/repositories/store',{method:'POST',body:'{}'}),f.env);assert.equal(unauthorized.status,401);const store=f.client();await assert.rejects(store.save('unlocked',{bad:true}));const content=await store.put('contents');f.sql.prepare("UPDATE repository_object_chunks SET data='Y29ycnVwdA==' WHERE ref=?").run(content.ref);await assert.rejects(store.get(content),/integrity/);});
test('publication leases exclude concurrent writers and fence an expired owner',async t=>{const f=fixture(t),one=f.client(),two=f.client();await one.call('lock',{changeId:'c',owner:'old'});one.lease={changeId:'c',owner:'old'};await assert.rejects(two.call('lock',{changeId:'c',owner:'new'}));f.sql.prepare('UPDATE repository_locks SET expires_at=0').run();await two.call('lock',{changeId:'c',owner:'new'});two.lease={changeId:'c',owner:'new'};await assert.rejects(one.save('record',{owner:'old'}));await two.save('record',{owner:'new'});assert.equal((await two.read('record')).owner,'new');});


test('private bridge bounds diagnostic lease duration and preserves ordinary default',async t=>{
 const f=fixture(t),store=f.client();
 await store.call('lock',{changeId:'normal',owner:'owner'});
 assert.ok(f.sql.prepare("SELECT expires_at-unixepoch() AS seconds FROM repository_locks WHERE change_id='normal'").get().seconds<=1200);
 await store.call('lock',{changeId:'long',owner:'owner',leaseSeconds:2700});
 assert.ok(f.sql.prepare("SELECT expires_at-unixepoch() AS seconds FROM repository_locks WHERE change_id='long'").get().seconds>=2699);
 for(const leaseSeconds of [0,-1,2701,1.5,'2700'])await assert.rejects(store.call('lock',{changeId:'invalid',owner:'owner',leaseSeconds}));
});

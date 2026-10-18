import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {nativeTasksForIdentity,flushNativeOutbox} from '../src/native-tasks.mjs';
import worker from '../src/index.mjs';
import {proxyApi} from '../src/ui/api.mjs';
function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  for(const file of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql','0023_native_tasks.sql','0024_repository_store.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const DB={prepare(query){let args=[];return {bind(...v){args=v;return this;},async first(){return sql.prepare(query).get(...args)??null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const env={DB,STANDALONE_CODEX_ENABLED:'true',CODEX_RUNTIME:{async execute(task){return {state:'completed',result:{operation:'codex_exec',taskId:task.taskId,billingMode:'included_subscription',exitCode:0,turnCompleted:true,threadId:'real-thread-test',commandCount:2,containerStopped:true}};}},DISPATCH_QUEUE:{sent:[],async send(body){this.sent.push(body);}}};
  const request=(method,path='',body,email='tester@from-trees.com')=>nativeTasksForIdentity(email,method,'/api/tasks'+path,body,env);
  async function create(title='Task'){const id=crypto.randomUUID();assert.equal((await request('POST','',{id,title,instructions:'Write and execute code',data:{project:'example'}})).status,201);return id;}
  const get=async id=>(await (await request('GET','/'+id)).json());
  const action=async(id,action,extra={})=>request('POST',`/${id}/${action}`,{version:(await get(id)).task.version,...extra});
  return {sql,env,request,create,get,action};
}
test('native capture auth, validation, idempotency, and optimistic editing',async t=>{
  const f=fixture(t);assert.equal((await f.request('GET','',null,'outsider@example.com')).status,403);
  assert.equal((await f.request('GET','/not-a-uuid')).status,400);
  assert.equal((await f.request('GET','/'+crypto.randomUUID())).status,404);
  const id=await f.create('<script>task</script>');const original=(await f.get(id)).task;
  assert.equal(original.state,'draft');assert.deepEqual(original.data,{project:'example'});
  const same={id,title:original.title,instructions:original.instructions,data:original.data};
  assert.equal((await f.request('POST','',same)).status,201);
  assert.equal((await f.request('POST','',{...same,title:'different'})).status,409);
  assert.equal((await f.request('POST',`/${id}/edit`,{...same,title:'Edited',version:1})).status,200);
  assert.equal((await f.request('POST',`/${id}/edit`,{...same,version:1})).status,409);
  assert.equal((await f.get(id)).task.title,'Edited');
});
test('dependencies reject self, missing nodes, cycles, and stale replacement without deleting edges',async t=>{
  const f=fixture(t),a=await f.create('A'),b=await f.create('B'),c=await f.create('C');
  assert.equal((await f.action(a,'dependencies',{dependencies:[a]})).status,400);
  assert.equal((await f.action(a,'dependencies',{dependencies:[crypto.randomUUID()]})).status,409);
  assert.equal((await f.action(a,'dependencies',{dependencies:[b]})).status,200);
  assert.equal((await f.action(b,'dependencies',{dependencies:[c]})).status,200);
  assert.equal((await f.action(c,'dependencies',{dependencies:[a]})).status,409);
  assert.equal((await f.request('POST',`/${a}/dependencies`,{version:1,dependencies:[]})).status,409);
  assert.deepEqual((await f.get(a)).dependencies.map(d=>d.id),[b]);
  assert.equal((await f.action(a,'ready')).status,200);
  assert.equal((await f.action(a,'dependencies',{dependencies:[]})).status,409);
});
test('dependency order, single execution slot, queue delivery, and independently retained D1 receipt',async t=>{
  const f=fixture(t),a=await f.create('Parent'),b=await f.create('Child');
  await f.action(b,'dependencies',{dependencies:[a]});await f.action(a,'ready');await f.action(b,'ready');
  assert.equal((await f.action(b,'start',{attempt_id:crypto.randomUUID()})).status,409);
  const run=crypto.randomUUID();assert.equal((await f.action(a,'start',{attempt_id:run})).status,202);
  assert.equal((await f.action(a,'start',{attempt_id:run})).status,202);
  assert.equal(f.env.DISPATCH_QUEUE.sent.length,1);
  assert.equal((await f.action(b,'start',{attempt_id:crypto.randomUUID()})).status,409);
  let ack=false;await worker.queue({messages:[{body:f.env.DISPATCH_QUEUE.sent[0],attempts:1,ack(){ack=true;},retry(){assert.fail('unexpected retry');}}]},f.env);assert.ok(ack);
  const record=await f.get(a);assert.equal(record.task.state,'completed');assert.equal(record.attempts[0].thread_id,'real-thread-test');assert.equal(record.attempts[0].url,`/tasks/${a}/attempts/${run}`);
  assert.deepEqual(record.events.map(e=>e.state),['queued','running','completed']);
  const stored=f.sql.prepare('SELECT result_json FROM standalone_tasks WHERE id=?').get(run);assert.equal(JSON.parse(stored.result_json).threadId,'real-thread-test');
  assert.equal((await f.action(a,'start',{attempt_id:crypto.randomUUID()})).status,409);
  assert.equal((await f.action(a,'cancel')).status,409);
  assert.equal((await f.action(b,'start',{attempt_id:crypto.randomUUID()})).status,202);
});
test('attempt IDs cannot attach another standalone execution; queue outbox recovers send failure',async t=>{
  const f=fixture(t),id=await f.create();await f.action(id,'ready');
  const foreign=crypto.randomUUID();f.sql.prepare("INSERT INTO standalone_tasks(id,instructions,state,executor) VALUES (?,'other','completed','codex')").run(foreign);
  assert.equal((await f.action(id,'start',{attempt_id:foreign})).status,409);assert.equal((await f.get(id)).attempts.length,0);
  const send=f.env.DISPATCH_QUEUE.send;f.env.DISPATCH_QUEUE.send=async()=>{throw Error('outage');};
  const run=crypto.randomUUID();assert.equal((await f.action(id,'start',{attempt_id:run})).status,202);assert.equal((await f.get(id)).task.state,'queued');
  f.env.DISPATCH_QUEUE.send=send;await flushNativeOutbox(f.env);assert.equal(f.env.DISPATCH_QUEUE.sent[0].taskId,run);
});
test('ambiguous native runtime fails closed and keeps the execution slot reserved',async t=>{
  const f=fixture(t),a=await f.create(),b=await f.create();await f.action(a,'ready');await f.action(b,'ready');
  f.env.CODEX_RUNTIME.execute=async()=>{throw Error('transport interrupted');};await f.action(a,'start',{attempt_id:crypto.randomUUID()});let retries=0;
  await worker.queue({messages:[{body:f.env.DISPATCH_QUEUE.sent[0],attempts:4,ack(){assert.fail('must retry to DLQ');},retry(){retries++;}}]},f.env);
  assert.equal(retries,1);assert.equal((await f.get(a)).task.state,'blocked');assert.equal((await f.action(b,'start',{attempt_id:crypto.randomUUID()})).status,409);
});
test('native UI proxy forwards verified identity and rejects cross-origin writes and oversized bodies',async()=>{
  let call;const env={CONTROL_PLANE:{async nativeTasks(...args){call=args;return {status:200,body:'{}'};}}};
  const identity={email:'tester@from-trees.com'};
  await proxyApi(new Request('https://ui/api/tasks'),env,identity);assert.deepEqual(call.slice(0,3),[identity.email,'GET','/api/tasks']);
  for(const [headers,body,status] of [[{origin:'https://evil', 'content-type':'application/json'},'{}',403],[{},'{}',415],[{'content-type':'application/json'},'x'.repeat(40001),413]])assert.equal((await proxyApi(new Request('https://ui/api/tasks',{method:'POST',headers,body}),env,identity)).status,status);
});
test('safe explicit retry retains separate attempts; stale starts cannot create extra runs',async t=>{
  const f=fixture(t),id=await f.create();await f.action(id,'ready');
  f.env.CODEX_RUNTIME.execute=async()=>({state:'failed',reason:'execution_failed',result:{containerStopped:true}});
  const oldVersion=(await f.get(id)).task.version,run=crypto.randomUUID();
  await f.action(id,'start',{attempt_id:run});
  await worker.queue({messages:[{body:f.env.DISPATCH_QUEUE.sent[0],attempts:1,ack(){},retry(){assert.fail('unexpected retry');}}]},f.env);
  assert.equal((await f.request('POST',`/${id}/start`,{version:oldVersion,attempt_id:run})).status,202);
  assert.equal((await f.request('POST',`/${id}/start`,{version:oldVersion,attempt_id:crypto.randomUUID()})).status,409);
  assert.equal((await f.action(id,'start',{attempt_id:crypto.randomUUID()})).status,202);
  assert.equal((await f.get(id)).attempts.length,2);
});
test('repository capabilities fail closed before admission and configured bindings reach the cloud runtime',async t=>{
  const f=fixture(t),id=await f.create();f.sql.prepare('UPDATE native_tasks SET data_json=? WHERE id=?').run(JSON.stringify({repositoryBinding:'example',reviewDescription:'Review body'}),id);await f.action(id,'ready');
  assert.equal((await f.action(id,'start',{attempt_id:crypto.randomUUID()})).status,503);assert.equal(f.env.DISPATCH_QUEUE.sent.length,0);
  f.env.CODEX_RUNTIME.repositoryCapabilities=async()=>({configured:true,canRework:true});
  const run=crypto.randomUUID();assert.equal((await f.action(id,'start',{attempt_id:run})).status,202);
  let received;f.env.CODEX_RUNTIME.execute=async task=>{received=task;return {state:'completed',result:{operation:'codex_exec',taskId:task.taskId,billingMode:'included_subscription',exitCode:0,turnCompleted:true,threadId:'thread',commandCount:1,containerStopped:true,repository:{binding:'example',executionId:run,canRework:true,publication:{state:'published',receipt:{review:{id:'1',url:'https://github.com/example/project/pull/1'}}}}}};};
  await worker.queue({messages:[{body:f.env.DISPATCH_QUEUE.sent[0],attempts:1,ack(){},retry(){assert.fail();}}]},f.env);assert.equal(received.repositoryBinding,'example');assert.equal(received.logicalTaskId,id);
  const revised=crypto.randomUUID();assert.equal((await f.action(id,'rework',{attempt_id:revised,reason:'resolve_conflicts',instructions:'Resolve the conflicts and rerun tests.'})).status,202);
  const saved=f.sql.prepare('SELECT a.rework_reason,s.instructions FROM native_task_attempts a JOIN standalone_tasks s ON s.id=a.id WHERE a.id=?').get(revised);assert.equal(saved.rework_reason,'resolve_conflicts');assert.match(saved.instructions,/Original|Write and execute code/);assert.match(saved.instructions,/Resolve the conflicts/);
});
test('publication retry queues a distinct job while preserving the completed execution receipt',async t=>{
  const f=fixture(t),id=await f.create();await f.action(id,'ready');const run=crypto.randomUUID();await f.action(id,'start',{attempt_id:run});
  f.sql.prepare("UPDATE standalone_tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify({taskId:run,threadId:'original-thread',exitCode:0,repository:{binding:'example',publication:{state:'blocked',reason:'provider_transport_unknown'}}}),run);
  f.env.CODEX_RUNTIME.execute=async task=>({state:'completed',result:{taskId:task.executionId,containerStopped:true,repository:{binding:'example',publication:{state:'published',receipt:{review:{id:'1',url:'https://github.com/example/project/pull/1'}}}}}});
  const job=crypto.randomUUID();assert.equal((await f.action(id,'publish',{attempt_id:run,publication_id:job})).status,202);assert.equal((await f.action(id,'publish',{attempt_id:run,publication_id:crypto.randomUUID()})).status,409);
  await worker.queue({messages:[{body:{type:'native_repository_publish',taskId:job},attempts:1,ack(){},retry(){assert.fail();}}]},f.env);
  const saved=JSON.parse(f.sql.prepare('SELECT result_json FROM standalone_tasks WHERE id=?').get(run).result_json);assert.equal(saved.threadId,'original-thread');assert.equal(saved.repository.publication.state,'published');
});

test('interrupted execution identity and safe progress survive Queue processing, D1 and the task API without completion',async t=>{
  const f=fixture(t),id=await f.create('Interrupted work');await f.action(id,'ready');
  const progress={threadId:'33333333-3333-4333-8333-333333333333',commandCount:1,executionProgress:{elapsedMs:300000,lastCommand:{hint:'pnpm_test',status:'running',elapsedMs:100000}},containerStopped:true,containerStopForced:false};
  let runs=0;f.env.CODEX_RUNTIME.execute=async()=>{runs++;return {state:'blocked',reason:'execution_timeout',result:progress};};
  const attempt=crypto.randomUUID();await f.action(id,'start',{attempt_id:attempt});let acked=false;
  await worker.queue({messages:[{body:f.env.DISPATCH_QUEUE.sent[0],attempts:1,ack(){acked=true;},retry(){assert.fail('Do not replay interrupted Codex');}}]},f.env);
  assert.equal(runs,1);assert.equal(acked,true);
  const record=await f.get(id);assert.equal(record.task.state,'blocked');assert.equal(record.attempts[0].thread_id,progress.threadId);assert.deepEqual(record.attempts[0].result,progress);assert.equal(record.attempts[0].error,'Cloud runtime: execution_timeout');
  const stored=f.sql.prepare('SELECT state,result_json FROM standalone_tasks WHERE id=?').get(attempt);assert.equal(stored.state,'blocked');assert.deepEqual(JSON.parse(stored.result_json),progress);
});

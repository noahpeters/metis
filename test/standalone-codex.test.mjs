import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {executeStandaloneCodex} from '../src/standalone-codex.mjs';
import {executeOnce} from '../runtime/cloud/execution-ledger.mjs';
import worker from '../src/index.mjs';

function fixture(t) {
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  for(const file of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let failCompletion=false;
  const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async run(){if(failCompletion&&sql.includes('result_json=?'))throw new Error('D1 unavailable');return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};}};
  const result={operation:'codex_exec',taskId:'123',exitCode:0,turnCompleted:true,threadId:'actual-thread',commandCount:2,finalMessage:'Verified',billingMode:'included_subscription',artifacts:[]};
  const receipts=[];
  const env={DB,STANDALONE_DISPATCH_TOKEN:'submit-token',STANDALONE_CODEX_ENABLED:'true',CODEX_RUNTIME:{async execute(task){receipts.push(task);return {state:'completed',result};}},DISPATCH_QUEUE:{sent:[],async send(body){this.sent.push(body);}}};
  const insert=(id='123')=>sqlite.prepare("INSERT INTO standalone_tasks(id,instructions,state,executor) VALUES (?,'Implement and verify a function','queued','codex')").run(id);
  const post=body=>worker.fetch(new Request('https://example.com/v1/standalone/tasks',{method:'POST',headers:{authorization:'Bearer submit-token'},body:JSON.stringify(body)}),env);
  return {sqlite,env,insert,result,receipts,post,setFailure(value){failCompletion=value;}};
}
test('real execution admission is explicit and disabled without cloud runtime',async t=>{
  const f=fixture(t);
  delete f.env.STANDALONE_CODEX_ENABLED;
  assert.equal((await f.post({instructions:'do work',executor:'codex'})).status,503);
  assert.equal(f.env.DISPATCH_QUEUE.sent.length,0);
  assert.equal((await f.post({instructions:'do work',executor:'other'})).status,400);
  assert.equal((await f.post({instructions:'proof unchanged'})).status,202);
  assert.equal(f.env.DISPATCH_QUEUE.sent[0].type,'standalone_proof');
});
test('Codex submission persists its executor and uses separate queue message',async t=>{
  const f=fixture(t);const r=await f.post({instructions:'do real work',executor:'codex'});assert.equal(r.status,202);
  const {id}=await r.json();assert.equal(f.sqlite.prepare('SELECT executor FROM standalone_tasks WHERE id=?').get(id).executor,'codex');
  assert.deepEqual(f.env.DISPATCH_QUEUE.sent,[{type:'standalone_codex',taskId:id}]);
});
test('cloud receipt is persisted independently in D1 and API exposes execution evidence',async t=>{
  const f=fixture(t);f.insert();await executeStandaloneCodex(f.env,'123');
  const row=f.sqlite.prepare('SELECT * FROM standalone_tasks WHERE id=?').get('123');assert.equal(row.state,'completed');assert.deepEqual(JSON.parse(row.result_json),f.result);
  assert.deepEqual(f.sqlite.prepare('SELECT state FROM standalone_task_events ORDER BY sequence').all().map(r=>r.state),['queued','running','completed']);
  const response=await worker.fetch(new Request('https://example.com/v1/standalone/tasks/123',{headers:{authorization:'Bearer submit-token'}}),f.env);
  assert.deepEqual((await response.json()).result,f.result);
  await executeStandaloneCodex(f.env,'123');assert.equal(f.receipts.length,1);
});
test('missing command evidence cannot be labeled completed',async t=>{
  const f=fixture(t);f.insert();f.result.commandCount=0;
  await assert.rejects(executeStandaloneCodex(f.env,'123',4));
  assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks').get().state,'blocked');
});
test('runtime failures and lost D1 writes retry the same durable task identity',async t=>{
  const f=fixture(t);f.insert();f.setFailure(true);
  await assert.rejects(executeStandaloneCodex(f.env,'123'));f.setFailure(false);
  await executeStandaloneCodex(f.env,'123',2);assert.equal(f.receipts.length,2);assert.deepEqual(f.receipts[0],f.receipts[1]);
  assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks').get().state,'completed');
});
test('runtime blocked state and disabled execution remain first class',async t=>{
  const f=fixture(t);f.insert();f.env.CODEX_RUNTIME.execute=async()=>({state:'blocked',reason:'subscription_auth_missing'});
  await executeStandaloneCodex(f.env,'123');assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks').get().state,'blocked');
  f.insert('456');f.env.STANDALONE_CODEX_ENABLED='false';await executeStandaloneCodex(f.env,'456');assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks WHERE id=?').get('456').state,'blocked');
});
test('durable runtime ledger never launches accepted work twice after restart',async()=>{
  const data=new Map();const storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
  const task={taskId:'123',instructions:'do real work'};let calls=0;
  const run=async()=>{calls++;return {state:'completed',result:{some:'evidence'}};};
  const result=await executeOnce(storage,task,run);assert.deepEqual(await executeOnce(storage,task,run),result);assert.equal(calls,1);
  assert.equal((await executeOnce(storage,{...task,instructions:'different'},run)).reason,'task_identity_conflict');
  data.set('task:123',{identity:JSON.stringify(task)});
  assert.equal((await executeOnce(storage,task,run)).reason,'execution_acceptance_ambiguous');assert.equal(calls,1);
});
test('ambiguous runtime transport does not trigger a second execution',async()=>{
  const data=new Map();const storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};let calls=0;
  const task={taskId:'x',instructions:'work'};
  const run=async()=>{calls++;throw new Error('connection lost after spawn');};
  assert.equal((await executeOnce(storage,task,run)).state,'blocked');
  assert.equal((await executeOnce(storage,task,run)).state,'blocked');assert.equal(calls,1);
});

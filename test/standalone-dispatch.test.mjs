import {test} from "node:test";
import {strict as assert} from "node:assert";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import worker from "../src/index.mjs";

const token = 'test-only-token';
const instructions = 'Echo this deterministic proof; do not execute code.';
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  t.after(() => sqlite.close());
  const faults = {completion:0, claim:0};
  const DB = {prepare(sql) {
    let args = [];
    return {bind(...values) {args=values;return this;}, async first() {return sqlite.prepare(sql).get(...args) ?? null;}, async run() {
      if (sql.includes("state='completed'") && faults.completion-- > 0) throw new Error('injected write failure');
      if (sql.includes("SET state='running'") && faults.claim-- > 0) throw new Error('injected claim failure');
      return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};
    }};
  }};
  const sent = [];
  const env = {DB,STANDALONE_DISPATCH_TOKEN:token,DISPATCH_QUEUE:{async send(body) {sent.push(body);}}};
  const request = (path='', {auth=token, method='GET', body}={}) => worker.fetch(new Request(`https://example.com/v1/standalone/tasks${path}`, {method, headers:auth ? {authorization:`Bearer ${auth}`} : {},body:body === undefined ? undefined : JSON.stringify(body)}),env);
  const submit = () => request('',{method:'POST',body:{instructions}});
  async function deliver(body, attempts=1) {
    const calls = [];
    await worker.queue({messages:[{id:'test-message',body,attempts,ack(){calls.push('ack');},retry(){calls.push('retry');}}]},env);
    return calls;
  }
  return {sqlite,env,request,submit,sent,deliver,faults};
}
test('standalone auth fails closed for submission and status', async t => {
  const f=fixture(t);
  for (const auth of [null,'incorrect']) {
    assert.equal((await f.request('',{method:'POST',auth,body:{instructions}})).status,401);
    assert.equal((await f.request('/00000000-0000-4000-8000-000000000000',{auth})).status,401);
  }
  delete f.env.STANDALONE_DISPATCH_TOKEN;
  assert.equal((await f.submit()).status,401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM standalone_tasks').get().n,0);
  assert.equal(f.sent.length,0);
});
test('standalone validates input and invalid/unknown task IDs', async t => {
  const f=fixture(t);
  for (const body of [{instructions:''},{instructions:'  '},{instructions:7},{instructions:'x'.repeat(10001)}]) assert.equal((await f.request('',{method:'POST',body})).status,400);
  assert.equal((await worker.fetch(new Request('https://example.com/v1/standalone/tasks',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{' }),f.env)).status,400);
  for (const id of ['not-a-task','00000000-0000-4000-8000-000000000000',"abc%27"]) assert.equal((await f.request('/'+id)).status,404);
  assert.deepEqual(await f.deliver({type:'standalone_proof',taskId:'missing'}),['ack']);
});
test('submission, consumer, D1 result and status are independently consistent', async t => {
  const f=fixture(t);const response=await f.submit();assert.equal(response.status,202);
  const {id}=await response.json();
  assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks WHERE id=?').get(id).state,'queued');
  assert.equal((await (await f.request('/'+id)).json()).result,null);
  assert.deepEqual(f.sent,[{type:'standalone_proof',taskId:id}]);
  assert.deepEqual(await f.deliver(f.sent[0]),['ack']);
  const row=f.sqlite.prepare('SELECT * FROM standalone_tasks WHERE id=?').get(id);
  const result=JSON.parse(row.result_json);
  assert.equal(row.state,'completed');assert.equal(row.artifact_key,null);
  assert.deepEqual(result,{operation:'standalone_proof',version:1,taskId:id,instructions,executedAt:new Date(row.execution_started_at*1000).toISOString(),status:'completed'});
  assert.ok(row.updated_at>=row.created_at);
  assert.deepEqual(f.sqlite.prepare('SELECT state FROM standalone_task_events WHERE task_id=? ORDER BY sequence').all(id).map(r=>r.state),['queued','running','completed']);
  const status=await (await f.request('/'+id)).json();assert.deepEqual(status.result,result);
  assert.deepEqual(await f.deliver(f.sent[0],2),['ack']);
  assert.equal(f.sqlite.prepare('SELECT result_json FROM standalone_tasks WHERE id=?').get(id).result_json,row.result_json);
});
test('transient persistence failure retries and completes with stable execution timestamp', async t => {
  const f=fixture(t);const {id}=await (await f.submit()).json();f.faults.completion=1;
  assert.deepEqual(await f.deliver(f.sent[0]),['retry']);
  const row=f.sqlite.prepare('SELECT * FROM standalone_tasks WHERE id=?').get(id);assert.equal(row.state,'queued');assert.equal(row.result_json,null);
  assert.deepEqual(await f.deliver(f.sent[0],2),['ack']);
  const completed=f.sqlite.prepare('SELECT * FROM standalone_tasks WHERE id=?').get(id);assert.equal(completed.state,'completed');assert.equal(completed.error,null);
  assert.equal(completed.execution_started_at,row.execution_started_at);
});
test('retry exhaustion records failure and requests final redelivery to configured DLQ', async t => {
  const f=fixture(t);const {id}=await (await f.submit()).json();f.faults.completion=4;
  for (let attempt=1;attempt<=4;attempt++) assert.deepEqual(await f.deliver(f.sent[0],attempt),['retry']);
  const row=f.sqlite.prepare('SELECT * FROM standalone_tasks WHERE id=?').get(id);assert.equal(row.state,'failed');assert.equal(row.result_json,null);
  assert.equal((await (await f.request('/'+id)).json()).state,'failed');
});
test('claim failures retry; active leases retry; expired leases recover', async t => {
  const f=fixture(t);const {id}=await (await f.submit()).json();f.faults.claim=1;
  assert.deepEqual(await f.deliver(f.sent[0]),['retry']);
  f.sqlite.prepare("UPDATE standalone_tasks SET state='running',claim_token='crashed' WHERE id=?").run(id);
  assert.deepEqual(await f.deliver(f.sent[0],2),['retry']);
  f.sqlite.prepare('UPDATE standalone_tasks SET updated_at=unixepoch()-61 WHERE id=?').run(id);
  assert.deepEqual(await f.deliver(f.sent[0],3),['ack']);
  assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks WHERE id=?').get(id).state,'completed');
});
test('queue submission failure returns an inspectable failed D1 task', async t => {
  const f=fixture(t);f.env.DISPATCH_QUEUE.send=async()=>{throw new Error('queue unavailable');};
  const response=await f.submit();assert.equal(response.status,503);const {id}=await response.json();
  assert.equal(f.sqlite.prepare('SELECT state FROM standalone_tasks WHERE id=?').get(id).state,'failed');
});

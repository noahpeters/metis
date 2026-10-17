// Manual cloud acceptance test. Requires separately approved deployed runtime,
// freshly provisioned subscription auth, and standalone admission enabled.
import assert from 'node:assert/strict';
import {randomBytes,randomInt,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const token=process.env.STANDALONE_DISPATCH_TOKEN;
assert.ok(token,'Provide STANDALONE_DISPATCH_TOKEN securely through the environment');
const base=process.env.STANDALONE_BASE_URL||'https://metis-control-plane.gr4gwzrfq2.workers.dev';
const values=Array.from({length:8},()=>randomInt(-1000,1000));const nonce=randomBytes(16).toString('hex');
const instructions=`Implement solution.mjs with an exported function summarize(values, nonce). It must return an object with count (length), sum, sorted (numeric ascending), and nonceSha256 (hex SHA256 of the nonce UTF-8 bytes). Use Node to test it, call it on ${JSON.stringify(values)} and nonce ${JSON.stringify(nonce)}, and write exactly that returned JSON object into result.json. Verify the files and report your tests. Do the work by running commands; don't just describe or echo it.`;
const expected={count:values.length,sum:values.reduce((a,b)=>a+b,0),sorted:[...values].sort((a,b)=>a-b),nonceSha256:createHash('sha256').update(nonce).digest('hex')};
async function api(path,options={}) {return fetch(`${base}/v1/standalone/tasks${path}`,{...options,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},signal:AbortSignal.timeout(15000)});}
const response=await api('',{method:'POST',body:JSON.stringify({instructions,executor:'codex',verification:'numeric_summary_v1'})});
assert.equal(response.status,202,'Cloud Codex submission was not accepted');
const {id}=await response.json();assert.match(id,/^[0-9a-f-]{36}$/);
console.log('Submitted real cloud Codex task '+id);
let task;
for(let i=0;i<180;i++) {
  const response=await api('/'+id);assert.equal(response.status,200);task=await response.json();
  if(['completed','blocked','failed'].includes(task.state))break;
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.equal(task?.state,'completed','Cloud task blocked, failed, or timed out; inspect the task record');
const result=task.result;assert.equal(result.operation,'codex_exec');assert.equal(result.billingMode,'included_subscription');assert.equal(result.taskId,id);assert.equal(result.exitCode,0);assert.equal(result.turnCompleted,true);assert.ok(result.threadId);assert.ok(result.commandCount>0);
assert.equal(result.verification?.kind,'numeric_summary_v1');assert.equal(result.verification.passed,true);
for(const entry of result.verification.cases)assert.deepEqual(entry.actual,{count:entry.values.length,sum:entry.values.reduce((a,b)=>a+b,0),sorted:[...entry.values].sort((a,b)=>a-b),nonceSha256:createHash('sha256').update(entry.nonce).digest('hex')});
const artifact=result.artifacts.find(file=>file.name==='result.json');const solution=result.artifacts.find(file=>file.name==='solution.mjs');
assert.ok(artifact&&solution,'Codex did not produce the required files');
for(const file of [artifact,solution])assert.equal(file.sha256,createHash('sha256').update(file.content).digest('hex'));
assert.deepEqual(JSON.parse(artifact.content),expected,'Independent verifier rejected the computed result');
function query(sql) {
  const output=execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--remote','--json','--command',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const batches=JSON.parse(output);assert.ok(batches.every(batch=>batch.success));return batches.flatMap(batch=>batch.results);
}
const [row]=query(`SELECT id,instructions,state,executor,result_json,created_at,updated_at FROM standalone_tasks WHERE id='${id}'`);
assert.ok(row);assert.equal(row.executor,'codex');assert.equal(row.state,'completed');assert.equal(row.instructions,instructions);assert.deepEqual(JSON.parse(row.result_json),result);
const events=query(`SELECT state,created_at FROM standalone_task_events WHERE task_id='${id}' ORDER BY sequence`);assert.deepEqual(events.map(event=>event.state),['queued','running','completed']);
console.log(JSON.stringify({verified:true,taskId:id,executor:'cloud_codex_cli',threadId:result.threadId,commandCount:result.commandCount,artifactHashes:[artifact,solution].map(({name,sha256})=>({name,sha256})),events},null,2));

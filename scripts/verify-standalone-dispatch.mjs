// Manual, post-approval experiment. Never called by CI or deployment.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const token=process.env.STANDALONE_DISPATCH_TOKEN;
assert.ok(token,'Provide STANDALONE_DISPATCH_TOKEN through the environment');
const base=process.env.STANDALONE_BASE_URL || 'https://metis-control-plane.gr4gwzrfq2.workers.dev';
const instructions='Metis deterministic standalone D1 proof v1';
async function api(path,options={}) {
  return fetch(`${base}/v1/standalone/tasks${path}`,{...options,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},signal:AbortSignal.timeout(15000)});
}
const submitted=await api('',{method:'POST',body:JSON.stringify({instructions})});
assert.equal(submitted.status,202,'Task submission failed');
const {id}=await submitted.json();
assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
console.log(`Submitted task ${id}`);
let task;
for(let attempt=0;attempt<120;attempt++) {
  const response=await api(`/${id}`);assert.equal(response.status,200);
  task=await response.json();
  if(task.state==='completed' || task.state==='failed')break;
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.equal(task?.state,'completed','Task did not complete within two minutes');
// Independent remote SELECTs, not an API completion assertion alone. Use a
// validated UUID and avoid shell interpolation or logging credentials.
function query(sql) {
  const output=execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--remote','--json','--command',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const batches=JSON.parse(output);assert.ok(batches.every(batch=>batch.success));
  return batches.flatMap(batch=>batch.results);
}
const [row]=query(`SELECT id,instructions,state,result_json,execution_started_at,created_at,updated_at,artifact_key FROM standalone_tasks WHERE id='${id}'`);
assert.ok(row,'D1 row is missing');assert.equal(row.id,id);assert.equal(row.state,'completed');assert.equal(row.instructions,instructions);
const result=JSON.parse(row.result_json);
assert.deepEqual(result,{operation:'standalone_proof',version:1,taskId:id,instructions,executedAt:new Date(row.execution_started_at*1000).toISOString(),status:'completed'});
assert.deepEqual(result,task.result);assert.equal(row.artifact_key,null);
assert.ok(row.execution_started_at>=row.created_at);assert.ok(row.updated_at>=row.execution_started_at);
const events=query(`SELECT state,created_at FROM standalone_task_events WHERE task_id='${id}' ORDER BY sequence`);
assert.equal(events[0]?.state,'queued');assert.equal(events.at(-1)?.state,'completed');assert.ok(events.some(event=>event.state==='running'));
console.log(JSON.stringify({verified:true,id,state:row.state,result,events},null,2));

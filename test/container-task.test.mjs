import test from 'node:test';
import assert from 'node:assert/strict';
import {executeContainerTask,stopContainerAndConfirm} from '../runtime/cloud/container-task.mjs';
const task={taskId:'t',instructions:'work'};
function controller(overrides={}){return {startAndWaitForPorts:async()=>{},containerFetch:async()=>Response.json({state:'completed',result:{taskId:'t'}}),stop:async()=>{},destroy:async()=>{},getState:async()=>({status:'stopped'}),...overrides};}
test('container lifecycle distinguishes startup, request, response and shutdown failures without raw exception text',async()=>{
  for(const [overrides,reason] of [
    [{startAndWaitForPorts:async()=>{throw Error('maximum container instances: secret-token');}},'container_startup_capacity'],
    [{startAndWaitForPorts:async()=>{throw Error('No container instance available');}},'container_startup_unavailable'],
    [{containerFetch:async()=>{throw Error('connection reset: secret-token');}},'container_request_connection'],
    [{containerFetch:async()=>new Response('{invalid')},'container_response_unknown'],
    [{stop:async()=>{throw Error('connection reset: secret-token');},destroy:async()=>{throw Error('connection reset: secret-token');}},'container_shutdown_connection'],
    [{containerFetch:async()=>new Response('',{status:503})},'container_http_503']]){
    const receipt=await executeContainerTask(controller(overrides),task,'secret-token');assert.equal(receipt.state,'blocked');assert.equal(receipt.reason,reason);assert.doesNotMatch(JSON.stringify(receipt),/secret-token/);
  }
});
test('cold instance acquisition gets its own bounded window before port readiness',async()=>{
  let options;
  const receipt=await executeContainerTask(controller({startAndWaitForPorts:async value=>{options=value;}}),task,'auth');
  assert.equal(receipt.state,'completed');
  assert.deepEqual(options.cancellationOptions,{instanceGetTimeoutMS:60000,portReadyTimeoutMS:30000});
});
test('failed cleanup does not mask the original startup failure, and successful receipts are preserved',async()=>{
  let stops=0;
  const failed=await executeContainerTask(controller({startAndWaitForPorts:async()=>{throw Error('timeout');},stop:async()=>{stops++;throw Error('closed');}}),task,'auth');
  assert.equal(failed.reason,'container_startup_timeout');assert.equal(stops,1);
  assert.deepEqual(await executeContainerTask(controller(),task,'auth'),{state:'completed',result:{taskId:'t',containerStopped:true,containerStopForced:false}});
});
test('SIGTERM returning with a healthy container must force termination and confirm release',async()=>{
  let running=true;let destroyed=0;
  const cleanup=await stopContainerAndConfirm(controller({getState:async()=>({status:running?'healthy':'stopped'}),destroy:async()=>{destroyed++;running=false;}}),{delay:async()=>{},graceMs:200,forceMs:200});
  assert.equal(cleanup.forced,true);assert.equal(destroyed,1);assert.equal(running,false);
  await assert.rejects(stopContainerAndConfirm(controller({getState:async()=>({status:'healthy'})}),{delay:async()=>{},graceMs:0,forceMs:0}),/shutdown_not_confirmed/);
});

test('long repository execution extends the request deadline while standalone proofs keep their deadline',async t=>{
  const values=[];t.mock.method(AbortSignal,'timeout',ms=>{values.push(ms);return new AbortController().signal;});
  await executeContainerTask(controller(),task,'auth',{executionTimeoutMs:600000});
  await executeContainerTask(controller(),task,'auth',{readOnlyDiagnostic:true,executionTimeoutMs:2100000});
  await executeContainerTask(controller(),task,'auth');
  assert.deepEqual(values,[780000,2280000,120000]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {executeContainerTask} from '../runtime/cloud/container-task.mjs';
const task={taskId:'t',instructions:'work'};
function controller(overrides={}){return {startAndWaitForPorts:async()=>{},containerFetch:async()=>Response.json({state:'completed',result:{taskId:'t'}}),stop:async()=>{},...overrides};}
test('container lifecycle distinguishes startup, request, response and shutdown failures without raw exception text',async()=>{
  for(const [overrides,reason] of [
    [{startAndWaitForPorts:async()=>{throw Error('maximum container instances: secret-token');}},'container_startup_capacity'],
    [{containerFetch:async()=>{throw Error('connection reset: secret-token');}},'container_request_connection'],
    [{containerFetch:async()=>new Response('{invalid')},'container_response_unknown'],
    [{stop:async()=>{throw Error('connection reset: secret-token');}},'container_shutdown_connection'],
    [{containerFetch:async()=>new Response('',{status:503})},'container_http_503']]){
    const receipt=await executeContainerTask(controller(overrides),task,'secret-token');assert.equal(receipt.state,'blocked');assert.equal(receipt.reason,reason);assert.doesNotMatch(JSON.stringify(receipt),/secret-token/);
  }
});
test('failed cleanup does not mask the original startup failure, and successful receipts are preserved',async()=>{
  let stops=0;
  const failed=await executeContainerTask(controller({startAndWaitForPorts:async()=>{throw Error('timeout');},stop:async()=>{stops++;throw Error('closed');}}),task,'auth');
  assert.equal(failed.reason,'container_startup_timeout');assert.equal(stops,1);
  assert.deepEqual(await executeContainerTask(controller(),task,'auth'),{state:'completed',result:{taskId:'t'}});
});

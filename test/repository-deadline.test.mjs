import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryExecutionTimeoutMs,repositoryRequestTimeoutMs,repositorySleepAfter,repositoryLeaseSeconds,repositoryCapabilitySeconds} from '../runtime/repositories/deadline.mjs';

test('binding deadlines preserve defaults, accept a ten-minute opt-in and stay within lease/capability lifetimes',()=>{
  for(const [value,expected] of [[undefined,90000],[NaN,90000],['600000',90000],[1.5,90000],[-1,1000],[300000,300000],[600000,600000],[Number.MAX_SAFE_INTEGER,600000]]){
    const config={executionTimeoutMs:value};assert.equal(repositoryExecutionTimeoutMs(config),expected);
    const request=repositoryRequestTimeoutMs(config);assert.ok(request>=expected+180000);assert.ok(request<1200000);assert.ok(request<1800000);
    assert.ok(Number.parseInt(repositorySleepAfter(config))*60000>request);
  }
  assert.equal(repositoryRequestTimeoutMs({executionTimeoutMs:600000}),780000);
  assert.equal(repositorySleepAfter({executionTimeoutMs:600000}),'15m');
});


test('private read-only diagnostic allows a thirty-minute check with overhead and durable lifetimes',()=>{
 const config={readOnlyDiagnostic:true,executionTimeoutMs:2100000};
 assert.equal(repositoryExecutionTimeoutMs(config),2100000);
 assert.equal(repositoryExecutionTimeoutMs({...config,executionTimeoutMs:Number.MAX_SAFE_INTEGER}),2100000);
 assert.equal(repositoryRequestTimeoutMs(config),2280000);
 assert.equal(repositorySleepAfter(config),'40m');
 assert.equal(repositoryLeaseSeconds(config),2700);
 assert.equal(repositoryCapabilitySeconds(config),3000);
 assert.ok(repositoryRequestTimeoutMs(config)<repositoryLeaseSeconds(config)*1000);
 assert.ok(repositoryLeaseSeconds(config)<repositoryCapabilitySeconds(config));
 for(const readOnlyDiagnostic of [false,undefined,'true',1]){
  const ordinary={readOnlyDiagnostic,executionTimeoutMs:2100000};
  assert.equal(repositoryExecutionTimeoutMs(ordinary),600000);
  assert.equal(repositoryLeaseSeconds(ordinary),1200);
  assert.equal(repositoryCapabilitySeconds(ordinary),1800);
 }
});

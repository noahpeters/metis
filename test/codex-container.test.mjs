import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {runCodex,parseEvents,cliEnvironment,validateSubscriptionAuth} from '../runtime/container/execute.mjs';
const auth=JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:'test-access-token',id_token:'test-id-token',refresh_token:'test-refresh-token'}});
const events=[{type:'thread.started',thread_id:'codex-thread'},{type:'item.completed',item:{type:'command_execution',status:'completed',exit_code:0}},{type:'item.completed',item:{type:'agent_message',text:'Implemented and tested'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
function fakeSpawn({exit=0,stream=events,action=async()=>{}}={}) {
  return (bin,args,options)=>{
    assert.equal(bin,'codex');assert.ok(args.includes('workspace-write'));assert.ok(args.includes('forced_login_method="chatgpt"'));
    assert.ok(!Object.keys(options.env).some(name=>/API_KEY|DISPATCH_TOKEN|GITHUB|CLOUDFLARE/.test(name)));
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.kill=()=>{child.emit('close',-1);return true;};
    child.stdin.on('finish',()=>{(async()=>{
      await action(options);
      child.stdout.write(stream.map(event=>JSON.stringify(event)).join('\n')+'\n');child.emit('close',exit);
    })().catch(error=>child.emit('error',error));});
    return child;
  };
}
test('runtime rejects API key, missing and non-subscription credentials',()=>{
  for(const value of ['{}','invalid',JSON.stringify({OPENAI_API_KEY:'api-key'}),JSON.stringify({auth_mode:'api_key',tokens:{access_token:'x',id_token:'y'}})])assert.throws(()=>validateSubscriptionAuth(value));
  assert.ok(validateSubscriptionAuth(auth));assert.equal(cliEnvironment('/auth').CODEX_HOME,'/auth');
});
test('runtime captures real CLI event structure and artifact hashes; deletes temporary auth',async()=>{
  let authDir;
  const receipt=await runCodex({taskId:'123',instructions:'write code and verify it'},auth,{spawnProcess:fakeSpawn({action:async options=>{
    authDir=options.env.CODEX_HOME;assert.equal(JSON.parse(await readFile(join(authDir,'auth.json'),'utf8')).auth_mode,'chatgpt');
    await writeFile(join(options.cwd,'result.json'),'{"sum":7}');await writeFile(join(options.cwd,'solution.mjs'),'export const sum = (a,b) => a+b;');
  }})});
  assert.equal(receipt.state,'completed');assert.equal(receipt.result.operation,'codex_exec');assert.equal(receipt.result.threadId,'codex-thread');assert.equal(receipt.result.commandCount,1);
  assert.equal(receipt.result.artifacts.length,2);assert.match(receipt.result.artifacts[0].sha256,/^[a-f0-9]{64}$/);assert.equal(receipt.result.billingMode,'included_subscription');
  await assert.rejects(access(authDir));assert.doesNotMatch(JSON.stringify(receipt),/test-access-token/);
});
test('an echo, failed turn, failed command, nonzero exit or malformed events cannot pass',async()=>{
  for(const options of [{stream:[{type:'turn.completed'}]},{stream:[...events,{type:'turn.failed'}]},{stream:events.filter(e=>e.item?.type!=='command_execution')},{exit:1}]) {
    const result=await runCodex({taskId:'t',instructions:'work'},auth,{spawnProcess:fakeSpawn(options)});assert.equal(result.state,'blocked');
  }
  assert.throws(()=>parseEvents('this is not JSON'));
});
test('model cannot force arbitrary artifacts or return a symlink to auth',async()=>{
  const {symlink}=await import('node:fs/promises');
  const receipt=await runCodex({taskId:'t',instructions:'work'},auth,{spawnProcess:fakeSpawn({action:async options=>{
    await symlink(join(options.env.CODEX_HOME,'auth.json'),join(options.cwd,'result.json'));
    await writeFile(join(options.cwd,'solution.mjs'),'x'.repeat(13000));
  }})});
  assert.equal(receipt.state,'completed');assert.deepEqual(receipt.result.artifacts,[]);
});

test('independent fresh-input verifier executes generated code and rejects a fake implementation',async()=>{
  const code="import {createHash} from 'node:crypto'; export function summarize(values,nonce){return {count:values.length,sum:values.reduce((a,b)=>a+b,0),sorted:[...values].sort((a,b)=>a-b),nonceSha256:createHash('sha256').update(nonce).digest('hex')};}";
  const task={taskId:'t',instructions:'implement summarize',verification:'numeric_summary_v1'};
  const good=await runCodex(task,auth,{spawnProcess:fakeSpawn({action:async options=>writeFile(join(options.cwd,'solution.mjs'),code)})});
  assert.equal(good.state,'completed');assert.equal(good.result.verification.passed,true);assert.equal(good.result.verification.cases.length,2);
  const fake=await runCodex(task,auth,{spawnProcess:fakeSpawn({action:async options=>writeFile(join(options.cwd,'solution.mjs'),'export function summarize(){return {count:0,sum:0,sorted:[],nonceSha256:"fake"}}')})});
  assert.equal(fake.state,'failed');assert.equal(fake.reason,'independent_code_verification_failed');
});
test('credential echoes are rejected instead of being saved as task results',async()=>{
  const receipt=await runCodex({taskId:'t',instructions:'work'},auth,{spawnProcess:fakeSpawn({stream:[...events,{type:'item.completed',item:{type:'agent_message',text:'test-access-token'}}]})});
  assert.equal(receipt.state,'blocked');assert.equal(receipt.reason,'credential_output_rejected');assert.doesNotMatch(JSON.stringify(receipt),/test-access-token/);
});

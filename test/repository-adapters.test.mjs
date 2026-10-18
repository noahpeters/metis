import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {FileRepositoryStore} from '../runtime/repositories/store.mjs';
import {createGitHubAdapter,createArtifactsAdapter} from '../runtime/repositories/adapter.mjs';
import {publicationIntent} from '../src/repository-adapters/contract.mjs';
import {png} from './fixtures/review-png.mjs';
import {changeSetDigest} from '../src/repository-adapters/contract.mjs';
import {runRepositoryTask} from '../runtime/repositories/run.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'},encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
async function fixture(t,kind='github'){
  const root=await mkdtemp(join(tmpdir(),'metis-adapter-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const origin=join(root,'origin.git'),seed=join(root,'seed'),workspace=join(root,'workspace');await mkdir(seed);await mkdir(workspace);git(root,'init','--bare',origin);git(seed,'init','-b','main');await writeFile(join(seed,'AGENTS.md'),'Use tests.');await writeFile(join(seed,'app.txt'),'original\n');await writeFile(join(seed,'.gitignore'),'ignored/\n');git(seed,'add','.');git(seed,'commit','-m','base');git(seed,'remote','add','origin',origin);git(seed,'push','origin','main');
  const store=await new FileRepositoryStore(join(root,'durable')).init(),source={adapter:kind,repository:'example/project',ref:'main'},reviews=[],comments=[];let createCalls=0,loseCreate=false;
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url),body=options.body?JSON.parse(options.body):null;let data;
    if(kind==='github'){
      if(u.pathname==='/repos/example/project')data={private:false,full_name:source.repository};
      else if(u.pathname.endsWith('/pulls')&&options.method==='POST') {createCalls++;const head=git(root,'--git-dir='+origin,'rev-parse','refs/heads/'+body.head);const row={number:1,head:{sha:head,ref:body.head,repo:{full_name:source.repository}},base:{ref:body.base},state:'open',merged:false,html_url:'https://github.com/example/project/pull/1',body:body.body};reviews.push(row);if(loseCreate){loseCreate=false;throw Error('lost response');}data=row;}
      else if(/\/pulls$/.test(u.pathname))data=reviews.map(r=>({...r,head:{...r.head,sha:git(root,'--git-dir='+origin,'rev-parse','refs/heads/'+r.head.ref)}}));
      else if(/\/pulls\/1$/.test(u.pathname)){const row=reviews[0];data={...row,head:{...row.head,sha:git(root,'--git-dir='+origin,'rev-parse','refs/heads/'+row.head.ref)}};}
      else if(u.pathname.endsWith('/comments')){if(options.method==='POST'){comments.push({id:comments.length+1,body:body.body});data=comments.at(-1);}else data=comments;}
      else if(u.pathname.endsWith('/status'))data={state:'success',statuses:[{state:'success'}]};
      else if(u.pathname.endsWith('/check-runs'))data={total_count:1,check_runs:[{status:'completed',conclusion:'success'}]};
      else throw Error('unexpected '+u.pathname);
    } else {
      if(u.pathname==='/api/operator/reviews'&&options.method==='POST'){createCalls++;data={id:'a'.repeat(32),head:body.head,base:body.base,branch:body.branch,status:'open',description:body.description,approvedBy:null};reviews.push(data);}
      else if(u.pathname==='/api/operator/reviews')data=reviews;
      else if(u.pathname==='/api/operator/reviews/'+'a'.repeat(32))data={revision:reviews[0],check:{status:'running'},passed:false};
      else throw Error('unexpected '+u.pathname);
    }
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const config={source,remote:pathToFileURL(origin).href,store,allowFileRemote:true,fetchImpl,token:async()=>'test-credential',origin:'https://reviews.example.test',session:async()=>'review-session'};
  const adapter=kind==='github'?createGitHubAdapter(config):createArtifactsAdapter(config);
  return {root,origin,seed,workspace,store,source,adapter,reviews,comments,config,get createCalls(){return createCalls;},loseNextCreate(){loseCreate=true;}};
}
for(const provider of ['github','artifacts'])test(`${provider}: real Git snapshot -> isolated workspace -> captured binary/mode/delete changes -> branch and review`,async t=>{
  const f=await fixture(t,provider),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});assert.equal(await readFile(join(f.workspace,'app.txt'),'utf8'),'original\n');
  await writeFile(join(f.workspace,'app.txt'),'changed\n');await writeFile(join(f.workspace,'binary.bin'),Buffer.from([0,255,1]));await mkdir(join(f.workspace,'ignored'));await writeFile(join(f.workspace,'ignored','build.txt'),'ignored');await rm(join(f.workspace,'AGENTS.md'));
  const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});assert.deepEqual(changeSet.changes.map(c=>c.path),['AGENTS.md','app.txt','binary.bin']);
  const intent=await publicationIntent({taskId:'task',attemptId:'attempt',changeId:'change',snapshot,changeSet,title:'Change the app',description:'## Changes\n\n'+ 'Detailed description and meaningful validation. '.repeat(5)});
  const receipt=await f.adapter.publish({intent});assert.equal(f.createCalls,1);assert.equal(git(f.root,'--git-dir='+f.origin,'show',receipt.review.revision+':app.txt'),'changed');
  assert.deepEqual(await f.adapter.publish({intent}),receipt);assert.equal(f.createCalls,1);
  const record=await f.store.read('publication:'+intent.idempotencyKey);assert.equal(record.phase,'published');assert.equal(record.intent.review.description,intent.review.description);
  const read=await f.adapter.readChange({publication:receipt});assert.equal(read.review.revision,receipt.review.revision);assert.equal(read.review.canUpdate,provider==='github');
});
test('lost GitHub create response reconciles the existing PR without rerunning or duplicate creation',async t=>{
  const f=await fixture(t),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'new\n');const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'Title',description:'Description'});f.loseNextCreate();await assert.rejects(f.adapter.publish({intent}));const receipt=await f.adapter.publish({intent});assert.equal(receipt.review.id,'1');assert.equal(f.createCalls,1);
});
test('source or branch movement prevents destructive publication',async t=>{
  const f=await fixture(t),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'new');const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'Title',description:'Description'});
  await writeFile(join(f.seed,'other.txt'),'concurrent');git(f.seed,'add','.');git(f.seed,'commit','-m','concurrent');git(f.seed,'push','origin','main');await assert.rejects(f.adapter.publish({intent}),/stale_target_base/);assert.equal(f.createCalls,0);
});
test('unsafe workspace symlinks and source bindings fail closed',async t=>{
  const f=await fixture(t),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await rm(join(f.workspace,'app.txt'));await symlink('/etc/passwd',join(f.workspace,'app.txt'));await assert.rejects(f.adapter.collect({snapshot,workspaceHandle:f.workspace}),/unsafe_workspace/);
  await assert.rejects(f.adapter.resolve({source:{...f.source,repository:'other/project'}}),/not_configured/);
});
test('repository execution stores captured work and retries publication without a second Codex invocation',async t=>{
  const f=await fixture(t);let calls=0,fail=true;const realPublish=f.adapter.publish;
  const adapter={...f.adapter,async publish(args){if(fail){fail=false;throw Error('provider unavailable');}return realPublish(args);}};
  const task={taskId:'attempt',logicalTaskId:'task',repositoryBinding:'example',instructions:'Implement the change',review:{title:'Title',description:'Description'}};
  const execute=async(task,auth,{workspacePath})=>{calls++;await writeFile(join(workspacePath,'app.txt'),'executed');return {state:'completed',result:{taskId:task.taskId,threadId:'codex-thread',operation:'codex_exec',billingMode:'included_subscription',exitCode:0,turnCompleted:true,commandCount:1}};};
  const first=await runRepositoryTask(task,'{}',f.config,{store:f.store,adapter,execute});assert.equal(first.result.repository.publication.state,'blocked');
  const retry=await runRepositoryTask({...task,taskId:'publication-retry',executionId:'attempt'},'{}',f.config,{store:f.store,adapter,execute});assert.equal(retry.result.repository.publication.state,'published');assert.equal(calls,1);
});
test('GitHub rework applies earlier work to a fresh base and conditionally updates the same PR',async t=>{
  const f=await fixture(t),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'first submitted implementation\n');const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});
  const first=await publicationIntent({taskId:'task',attemptId:'attempt-1',changeId:'change',snapshot,changeSet,title:'Title',description:'Description'}),publication=await f.adapter.publish({intent:first});
  await writeFile(join(f.seed,'new-base.txt'),'base changed');git(f.seed,'add','.');git(f.seed,'commit','-m','advance target');git(f.seed,'push','origin','main');
  const submittedChange=await f.adapter.readChange({publication}),latest=await f.adapter.resolve({source:f.source}),workspace=join(f.root,'rework');await mkdir(workspace);
  const prepared=await f.adapter.prepareRework({snapshot:latest,submittedChange,reason:'refresh_base',workspaceHandle:workspace});assert.deepEqual(prepared.conflicts,[]);assert.equal(await readFile(join(workspace,'app.txt'),'utf8'),'first submitted implementation\n');assert.equal(await readFile(join(workspace,'new-base.txt'),'utf8'),'base changed');
  await writeFile(join(workspace,'app.txt'),'revised implementation\n');const collected=await f.adapter.collect({snapshot:latest,workspaceHandle:workspace});
  const intent=await publicationIntent({taskId:'task',attemptId:'attempt-2',changeId:'change',snapshot:latest,changeSet:collected.changeSet,title:'Title',description:'Revised review body',rework:{reason:'fix_issues',previousPublication:publication,submittedChange}},['https://github.com']);
  const updated=await f.adapter.update({intent});assert.equal(updated.review.id,publication.review.id);assert.notEqual(updated.review.revision,publication.review.revision);assert.equal(updated.parentIdempotencyKey,publication.idempotencyKey);assert.equal(f.createCalls,1);assert.equal(f.comments.length,1);
  await f.adapter.update({intent});assert.equal(f.comments.length,1);
});
test('Artifacts rework fails before any write when conditional review updates are unavailable',async t=>{
  const f=await fixture(t,'artifacts');assert.equal(f.adapter.id,'artifacts');
  // Provider explicitly reports non-updateability; source publication remains
  // available and never silently reopens or replaces a terminal review.
  const snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'first');const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});
  const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'Title',description:'Detailed review body and validation. '.repeat(5)}),published=await f.adapter.publish({intent});
  const read=await f.adapter.readChange({publication:published});assert.equal(read.review.canUpdate,false);assert.equal(f.createCalls,1);
});

test('public GitHub media uses an immutable, dedicated branch without adding images to the source PR',async t=>{
  const f=await fixture(t),adapter=createGitHubAdapter({...f.config,allowPublicMediaBranch:true});
  const snapshot=await adapter.resolve({source:f.source});await adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'new');const {changeSet}=await adapter.collect({snapshot,workspaceHandle:f.workspace}),digest=await changeSetDigest(changeSet,snapshot),bytes=png(),content=await f.store.put(bytes);
  const image={content,mimeType:'image/png',byteLength:bytes.length,width:2,height:1,alt:'UI',caption:'',capture:{scenario:'fixture',route:'/tasks',viewport:{width:2,height:1,deviceScaleFactor:1},fullPage:false}};
  const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'Title',description:'Description',comparisons:[{id:'ui',label:'UI',before:{...image,subject:{kind:'source_revision',revision:snapshot.revision}},after:{...image,subject:{kind:'change_set',sha256:digest}}}]});
  const receipt=await adapter.publish({intent});assert.match(f.reviews[0].body,/raw.githubusercontent.com/);assert.ok(!git(f.root,'--git-dir='+f.origin,'ls-tree','-r',receipt.review.revision).includes('.png'));
  assert.match(git(f.root,'--git-dir='+f.origin,'for-each-ref','--format=%(refname)'),/refs\/heads\/codex\/metis-media-/);
});
test('real text conflicts are exposed for rework rather than losing either side',async t=>{
  const f=await fixture(t),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'submitted side\n');const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'Title',description:'Description'}),publication=await f.adapter.publish({intent});
  await writeFile(join(f.seed,'app.txt'),'target side\n');git(f.seed,'add','.');git(f.seed,'commit','-m','conflicting target');git(f.seed,'push','origin','main');const latest=await f.adapter.resolve({source:f.source}),read=await f.adapter.readChange({publication}),workspace=join(f.root,'conflict');await mkdir(workspace);
  const prepared=await f.adapter.prepareRework({snapshot:latest,submittedChange:read,reason:'resolve_conflicts',workspaceHandle:workspace});assert.ok(prepared.conflicts.includes('app.txt'));const text=await readFile(join(workspace,'app.txt'),'utf8');assert.match(text,/target side/);assert.match(text,/submitted side/);assert.match(text,/<<<<<<</);await assert.rejects(f.adapter.collect({snapshot:latest,workspaceHandle:workspace}),/conflicts_unresolved/);await writeFile(join(workspace,'app.txt'),'combined target and submitted sides\n');assert.ok((await f.adapter.collect({snapshot:latest,workspaceHandle:workspace})).changeSet);
});

test('configured cloud capture flows through PNG verification, durable content, source collection and Markdown publication',async t=>{
  const f=await fixture(t),capture={command:[process.execPath,'-e',`require('fs').writeFileSync('capture.png',Buffer.from(${JSON.stringify(png().toString('base64'))},'base64'))`],output:'capture.png',scenario:'fixture',route:'/tasks',viewport:{width:2,height:1,deviceScaleFactor:1}};
  const adapter=createGitHubAdapter({...f.config,allowPublicMediaBranch:true}),task={taskId:'attempt',logicalTaskId:'task',repositoryBinding:'example',instructions:'Update the UI',review:{title:'Update UI',description:'Implemented and tested the UI change.'}};
  const execute=async(task,auth,{workspacePath})=>{await writeFile(join(workspacePath,'ui.css'),'body {color: green;}');return {state:'completed',result:{taskId:task.taskId,operation:'codex_exec',threadId:'thread',billingMode:'included_subscription',exitCode:0,turnCompleted:true,commandCount:1}};};
  const result=await runRepositoryTask(task,'{}',{...f.config,capture,allowPublicMediaBranch:true},{store:f.store,adapter,execute});assert.equal(result.result.repository.publication.state,'published');const execution=await f.store.read('execution:attempt');assert.equal(execution.intent.review.comparisons.length,1);assert.deepEqual(execution.intent.changeSet.changes.map(c=>c.path),['ui.css']);assert.match(f.reviews[0].body,/### Before/);assert.match(f.reviews[0].body,/### After/);
});
test('a blocked repository agent cannot publish partial edits and retains the Codex thread and blocker',async t=>{
  const f=await fixture(t),task={taskId:'blocked-attempt',logicalTaskId:'task',repositoryBinding:'example',instructions:'Implement',review:{title:'Title',description:'Description'}};
  const execute=async(task,auth,{workspacePath})=>{await writeFile(join(workspacePath,'app.txt'),'unfinished changes');return {state:'blocked',reason:'repository_agent_blocked',result:{threadId:'blocked-thread',blockers:['Human input required']}};};
  const receipt=await runRepositoryTask(task,'{}',f.config,{store:f.store,adapter:f.adapter,execute});assert.equal(receipt.state,'blocked');assert.equal(receipt.result.threadId,'blocked-thread');assert.equal(f.createCalls,0);assert.equal((await f.store.read('execution:blocked-attempt')).state,'blocked');
});
test('repository execution receives the binding deadline without the former five-minute clamp',async t=>{
  const f=await fixture(t),task={taskId:'deadline-attempt',logicalTaskId:'task',repositoryBinding:'example',instructions:'Inspect',review:{title:'Title',description:'Description'}};
  let received;
  const execute=async(task,auth,options)=>{received=options.timeoutMs;return {state:'blocked',reason:'execution_timeout',result:{executionProgress:{elapsedMs:600000,idleMs:50000,lastEvent:'item.completed:reasoning',commands:[],commandsTruncated:0,lastCommand:null}}};};
  const receipt=await runRepositoryTask(task,'{}',{...f.config,executionTimeoutMs:600000},{store:f.store,adapter:f.adapter,execute});
  assert.equal(received,600000);assert.equal(receipt.reason,'execution_timeout');assert.equal(f.createCalls,0);
  assert.deepEqual((await f.store.read('execution:deadline-attempt')).result,receipt.result);
});
test('full execution reports stay durable while the task API receipt remains bounded',async t=>{
  const f=await fixture(t),task={taskId:'long-report',logicalTaskId:'task',repositoryBinding:'example',instructions:'Inspect source',review:{title:'Title',description:'Description'}};
  const execute=async task=>({state:'completed',result:{taskId:task.taskId,threadId:'thread',commandCount:1,finalMessage:'x'.repeat(20000),agentOutcome:{status:'completed',summary:'x'.repeat(20000),blockers:[]}}});
  const receipt=await runRepositoryTask(task,'{}',f.config,{store:f.store,adapter:f.adapter,execute});assert.equal(receipt.state,'completed');assert.ok(receipt.result.finalMessage.length<4100);assert.equal(receipt.result.agentOutcome,undefined);assert.equal((await f.store.read('execution:long-report')).result.finalMessage.length,20000);
});

for(const provider of ['github','artifacts'])test(`${provider}: Git-reference source exceeds old limits while only changed bytes enter the store`,async t=>{
  const f=await fixture(t,provider);
  // More than 50 MiB overall, and every binary exceeds the former 5 MiB cap.
  for(let n=0;n<9;n++)await writeFile(join(f.seed,'large-'+n+'.bin'),Buffer.alloc(6*1024*1024,n));
  git(f.seed,'add','.');git(f.seed,'commit','-m','existing large assets');git(f.seed,'push','origin','main');
  const puts=[],originalPut=f.store.put.bind(f.store);f.store.put=async bytes=>{puts.push(Buffer.byteLength(bytes));return originalPut(bytes);};
  const adapter=(provider==='github'?createGitHubAdapter:createArtifactsAdapter)({...f.config});
  const snapshot=await adapter.resolve({source:f.source});assert.equal(snapshot.adapterVersion,'git-reference-v1');assert.ok(puts.every(n=>n<1000));assert.equal(puts.length,1);
  await adapter.prepare({snapshot,workspaceHandle:f.workspace});assert.equal((await readFile(join(f.workspace,'large-8.bin'))).length,6*1024*1024);
  assert.equal((await adapter.collect({snapshot,workspaceHandle:f.workspace})).changeSet,null);
  await writeFile(join(f.workspace,'app.txt'),'no-op documentation test\n');await writeFile(join(f.workspace,'new.bin'),Buffer.from([0,255,128]));await rm(join(f.workspace,'large-0.bin'));
  const {changeSet}=await adapter.collect({snapshot,workspaceHandle:f.workspace});assert.deepEqual(changeSet.changes.map(c=>c.path),['app.txt','large-0.bin','new.bin']);
  const intent=await publicationIntent({taskId:'t',attemptId:'a',changeId:'c',snapshot,changeSet,title:'No-op review',description:'Documentation-only fixture publication and binary transport validation. '.repeat(3)});
  const receipt=await adapter.publish({intent});assert.equal(git(f.root,'--git-dir='+f.origin,'show',receipt.review.revision+':app.txt'),'no-op documentation test');assert.equal(git(f.root,'--git-dir='+f.origin,'ls-tree',receipt.review.revision,'large-0.bin'),'');assert.ok(git(f.root,'--git-dir='+f.origin,'ls-tree',receipt.review.revision,'large-8.bin'));assert.ok(puts.every(n=>n<1000),'unchanged repository blobs must not enter D1');
  await writeFile(join(f.workspace,'new.bin'),Buffer.alloc(6*1024*1024));await assert.rejects(adapter.collect({snapshot,workspaceHandle:f.workspace}),/unsafe_workspace_entry/);
});

for(const provider of ['github','artifacts'])test(`${provider}: isolated publisher applies only the saved task-bound package and reconciles repeat submissions`,async t=>{
  const {runPublisherCommand}=await import('../runtime/repositories/publisher.mjs');const f=await fixture(t,provider),snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});await writeFile(join(f.workspace,'app.txt'),'published by service\n');await writeFile(join(f.workspace,'added.bin'),Buffer.from([0,255,3]));
  const {changeSet}=await f.adapter.collect({snapshot,workspaceHandle:f.workspace});const intent=await publicationIntent({taskId:'task',attemptId:'attempt',changeId:'task',snapshot,changeSet,title:'Controlled package',description:'Apply the captured change package through the trusted publisher. '.repeat(3)});
  const claims={binding:'example',logicalTaskId:'task',executionId:'attempt'},config={...f.config,binding:'example'},command={claims,operation:'publish',intent};
  let result=await runPublisherCommand(command,config,{store:f.store,adapter:f.adapter});assert.equal(result.reason,'publisher_execution_not_completed');assert.equal(f.createCalls,0);
  await f.store.save('execution:attempt',{state:'completed',intent});
  result=await runPublisherCommand({...command,claims:{...claims,logicalTaskId:'other'}},config,{store:f.store,adapter:f.adapter});assert.equal(result.ok,false);assert.equal(f.createCalls,0);
  result=await runPublisherCommand({...command,intent:{...intent,review:{...intent.review,description:'tampered'}}},config,{store:f.store,adapter:f.adapter});assert.equal(result.ok,false);assert.equal(f.createCalls,0);
  result=await runPublisherCommand(command,config,{store:f.store,adapter:f.adapter});assert.equal(result.ok,true,result.reason);assert.equal(f.createCalls,1);assert.equal(git(f.root,'--git-dir='+f.origin,'show',result.value.review.revision+':app.txt'),'published by service');
  assert.deepEqual(await runPublisherCommand(command,config,{store:f.store,adapter:f.adapter}),result);assert.equal(f.createCalls,1);
  const observed=await runPublisherCommand({claims,operation:'observe',publication:result.value},config,{store:f.store,adapter:{observe:async()=>({review:'observed'})}});assert.equal(observed.ok,true);assert.deepEqual(observed.value,{review:'observed'});
  for(const operation of ['merge','approve','deploy'])assert.equal((await runPublisherCommand({claims,operation},config,{store:f.store,adapter:f.adapter})).ok,false);
});
test('execution-side adapter delegates all publication operations without a repository write credential',async t=>{
  const {createExecutionAdapter}=await import('../runtime/repositories/execution-adapter.mjs'),f=await fixture(t),seen=[];
  const adapter=createExecutionAdapter({source:f.source,remote:'https://broker.example/v1/repositories/example/git',authorization:'Bearer read-capability',broker:{origin:'https://broker.example/v1/repositories/example/commands',token:'task-capability'}},f.store,{fetchImpl:async(url,options)=>{seen.push(JSON.parse(options.body));assert.equal(options.headers.authorization,'Bearer task-capability');assert.ok(!options.body.includes('test-credential'));return Response.json({ok:true,value:{received:true}});}});
  for(const method of ['publish','update','readChange','observe'])assert.deepEqual(await adapter[method](method==='publish'||method==='update'?{intent:{sample:'captured'}}:{publication:{sample:'recorded'}}),{received:true});assert.deepEqual(seen.map(x=>x.operation),['publish','update','readChange','observe']);
});
test('source metadata rejects legacy full-tree manifests and exports raw Git bytes without checkout filters',async t=>{
  const f=await fixture(t);await writeFile(join(f.seed,'.gitattributes'),'*.txt text eol=crlf\n');git(f.seed,'add','.gitattributes');git(f.seed,'commit','-m','attributes');git(f.seed,'push','origin','main');
  const snapshot=await f.adapter.resolve({source:f.source});await f.adapter.prepare({snapshot,workspaceHandle:f.workspace});assert.equal(await readFile(join(f.workspace,'app.txt'),'utf8'),'original\n');assert.equal((await f.adapter.collect({snapshot,workspaceHandle:f.workspace})).changeSet,null);
  const content=await f.store.put(JSON.stringify({files:[{path:'app.txt',mode:'100644',sha256:'0'.repeat(64)}]})),other=join(f.root,'legacy');await mkdir(other);await assert.rejects(f.adapter.prepare({snapshot:{...snapshot,adapterVersion:'git-v1',content},workspaceHandle:other}),/invalid_git_reference/);
});

test('repository progress persists before execution finishes without overwriting execution state',async t=>{
 const f=await fixture(t),task={taskId:'live-attempt',logicalTaskId:'task',repositoryBinding:'example',instructions:'Inspect',review:{title:'Title',description:'Description'}};
 const progress={threadId:'11111111-1111-4111-8111-111111111111',commandCount:0,executionProgress:{elapsedMs:5000,idleMs:1000,lastEvent:'item.started:command_execution',commandsTruncated:0,commands:[{hint:'pnpm_test',status:'running',elapsedMs:1000,startedMs:4000}],lastCommand:{hint:'pnpm_test',status:'running',elapsedMs:1000}}};
 const execute=async(task,auth,options)=>{assert.equal(options.captureCommandOutput,true);await options.onProgress(progress);assert.equal((await f.store.read('execution:live-attempt')).state,'running');assert.deepEqual(await f.store.read('progress:live-attempt'),progress);return {state:'blocked',reason:'execution_timeout',result:progress};};
 const receipt=await runRepositoryTask(task,'{}',{...f.config,captureCommandOutput:true},{store:f.store,adapter:f.adapter,execute});assert.equal(receipt.state,'blocked');assert.equal((await f.store.read('execution:live-attempt')).state,'blocked');assert.equal(f.createCalls,0);
});

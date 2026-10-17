import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSource,validatePath,validateSnapshot,validateChangeSet,changeSetDigest,publicationIntent,validatePublication,validateObservation,defineRepositoryAdapter} from '../src/repository-adapters/contract.mjs';
const sha='a'.repeat(64),nextSha='b'.repeat(64);
function fixture(adapter='github') {
  const source={adapter,repository:adapter==='github'?'example/project':'team/project',ref:'main'};
  const snapshot={version:1,source,adapterVersion:'1.0.0',revision:adapter==='github'?'c'.repeat(40):'revision-opaque-42',content:{ref:'snapshot:abc',sha256:sha},instructions:[{path:'AGENTS.md',sha256:sha}]};
  const changeSet={version:1,source,baseRevision:snapshot.revision,changes:[{path:'src/app.mjs',before:{sha256:sha,mode:'100644'},after:{sha256:nextSha,mode:'100755',contentRef:'blob:changed'}}]};
  const request={taskId:'task-1',attemptId:'attempt-1',snapshot,changeSet,title:'Implement requested change',description:'Validation and requested behavior.',evidence:[{ref:'test-log:one',sha256:sha}]};
  return {source,snapshot,changeSet,request};
}
function receipt(intent){return {version:1,adapter:intent.snapshot.source.adapter,repository:intent.snapshot.source.repository,baseRevision:intent.snapshot.revision,changeSetDigest:intent.changeSetDigest,idempotencyKey:intent.idempotencyKey,review:{id:'review-1',url:'https://reviews.example.test/reviews/1',revision:'submitted-1'}};}
function observation(){return {version:1,review:{id:'review-1',revision:'submitted-1',state:'open',approval:'pending'},checks:{state:'passed',revision:'submitted-1'},integration:{state:'not_integrated',revision:null},deployment:{state:'not_started',revision:null}};}
for(const adapter of ['github','artifacts'])test(`${adapter} uses the same pinned-source, change, publication and observation contract`,async()=>{
  const f=fixture(adapter);assert.equal(validateSource(f.source),f.source);assert.equal(validateSnapshot(f.snapshot),f.snapshot);assert.equal(validateChangeSet(f.changeSet,f.snapshot),f.changeSet);
  const intent=await publicationIntent(f.request);assert.match(intent.idempotencyKey,/^metis-review-[a-f0-9]{64}$/);
  const publication=receipt(intent);assert.equal(validatePublication(publication,intent,["https://reviews.example.test"]),publication);
  const state=observation();assert.equal(validateObservation(state,publication),state);assert.equal(state.integration.state,'not_integrated','successful execution or checks cannot imply merge');
});
test('opaque Artifacts revisions do not have to be Git commit hashes',()=>{const f=fixture('artifacts');validateSnapshot(f.snapshot);f.snapshot.revision='';assert.throws(()=>validateSnapshot(f.snapshot),/revision/);});
test('version mismatches, extra credential fields, and unbound changes fail closed',()=>{
  const f=fixture();assert.throws(()=>validateSnapshot({...f.snapshot,version:2}),/version/);
  assert.throws(()=>validateSnapshot({...f.snapshot,token:'secret'}),/unsupported fields/);
  assert.throws(()=>validateSource({...f.source,repository:'https://user:secret@example.test/repo'}),/repository/);
  for(const modified of [{...f.changeSet,baseRevision:'new-head'},{...f.changeSet,source:{...f.source,repository:'different/repo'}},{...f.changeSet,source:{...f.source,adapter:'artifacts'}}])assert.throws(()=>validateChangeSet(modified,f.snapshot),/pinned source/);
});
test('file manifests support additions, deletions, binary content references and mode changes',()=>{
  const f=fixture();f.changeSet.changes=[
    {path:'new.bin',before:null,after:{sha256:sha,mode:'100644',contentRef:'blob:binary'}},
    {path:'old.txt',before:{sha256:sha,mode:'100644'},after:null},
    {path:'run.sh',before:{sha256:sha,mode:'100644'},after:{sha256:sha,mode:'100755',contentRef:'blob:same-bytes'}}
  ];validateChangeSet(f.changeSet,f.snapshot);
});
test('unsafe paths, symlinks, duplicate paths, and unchanged files cannot become publications',()=>{
  for(const path of ['/root/file','../file','src/../file','src//file','C:/file','a\\b','.git/config','nested/.GIT/hooks/pre-commit','bad\nfile','e\u0301.txt'])assert.throws(()=>validatePath(path),/path/);
  const f=fixture();
  assert.throws(()=>validateChangeSet({...f.changeSet,changes:[{...f.changeSet.changes[0],after:{sha256:sha,mode:'120000',contentRef:'symlink:target'}}]},f.snapshot),/regular files/);
  assert.throws(()=>validateChangeSet({...f.changeSet,changes:[...f.changeSet.changes,{...f.changeSet.changes[0],path:'SRC/APP.MJS'}]},f.snapshot),/case-colliding/);
  assert.throws(()=>validateChangeSet({...f.changeSet,changes:[{path:'file',before:null,after:null}]},f.snapshot),/empty/);
  assert.throws(()=>validateChangeSet({...f.changeSet,changes:[{path:'file',before:{sha256:sha,mode:'100644'},after:{sha256:sha,mode:'100644',contentRef:'blob:unchanged'}}]},f.snapshot),/unchanged/);
});
test('publication identity is stable across JSON key/file ordering, but changes with task, attempt, source, content or review metadata',async()=>{
  const f=fixture();f.changeSet.changes.push({path:'another.txt',before:null,after:{sha256:sha,mode:'100644',contentRef:'blob:another'}});
  const first=await publicationIntent(f.request),second=await publicationIntent({...f.request,changeSet:{...f.changeSet,changes:[...f.changeSet.changes].reverse()}});
  assert.equal(first.changeSetDigest,second.changeSetDigest);assert.equal(first.idempotencyKey,second.idempotencyKey);
  for(const request of [{...f.request,attemptId:'attempt-2'},{...f.request,taskId:'task-2'},{...f.request,title:'Other title'},{...f.request,snapshot:{...f.snapshot,adapterVersion:'2.0.0'}}])assert.notEqual((await publicationIntent(request)).idempotencyKey,first.idempotencyKey);
  assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.changeSet.changes));
  assert.throws(()=>{first.review.title='mutated';},TypeError);
  assert.equal(await changeSetDigest(f.changeSet,f.snapshot),first.changeSetDigest);
});
test('publication receipt must refer to the same source, base, bytes and intent',async()=>{
  const f=fixture(),intent=await publicationIntent(f.request),r=receipt(intent);
  for(const modified of [{...r,repository:'other/repo'},{...r,baseRevision:'other-base'},{...r,changeSetDigest:sha},{...r,idempotencyKey:'other-operation'},{...r,review:{...r.review,url:'https://user:secret@reviews.example.test/1'}},{...r,review:{...r.review,url:'https://reviews.example.test/1?token=secret'}}])assert.throws(()=>validatePublication(modified,intent,["https://reviews.example.test"]));
});
test('approval, validation, integration and deployment are independent and exact-revision bound',async()=>{
  const f=fixture(),publication=receipt(await publicationIntent(f.request));
  const state=observation();state.review.approval='approved';validateObservation(state,publication);assert.equal(state.integration.state,'not_integrated');
  state.checks.revision='stale-revision';assert.throws(()=>validateObservation(state,publication),/checks must cover/);state.checks.revision='submitted-1';
  state.review.state='integrated';state.integration={state:'integrated',revision:'squash-revision'};state.deployment={state:'succeeded',revision:'old-release'};assert.throws(()=>validateObservation(state,publication),/exact integrated revision/);
  state.deployment.revision='squash-revision';validateObservation(state,publication);
  state.review.revision='unrelated-new-head';assert.throws(()=>validateObservation(state,publication),/different review or revision/);
});
test('adapter implementations expose a small lifecycle without a model launcher or merge method',()=>{
  const impl={id:'artifacts',version:'1.0.0',resolve(){},prepare(){},collect(){},publish(){},observe(){}};
  const adapter=defineRepositoryAdapter(impl);assert.ok(Object.isFrozen(adapter));assert.throws(()=>defineRepositoryAdapter({...impl,publish:null}),/publish/);
  assert.throws(()=>defineRepositoryAdapter({...impl,launchCodex(){}}),/unsupported fields/);
  assert.throws(()=>defineRepositoryAdapter({...impl,merge(){}}),/unsupported fields/);
});

test('Artifacts review permalinks may use query-based IDs but must use a configured origin',async()=>{
  const f=fixture('artifacts'),intent=await publicationIntent(f.request),r=receipt(intent);
  r.review.url='https://reviews.example.test/reviews?diff=opaque-review-id';
  validatePublication(r,intent,['https://reviews.example.test']);
  assert.throws(()=>validatePublication(r,intent,['https://different.example.test']),/origin/);
});

test('an in-flight publication intent is detached from later caller mutations',async()=>{
  const f=fixture(),originalBase=f.snapshot.revision,pending=publicationIntent(f.request);
  f.snapshot.revision='raced-base';f.changeSet.changes[0].after.sha256='d'.repeat(64);
  const intent=await pending;assert.equal(intent.snapshot.revision,originalBase);assert.equal(intent.changeSet.changes[0].after.sha256,nextSha);
});

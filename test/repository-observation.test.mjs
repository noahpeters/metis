import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubReviews,ArtifactsReviews} from '../runtime/repositories/providers.mjs';
import {validateObservation} from '../src/repository-adapters/contract.mjs';
const head='a'.repeat(40),merge='b'.repeat(40),publication={review:{id:'1',revision:head}};
test('GitHub observations require exact heads, configured checks and exact merge workflow evidence',async()=>{
  let workflowHead=merge;
  const provider=new GitHubReviews({repository:'example/project',token:async()=>'token',requiredChecks:['verify'],requiredDeploymentWorkflows:['Release'],fetchImpl:async url=>{
    const path=new URL(url).pathname;let data;
    if(path.endsWith('/pulls/1'))data={number:1,head:{sha:head,ref:'codex/change'},state:'closed',merged:true,merge_commit_sha:merge};
    else if(path.endsWith('/status'))data={sha:head,state:'success',statuses:[]};
    else if(path.endsWith('/check-runs'))data={total_count:1,check_runs:[{name:'verify',head_sha:head,status:'completed',conclusion:'success'}]};
    else if(path.endsWith('/actions/runs'))data={total_count:1,workflow_runs:[{id:1,name:'Release',head_sha:workflowHead,event:'push',status:'completed',conclusion:'success'}]};
    else throw Error('unexpected request');return new Response(JSON.stringify(data));
  }});
  const observed=await provider.observe(publication);validateObservation(observed,publication);assert.equal(observed.checks.state,'passed');assert.equal(observed.review.approval,'unknown');assert.equal(observed.deployment.state,'succeeded');workflowHead=head;assert.equal((await provider.observe(publication)).deployment.state,'unknown');
});
test('inaccessible GitHub check evidence does not erase authoritative merge evidence or claim passing validation',async()=>{
  const provider=new GitHubReviews({repository:'example/project',token:async()=>'token',fetchImpl:async url=>new URL(url).pathname.endsWith('/pulls/1')?new Response(JSON.stringify({number:1,head:{sha:head},state:'closed',merged:true,merge_commit_sha:merge})):new Response('{}',{status:403})});
  const o=await provider.observe(publication);validateObservation(o,publication);assert.equal(o.integration.revision,merge);assert.equal(o.checks.state,'unknown');assert.equal(o.deployment.state,'unknown');
});
test('Cabinitron project profile binds fast-forward release and validation evidence to the reviewed head',async()=>{
  const id='c'.repeat(32),p={review:{id,revision:head}};
  const provider=new ArtifactsReviews({origin:'https://reviews.example',session:async()=>'session',fetchImpl:async()=>new Response(JSON.stringify({revision:{id,head,base:merge,branch:'codex/change',status:'landed',approvedBy:'operator'},check:{status:'complete',output:{commit:head,base:merge,ref:'refs/heads/codex/change',status:'passed'}},passed:true,release:{status:'deployed',version:'runtime-version'}}))});
  const o=await provider.observe(p);validateObservation(o,p);assert.equal(o.review.approval,'approved');assert.equal(o.checks.state,'passed');assert.equal(o.integration.revision,head);assert.equal(o.deployment.revision,head);
});

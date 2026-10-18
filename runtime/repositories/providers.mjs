import {JsonApi,unknownObservation} from './http.mjs';
import {check,sha256,AdapterError} from './store.mjs';
export class GitHubReviews {
  constructor({repository,token,fetchImpl,requiredChecks=[],requiredDeploymentWorkflows=[]}){check(/^[\w.-]+\/[\w.-]+$/.test(repository),'invalid_github_repository');this.requiredChecks=requiredChecks;this.requiredDeploymentWorkflows=requiredDeploymentWorkflows;this.repository=repository;this.base='/repos/'+repository;this.origin='https://github.com';this.api=new JsonApi({origin:'https://api.github.com',headers:async()=>({authorization:'Bearer '+await token(),'user-agent':'metis','x-github-api-version':'2022-11-28'}),fetchImpl});this.supportsUpdate=true;}
  async assertPublic(){const repo=await this.api.request(this.base);check(repo.private===false&&repo.full_name===this.repository,'public_media_repository_not_verified');}
  async find(branch){const rows=await this.api.pages(this.base+'/pulls?state=all&head='+encodeURIComponent(this.repository.split('/')[0]+':'+branch));const matches=rows.filter(r=>r.head?.ref===branch&&r.head?.repo?.full_name===this.repository);check(matches.length<=1,'ambiguous_provider_review');return matches[0]??null;}
  async read(id){check(/^\d+$/.test(String(id)),'invalid_review_id');const row=await this.api.request(this.base+'/pulls/'+id);return row;}
  async create({branch,head,base,title,body}) {let existing=await this.find(branch);if(existing)return this.verify(existing,head,base);try{return this.verify(await this.api.request(this.base+'/pulls',{method:'POST',body:{head:branch,base,title,body}}),head,base);}catch(e){if(e.code!=='provider_http_422')throw e;existing=await this.find(branch);check(existing,'provider_review_not_reconciled');return this.verify(existing,head,base);}}
  verify(row,head,base){check(row.head?.sha===head&&row.base?.ref===base&&row.head?.repo?.full_name===this.repository,'provider_review_mismatch');return row;}
  normalized(row){return {id:String(row.number),url:row.html_url,revision:row.head.sha,state:row.merged?'integrated':row.state==='open'?'open':'closed',canUpdate:row.state==='open'&&!row.merged,updateToken:row.head.sha,branch:row.head.ref};}
  async feedback(row){const reviews=await this.api.pages(this.base+'/pulls/'+row.number+'/comments');const comments=await this.api.pages(this.base+'/issues/'+row.number+'/comments');check(reviews.length+comments.length<=100,'review_feedback_limit');return [...reviews,...comments].map(r=>({id:String(r.id),revision:r.commit_id??row.head.sha,kind:'review_comment',body:r.body??''}));}
  async update({id,head,base,body,key,reconcileOnly=false}){const row=this.verify(await this.read(id),head,base);check(row.state==='open'&&!row.merged,'review_no_longer_updateable');const comments=await this.api.pages(this.base+'/issues/'+id+'/comments');const marker='<!-- '+key+' -->',revisionBody='## Revision `'+head+'`\n\n'+body;const found=comments.find(c=>c.body?.includes(marker));if(found)check(found.body===revisionBody,'review_comment_mismatch');else {check(!reconcileOnly,'review_write_outcome_unknown');await this.api.request(this.base+'/issues/'+id+'/comments',{method:'POST',body:{body:revisionBody}});}return row;}
  async observe(publication){
    const observation=unknownObservation(publication),row=await this.read(publication.review.id);check(row.head.sha===publication.review.revision,'review_head_moved');const normalized=this.normalized(row);observation.review.state=normalized.state;
    // Approval/ruleset semantics are not inferred from a list of reviews.
    const status=await this.api.request(this.base+'/commits/'+row.head.sha+'/status').catch(()=>null);
    // /check-runs is an object, so query it separately; missing permissions stay unknown.
    const runs=await this.api.request(this.base+'/commits/'+row.head.sha+'/check-runs?per_page=100').catch(()=>null);
    if(runs&&Array.isArray(runs.check_runs)&&runs.total_count<=100&&Array.isArray(status?.statuses)&&status.sha===row.head.sha&&runs.check_runs.every(c=>c.head_sha===row.head.sha)){
      const all=runs.check_runs,failed=all.some(c=>c.status==='completed'&&!['success','neutral','skipped'].includes(c.conclusion))||status.state==='failure'||status.state==='error';
      const names=new Set([...all.map(c=>c.name),...status.statuses.map(s=>s.context)]);
      const passed=this.requiredChecks.length>0&&this.requiredChecks.every(name=>names.has(name))&&all.every(c=>c.status==='completed'&&['success','neutral','skipped'].includes(c.conclusion))&&(!status.statuses.length||status.state==='success');
      observation.checks={state:failed?'failed':passed?'passed':this.requiredChecks.length?'pending':'unknown',revision:row.head.sha};
    }
    if(row.merged&&row.merge_commit_sha)observation.integration={state:'integrated',revision:row.merge_commit_sha};else observation.integration={state:'not_integrated',revision:null};
    if(row.merged&&row.merge_commit_sha&&this.requiredDeploymentWorkflows.length){
      const data=await this.api.request(this.base+'/actions/runs?head_sha='+row.merge_commit_sha+'&event=push&per_page=100').catch(()=>null);
      if(data&&data.total_count<=100&&Array.isArray(data.workflow_runs)){
        const runs=this.requiredDeploymentWorkflows.map(name=>data.workflow_runs.filter(r=>r.head_sha===row.merge_commit_sha&&r.event==='push'&&(r.name===name||r.path===name)).sort((a,b)=>b.id-a.id)[0]);
        if(runs.every(Boolean)){const failed=runs.some(r=>r.status==='completed'&&r.conclusion!=='success');observation.deployment={state:failed?'failed':runs.every(r=>r.status==='completed'&&r.conclusion==='success')?'succeeded':'pending',revision:row.merge_commit_sha};}
      }
    }
    return observation;
  }
}
export class ArtifactsReviews {
  constructor({origin,session,fetchImpl}){this.origin=new URL(origin).origin;this.api=new JsonApi({origin:this.origin,headers:async()=>({cookie:await session(),origin:this.origin}),fetchImpl});this.supportsUpdate=false;}
  async find(branch){const rows=await this.api.request('/api/operator/reviews');check(Array.isArray(rows),'invalid_provider_list');const matches=rows.filter(r=>r.branch===branch);check(matches.length<=1,'ambiguous_provider_review');if(matches.length)return matches[0];check(rows.length<100,'artifacts_review_history_truncated');return null;}
  async read(id){check(/^[a-f0-9]{32}$/.test(id),'invalid_review_id');return this.api.request('/api/operator/reviews/'+id);}
  normalized(row){return {id:row.id,url:this.origin+'/reviews?diff='+row.id,revision:row.head,state:row.status==='landed'?'integrated':['open','approved','stale'].includes(row.status)?'open':['superseded'].includes(row.status)?'closed':'unknown',canUpdate:false,updateToken:null,branch:row.branch};}
  async create({branch,head,base,title,body,images=[]}){const row=await this.find(branch);if(row){check(row.head===head&&row.base===base,'provider_review_mismatch');return row;}check(body.trim().length>=120,'artifacts_description_too_short');const path=image=>{const u=new URL(image.url);check(u.origin===this.origin&&/^\/api\/operator\/reviews\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(u.pathname),'unsupported_artifacts_media_url');return u.pathname;};return this.api.request('/api/operator/reviews',{method:'POST',body:{branch,head,base,title,description:body,uiChange:images.length>0,beforeMedia:images[0]?path(images[0]):null,afterMedia:images[1]?path(images[1]):null}});}
  verify(row,head,base){check(row.head===head&&row.base===base,'provider_review_mismatch');return row;}
  async feedback(row){return [{id:'review-description',revision:row.head,kind:'review_comment',body:row.description??''}];}
  async update(){throw new AdapterError('artifacts_atomic_review_update_unavailable');}
  async observe(publication){const data=await this.read(publication.review.id),row=data.revision;check(row.head===publication.review.revision,'review_head_moved');const normalized=this.normalized(row),o=unknownObservation(publication);o.review.state=normalized.state;o.review.approval=row.approvedBy?'approved':row.status==='open'?'pending':'unknown';
    const output=data.check?.output,exact=output?.commit===row.head&&output?.base===row.base&&output?.ref==='refs/heads/'+row.branch;
    o.checks={state:exact&&data.passed===true?'passed':exact&&output?.status==='failed'?'failed':'unknown',revision:exact?row.head:null};
    // This project profile lands by a guarded fast-forward of the reviewed head.
    // Its per-review GET queries release(head), binding release status to it.
    if(row.status==='landed'){o.integration={state:'integrated',revision:row.head};if(data.release?.status==='deployed'&&typeof data.release.version==='string'&&data.release.version)o.deployment={state:'succeeded',revision:row.head};else if(data.release?.status==='failed')o.deployment={state:'failed',revision:row.head};else if(data.release?.status==='deploying')o.deployment={state:'pending',revision:row.head};}
    return o;
  }
}

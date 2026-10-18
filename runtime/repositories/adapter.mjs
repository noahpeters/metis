import {mkdir,mkdtemp,rm,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {validateSource,validateSnapshot,validateChangeSet,defineRepositoryAdapter,publicationIntent,validatePublication,validateSubmittedChange,validateUpdatePrecondition,validateObservation,renderReviewMarkdown} from '../../src/repository-adapters/contract.mjs';
import {GitRepository} from './git.mjs';
import {GitHubReviews,ArtifactsReviews} from './providers.mjs';
import {check,AdapterError} from './store.mjs';
const originsFor=provider=>[provider.origin];
export function createRepositoryAdapter({source,remote,store,authorization,provider,mediaPublisher,mediaOrigins=[],allowPublicMediaBranch=false,allowFileRemote=false}) {
  validateSource(source);check(['github','artifacts'].includes(source.adapter),'unsupported_repository_adapter');
  const git=new GitRepository({source,remote,store,authorization,allowFileRemote}),origins=originsFor(provider);
  if(!mediaPublisher&&source.adapter==='github'&&allowPublicMediaBranch){mediaOrigins=['https://raw.githubusercontent.com'];mediaPublisher=async({intent})=>{await provider.assertPublic();return git.publishMedia(intent);};}
  const conflictPaths=new Map();
  const bound=s=>check(s.source.adapter===source.adapter&&s.source.repository===source.repository&&s.source.ref===source.ref,'repository_not_configured');
  const read=async publication=>{
    check(publication.adapter===source.adapter&&publication.repository===source.repository&&publication.targetRef===source.ref,'repository_not_configured');
    const data=await provider.read(publication.review.id),row=data.revision??data,native=provider.normalized(row);
    const submittedSnapshot=await git.snapshot(native.revision,native.branch);
    const feedback=[];for(const item of await provider.feedback(row)){feedback.push({id:item.id,kind:item.kind,revision:item.revision,content:await store.put(Buffer.from(item.body))});}
    return validateSubmittedChange({version:1,taskId:publication.taskId,changeId:publication.changeId,source,baseRevision:publication.baseRevision,changeSetDigest:publication.changeSetDigest,review:{id:native.id,url:native.url,revision:native.revision,state:native.state,canUpdate:native.canUpdate,updateToken:native.updateToken},submittedSnapshot,feedback},publication,origins);
  };
  const publish=async supplied=>{
    const intent=await publicationIntent({...supplied,...supplied.review},origins);check(intent.idempotencyKey===supplied.idempotencyKey,'publication_intent_changed');bound(intent.snapshot);
    const changesUi=intent.changeSet.changes.some(c=>/^(app|public|ui-assets)\/|\.(css|html|tsx|jsx)$/.test(c.path));
    check(!changesUi||intent.review.comparisons.length>0,'review_ui_evidence_required');
    if(intent.operation==='update')check(provider.supportsUpdate,'artifacts_atomic_review_update_unavailable');
    return store.lock(intent.changeId,async()=>{
      const key='publication:'+intent.idempotencyKey;let operation=await store.read(key);
      check(!operation||operation.intent.idempotencyKey===intent.idempotencyKey,'publication_identity_conflict');
      const latest=await store.read('change:'+intent.changeId);
      check(!latest||latest.idempotencyKey===intent.idempotencyKey||latest.idempotencyKey===intent.rework?.previousPublication.idempotencyKey,'change_revision_moved');
      check(intent.operation!=='update'||latest,'previous_publication_not_recorded');
      if(operation?.receipt){await store.save('change:'+intent.changeId,operation.receipt);return validatePublication(operation.receipt,intent,origins);}
      operation??={intent,phase:'prepared'};await store.save(key,operation);
      try {
        if(provider.assertRepository)await provider.assertRepository();
        const branch=git.branch(intent.changeId);
        if(intent.operation==='update'&&!operation.head)validateUpdatePrecondition(intent,{submittedChange:await read(intent.rework.previousPublication),targetSnapshot:await adapter.resolve({source})},origins);
        if(!operation.images){
          let images=[];
          if(intent.review.comparisons.length){check(mediaPublisher,'review_media_transport_not_configured');images=await mediaPublisher({intent,store});}
          // Validate every mapping before any source/review write.
          renderReviewMarkdown(intent,images,mediaOrigins);operation.images=images;await store.save(key,operation);
        }
        const body=renderReviewMarkdown(intent,operation.images,mediaOrigins)+'\n\n<!-- '+intent.idempotencyKey+' -->';
        if(!operation.head){operation.head=await git.push(intent,branch,intent.rework?.previousPublication.review.revision??null);operation.phase='source_pushed';await store.save(key,operation);}
        let row=await provider.find(branch);
        if(intent.operation==='update') {
          check(row&&String(provider.normalized(row).id)===intent.rework.previousPublication.review.id,'provider_review_mismatch');
          const native=provider.normalized(row);check(native.state==='open','review_no_longer_updateable');
          check(native.revision===operation.head,'provider_review_mismatch');
          const reconcileOnly=!!operation.reviewWriteStarted;operation.reviewWriteStarted=true;await store.save(key,operation);
          row=await provider.update({id:native.id,head:operation.head,base:source.ref,body,key:intent.idempotencyKey,reconcileOnly});
        } else if(!row) {
          check(!operation.reviewWriteStarted,'review_write_outcome_unknown');
          operation.reviewWriteStarted=true;await store.save(key,operation);
          row=await provider.create({branch,head:operation.head,base:source.adapter==='artifacts'?intent.snapshot.revision:source.ref,title:intent.review.title,body,images:operation.images});
        }
        if(intent.operation==='create')check((row.body??row.description??'').replace(/\r\n/g,'\n').trim()===body.trim(),'provider_review_body_mismatch');
        provider.verify(row,operation.head,source.adapter==='artifacts'?intent.snapshot.revision:source.ref);
        const native=provider.normalized(row);check(native.branch===branch&&native.revision===operation.head,'provider_review_mismatch');
        const receipt=validatePublication({version:1,taskId:intent.taskId,attemptId:intent.attemptId,changeId:intent.changeId,operation:intent.operation,parentIdempotencyKey:intent.rework?.previousPublication.idempotencyKey??null,adapter:source.adapter,repository:source.repository,targetRef:source.ref,baseRevision:intent.snapshot.revision,changeSetDigest:intent.changeSetDigest,idempotencyKey:intent.idempotencyKey,review:{id:native.id,url:native.url,revision:native.revision}},intent,origins);
        operation.receipt=receipt;operation.phase='published';await store.save(key,operation);await store.save('change:'+intent.changeId,receipt);return receipt;
      } catch(error){operation.phase='blocked';operation.reason=error instanceof AdapterError?error.code:'repository_operation_failed';await store.save(key,operation);throw new AdapterError(operation.reason);}
    });
  };
  const adapter=defineRepositoryAdapter({id:source.adapter,version:'git-v1',
    async resolve({source:requested}){check(requested.adapter===source.adapter&&requested.repository===source.repository&&requested.ref===source.ref,'repository_not_configured');if(provider.assertRepository)await provider.assertRepository();return git.snapshot(await git.head());},
    async prepare({snapshot,workspaceHandle}){bound(snapshot);return git.prepare(snapshot,workspaceHandle);},
    async collect({snapshot,workspaceHandle,excludePaths=[]}){bound(snapshot);for(const path of conflictPaths.get(workspaceHandle)??[]){const file=await git.readWorkspace(workspaceHandle,path);if(file)check(!/^(<<<<<<< |=======\r?$|>>>>>>> )/m.test(file.bytes.toString('utf8')),'rework_conflicts_unresolved');}return {changeSet:await git.collect(snapshot,workspaceHandle,excludePaths),evidence:[]};},
    publish:({intent})=>{check(intent.operation==='create','create_intent_required');return publish(intent);},
    readChange:({publication})=>read(publication),
    async prepareRework({snapshot,submittedChange,reason,workspaceHandle}){
      bound(snapshot);check(['fix_issues','resolve_conflicts','refresh_base'].includes(reason),'invalid_rework_reason');check(submittedChange.review.canUpdate&&submittedChange.source.repository===source.repository,'review_no_longer_updateable');
      // Apply the prior full diff onto the new base using Git's three-way
      // machinery. Conflict markers remain for the new Codex attempt to resolve.
      return git.repository(snapshot.revision,async root=>{
        for(const revision of [submittedChange.baseRevision,submittedChange.review.revision])await git.run(['-C',root,'fetch','--no-tags','--no-recurse-submodules',remote,revision],{auth:true});
        const temporary=await mkdtemp(join(tmpdir(),'metis-rework-'));
        try {
          await git.run(['--git-dir='+root,'--work-tree='+temporary,'read-tree','--reset','-u',snapshot.revision]);
          const patch=await git.run(['-C',root,'diff','--binary',submittedChange.baseRevision,submittedChange.review.revision,'--']);
          try{await git.run(['--git-dir='+root,'--work-tree='+temporary,'apply','--3way','--index','--whitespace=nowarn','-'],{input:patch,cwd:temporary});}catch{
            const conflicts=(await git.run(['--git-dir='+root,'--work-tree='+temporary,'diff','--name-only','--diff-filter=U','-z'])).toString();check(conflicts,'rework_could_not_be_applied');
          }
          const names=(await git.run(['--git-dir='+root,'--work-tree='+temporary,'ls-files','-z'])).toString().split('\0').filter(Boolean);
          check(!(await lstat(workspaceHandle)).isSymbolicLink()&&(await readdir(workspaceHandle)).length===0,'workspace_must_be_empty');
          for(const path of new Set(names)){const file=await git.readWorkspace(temporary,path);if(!file)continue;await mkdir(dirname(join(workspaceHandle,path)),{recursive:true});await writeFile(join(workspaceHandle,path),file.bytes,{flag:'wx',mode:file.mode==='100755'?0o755:0o644});}
          const conflicts=(await git.run(['--git-dir='+root,'--work-tree='+temporary,'diff','--name-only','--diff-filter=U','-z'])).toString().split('\0').filter(Boolean);
          for(const path of conflicts){const file=await git.readWorkspace(workspaceHandle,path);if(file){try{new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw new AdapterError('binary_conflict_requires_operator');}check(!file.bytes.includes(0),'binary_conflict_requires_operator');}}
          conflictPaths.set(workspaceHandle,conflicts);return {workspaceHandle,conflicts};
        }finally{await rm(temporary,{recursive:true,force:true});}
      });
    },
    update:({intent})=>{check(intent.operation==='update','update_intent_required');return publish(intent);},
    async observe({publication}){check(publication.adapter===source.adapter&&publication.repository===source.repository,'repository_not_configured');return validateObservation(await provider.observe(publication),publication);},
  });return adapter;
}
export const createGitHubAdapter=config=>{if(!config.allowFileRemote){const remote=new URL(config.remote);check(remote.origin==='https://github.com'&&[('/'+config.source.repository),('/'+config.source.repository+'.git')].includes(remote.pathname),'github_remote_does_not_match_binding');}return createRepositoryAdapter({...config,provider:new GitHubReviews({...config,repository:config.source.repository})});};
export const createArtifactsAdapter=config=>createRepositoryAdapter({...config,provider:new ArtifactsReviews(config)});

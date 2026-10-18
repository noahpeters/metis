import {createGitHubAdapter,createArtifactsAdapter} from './adapter.mjs';
import {HttpRepositoryStore,check,AdapterError} from './store.mjs';
import {httpMediaPublisher,artifactsMediaPublisher} from './media.mjs';
import {publicationIntent} from '../../src/repository-adapters/contract.mjs';
// Runs in a separate container, without invoking Codex or receiving a subscription credential.
export async function runPublisherCommand(command,config,{store:providedStore,adapter:providedAdapter}={}){
  try{
    const {claims,operation}=command;check(claims.binding===config.binding,'publisher_binding_mismatch');
    const store=providedStore??new HttpRepositoryStore(config.store),origins=[config.source.adapter==='github'?'https://github.com':new URL(config.origin).origin];
    const adapter=providedAdapter??(config.source.adapter==='github'?createGitHubAdapter:createArtifactsAdapter)({...config,store,authorization:async()=>config.authorization,token:async()=>config.token,session:async()=>config.session,mediaPublisher:config.media?httpMediaPublisher(config.media):config.artifactsMedia?artifactsMediaPublisher(config.artifactsMedia):undefined,mediaOrigins:config.media?.allowedOrigins??(config.artifactsMedia?[new URL(config.artifactsMedia.origin).origin]:[])});
    if(['publish','update'].includes(operation)){
      const execution=await store.read('execution:'+claims.executionId);check(execution?.state==='completed'&&execution.intent,'publisher_execution_not_completed');
      const intent=await publicationIntent({...command.intent,...command.intent?.review},origins);
      check(intent.idempotencyKey===command.intent.idempotencyKey&&intent.idempotencyKey===execution.intent.idempotencyKey&&JSON.stringify(intent)===JSON.stringify(execution.intent),'publisher_intent_mismatch');
      check(intent.taskId===claims.logicalTaskId&&intent.changeId===claims.logicalTaskId&&intent.attemptId===claims.executionId,'publisher_task_mismatch');
      check(intent.snapshot.source.adapter===config.source.adapter&&intent.snapshot.source.repository===config.source.repository&&intent.snapshot.source.ref===config.source.ref,'publisher_source_mismatch');
      check((operation==='update')===(intent.operation==='update'),'publisher_operation_mismatch');
      return {ok:true,value:await adapter[operation]({intent})};
    }
    check(['readChange','observe'].includes(operation),'publisher_operation_not_allowed');
    const publication=await store.read('change:'+claims.logicalTaskId);check(publication&&JSON.stringify(command.publication)===JSON.stringify(publication),'publisher_publication_mismatch');
    check(publication.taskId===claims.logicalTaskId&&publication.repository===config.source.repository&&publication.adapter===config.source.adapter,'publisher_task_mismatch');
    return {ok:true,value:await adapter[operation]({publication})};
  }catch(error){return {ok:false,reason:error instanceof AdapterError?error.code:'publisher_request_invalid'};}
}

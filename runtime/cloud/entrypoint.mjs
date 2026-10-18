import {WorkerEntrypoint} from 'cloudflare:workers';
import {Container} from '@cloudflare/containers';
import {executeOnce} from './execution-ledger.mjs';
import {executeContainerTask} from './container-task.mjs';

export class CodexContainer extends Container {
  defaultPort=8080;
  sleepAfter='3m';
  // One trusted task per container identity. No app/Cloudflare/GitHub secrets.
  async execute(task) {
    const identity=JSON.stringify(task);
    if (this.inFlight) return this.inFlightIdentity===identity ? this.inFlight : {state:'blocked',reason:'task_identity_conflict'};
    if (!this.env.CODEX_SUBSCRIPTION_AUTH_JSON) return {state:'blocked',reason:'subscription_auth_missing'};
    let repositoryConfig;
    if(task.repositoryBinding) {
      try { const bindings=JSON.parse(this.env.REPOSITORY_BINDINGS_JSON??'{}');repositoryConfig=Object.hasOwn(bindings,task.repositoryBinding)?bindings[task.repositoryBinding]:undefined; } catch {}
      if(!repositoryConfig)return {state:'blocked',reason:'repository_binding_not_configured'};
    }
    this.sleepAfter=repositoryConfig?'12m':'3m';
    this.inFlightIdentity=identity;
    this.inFlight=executeOnce(this.ctx.storage,task,()=>executeContainerTask(this,task,this.env.CODEX_SUBSCRIPTION_AUTH_JSON,repositoryConfig),fn=>this.ctx.blockConcurrencyWhile(fn)).finally(()=>{this.inFlight=null;this.inFlightIdentity=null;});
    return this.inFlight;
  }
}
export default class CodexRuntime extends WorkerEntrypoint {
  // This Worker has no public execution endpoint. Only a service binding can
  // invoke the RPC method. A task's UUID selects its own durable container.
  fetch() {return new Response('Not found',{status:404});}
  async repositoryCapabilities(binding) {
    let config;try{const bindings=JSON.parse(this.env.REPOSITORY_BINDINGS_JSON??'{}');config=Object.hasOwn(bindings,binding)?bindings[binding]:undefined;}catch{}
    return {configured:!!(config?.store?.origin&&config?.store?.token&&config?.remote&&(config.source?.adapter==='github'?config.token:config.session)),canRework:config?.source?.adapter==='github',hasCapture:!!config?.capture,hasMedia:!!(config?.media||config?.artifactsMedia||config?.allowPublicMediaBranch)};
  }
  async execute(task) {
    if (!task || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task.taskId) || typeof task.instructions!=='string' || !task.instructions.trim() || task.instructions.length>10000 || (task.verification!=null && task.verification!=='numeric_summary_v1')) return {state:'blocked',reason:'invalid_task'};
    if(task.repositoryBinding && (!/^[a-z][a-z0-9_-]{0,63}$/.test(task.repositoryBinding)||typeof task.logicalTaskId!=='string'||typeof task.review?.title!=='string'||typeof task.review?.description!=='string'||task.review.description.length>60000))return {state:'blocked',reason:'invalid_repository_task'};
    if(task.executionId && !/^[0-9a-f-]{36}$/.test(task.executionId))return {state:'blocked',reason:'invalid_execution_id'};
    const stub=this.env.CODEX_CONTAINER.getByName(task.taskId);
    return stub.execute(task);
  }
}

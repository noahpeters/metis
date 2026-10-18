import {WorkerEntrypoint} from 'cloudflare:workers';
import {Container} from '@cloudflare/containers';
import {repositoryServiceFetch,repositoryBinding,prepareRepositoryExecution,providerAuthorization,repositoryCapabilities} from '../../src/repository-service.mjs';
import {stopContainerAndConfirm} from '../cloud/container-task.mjs';
export class RepositoryPublisher extends Container {
  defaultPort=8080;
  sleepAfter='6m';
  async run(command){
    if(this.busy)return {ok:false,reason:'publisher_busy'};
    this.busy=true;let result,phase='authentication';
    try{
      const config=repositoryBinding(this.env,command.claims.binding);
      const auth=await providerAuthorization(this.env,config,true);
      phase='startup';
      await this.startAndWaitForPorts({ports:8080,startOptions:{envVars:{METIS_PUBLISHER_CONFIG:JSON.stringify({...config,...auth})}},cancellationOptions:{instanceGetTimeoutMS:60000,portReadyTimeoutMS:30000}});
      phase='request';
      const response=await this.containerFetch(new Request('http://container/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(240000)}));phase='response';result=response.ok?await response.json():{ok:false,reason:'publisher_http_failure'};
    }catch{result={ok:false,reason:'publisher_'+phase+'_unavailable'};}
    try{await stopContainerAndConfirm(this);}catch{result={ok:false,reason:'publisher_shutdown_unconfirmed'};}
    this.busy=false;return result;
  }
}
export default class RepositoryService extends WorkerEntrypoint {
  fetch(request){return repositoryServiceFetch(request,this.env);}
  async capabilities(binding){
    return repositoryCapabilities(this.env,binding);
  }
  executionConfig(binding,task){return prepareRepositoryExecution(this.env,binding,task);}
}

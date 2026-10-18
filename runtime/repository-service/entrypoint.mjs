import {WorkerEntrypoint} from 'cloudflare:workers';
import {Container} from '@cloudflare/containers';
import {repositoryServiceFetch,repositoryBinding,prepareRepositoryExecution,providerAuthorization} from '../../src/repository-service.mjs';
import {stopContainerAndConfirm} from '../cloud/container-task.mjs';
export class RepositoryPublisher extends Container {
  defaultPort=8080;
  sleepAfter='6m';
  async run(command){
    if(this.busy)return {ok:false,reason:'publisher_busy'};
    this.busy=true;let result;
    try{
      const config=repositoryBinding(this.env,command.claims.binding);
      const auth=await providerAuthorization(this.env,config,true);
      await this.startAndWaitForPorts({ports:8080,startOptions:{envVars:{METIS_PUBLISHER_CONFIG:JSON.stringify({...config,...auth})}},cancellationOptions:{instanceGetTimeoutMS:60000,portReadyTimeoutMS:30000}});
      const response=await this.containerFetch(new Request('http://container/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(240000)}));result=response.ok?await response.json():{ok:false,reason:'publisher_http_failure'};
    }catch{result={ok:false,reason:'publisher_transport_unknown'};}
    try{await stopContainerAndConfirm(this);}catch{result={ok:false,reason:'publisher_shutdown_unconfirmed'};}
    this.busy=false;return result;
  }
}
export default class RepositoryService extends WorkerEntrypoint {
  fetch(request){return repositoryServiceFetch(request,this.env);}
  async capabilities(binding){
    try{const c=repositoryBinding(this.env,binding);const app=!!(this.env.GITHUB_APP_PRIVATE_KEY&&this.env.GITHUB_APP_ID&&this.env.GITHUB_APP_INSTALLATION_ID);const read=c.source.adapter==='github'?(app||c.readToken):c.readAuthorization;const write=c.source.adapter==='github'?(app||c.token):(c.authorization&&c.session);return {configured:!!(read&&write&&this.env.REPOSITORY_CAPABILITY_KEY&&this.env.REPOSITORY_PUBLIC_ORIGIN),canRework:c.source.adapter==='github',hasCapture:!!c.capture,hasMedia:!!(c.media||c.artifactsMedia||c.allowPublicMediaBranch)};}catch{return {configured:false};}
  }
  executionConfig(binding,task){return prepareRepositoryExecution(this.env,binding,task);}
}

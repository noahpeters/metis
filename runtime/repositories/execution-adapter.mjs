import {createRepositoryAdapter} from './adapter.mjs';
import {check} from './store.mjs';
// A replace/delete file manifest is the binary-safe patch format. No source
// credentials or provider write operations exist in this execution adapter.
export function createExecutionAdapter(config,store,{fetchImpl=fetch}={}) {
  const {broker,source}=config;
  const origin=source.adapter==='github'?'https://github.com':config.reviewOrigin;
  const local=createRepositoryAdapter({source,remote:config.remote,store,authorization:async()=>config.authorization,provider:{origin}});
  const call=async(operation,payload)=>{
    const response=await fetchImpl(broker.origin,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({operation,...payload}),signal:AbortSignal.timeout(390000)});
    check(response.ok,'repository_publisher_rejected');const result=await response.json();check(result.ok,result.reason??'repository_publisher_blocked');return result.value;
  };
  return {...local,publish:({intent})=>call('publish',{intent}),update:({intent})=>call('update',{intent}),readChange:({publication})=>call('readChange',{publication}),observe:({publication})=>call('observe',{publication})};
}

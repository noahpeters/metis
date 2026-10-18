import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Exercise the real broker inside workerd: Node fetch accepts redirect:error,
// while Workers rejects it before sending a request, even with a valid token.
test('Worker Git proxy uses a supported redirect mode and refuses upstream redirects',async t=>{
 const root=new URL('../',import.meta.url).pathname;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-08-30',modulesRoot:root,modules:[
  {type:'ESModule',path:root+'edge-test.mjs',contents:`
   import {repositoryServiceFetch,issueRepositoryCapability} from './src/repository-service.mjs';
   export default {async fetch(request){
    const source={adapter:'github',repository:'example/project',ref:'main'},env={REPOSITORY_CAPABILITY_KEY:'x'.repeat(32),REPOSITORY_PROVIDERS_JSON:JSON.stringify({example:{source,remote:'https://github.com/example/project.git',readToken:'test-read-token',store:{origin:'https://store.example',token:'test-bridge'}}})};
    const token=await issueRepositoryCapability(env,{source,binding:'example',taskId:'1'.repeat(36),logicalTaskId:'2'.repeat(36),executionId:'1'.repeat(36)});
    const redirect=new URL(request.url).searchParams.has('redirect');
    return repositoryServiceFetch(new Request('https://broker.example/v1/repositories/example/git/info/refs?service=git-upload-pack',{headers:{authorization:'Bearer '+token}}),env,{fetchImpl:async(url,options)=>{
     // Validate RequestInit with native Workers fetch without external traffic.
     await fetch('data:text/plain,ok',{redirect:options.redirect});
     return redirect?new Response(null,{status:302,headers:{location:'https://elsewhere.example'}}):new Response('test advertisement',{headers:{'content-type':'application/x-git-upload-pack-advertisement'}});
    }});
   }};`},
  {type:'ESModule',path:root+'src/repository-service.mjs'},
  {type:'ESModule',path:root+'src/github.mjs'}
 ]}));
 t.after(()=>mf.dispose());
 const response=await mf.dispatchFetch('http://test/');assert.equal(response.status,200);assert.equal(await response.text(),'test advertisement');
 assert.equal((await mf.dispatchFetch('http://test/?redirect')).status,502);
});

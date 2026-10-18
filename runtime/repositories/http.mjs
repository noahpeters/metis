import {check,AdapterError} from './store.mjs';
export class JsonApi {
  constructor({origin,headers=async()=>({}),fetchImpl=fetch}){const u=new URL(origin);check(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'invalid_api_origin');this.origin=origin.replace(/\/$/,'');this.headers=headers;this.fetchImpl=fetchImpl;}
  async request(path,{method='GET',body}={}){
    check(path.startsWith('/')&&!path.startsWith('//'),'invalid_api_path');let response;
    try{response=await this.fetchImpl(this.origin+path,{method,redirect:'error',headers:{accept:'application/json',...(await this.headers()),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});}catch{throw new AdapterError('provider_transport_unknown');}
    check(response.ok,'provider_http_'+response.status);const raw=await response.text();check(Buffer.byteLength(raw)<=5*1024*1024,'provider_response_limit');try{return JSON.parse(raw);}catch{throw new AdapterError('invalid_provider_response');}
  }
  async pages(path){const results=[];for(let page=1;page<=20;page++){const rows=await this.request(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);check(Array.isArray(rows),'invalid_provider_list');results.push(...rows);if(rows.length<100)return results;}throw new AdapterError('provider_pagination_limit');}
}
export function unknownObservation(publication){return {version:1,review:{id:publication.review.id,revision:publication.review.revision,state:'unknown',approval:'unknown'},checks:{state:'unknown',revision:null},integration:{state:'unknown',revision:null},deployment:{state:'unknown',revision:null}};}

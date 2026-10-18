import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export class AdapterError extends Error {constructor(code){super(code);this.code=code;}}
export const check=(condition,code)=>{if(!condition)throw new AdapterError(code);};
// Local implementation for tests or an explicitly durable mounted volume.
// Cloud containers must use a durable content/ledger service, not /tmp.
export class FileRepositoryStore {
  constructor(root){this.root=root;}
  async init(){await mkdir(this.root,{recursive:true,mode:0o700});return this;}
  path(key){return join(this.root,sha256(key));}
  async put(bytes){bytes=Buffer.from(bytes);check(bytes.length<=5*1024*1024,'content_too_large');const digest=sha256(bytes),ref='sha256:'+digest;await this.atomic(this.path(ref),bytes);return {ref,sha256:digest};}
  async get(content){check(content.ref==='sha256:'+content.sha256,'invalid_content_ref');const bytes=await readFile(this.path(content.ref));check(sha256(bytes)===content.sha256,'content_integrity_failed');return bytes;}
  async atomic(path,bytes){const temp=path+'.'+randomUUID();await writeFile(temp,bytes,{mode:0o600});await rename(temp,path);}
  async read(key){try{return JSON.parse(await readFile(this.path(key),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async save(key,value){await this.atomic(this.path(key),JSON.stringify(value));}
  async lock(changeId,fn){const path=this.path('lock:'+changeId);try{await mkdir(path);}catch(e){if(e.code==='EEXIST')throw new AdapterError('publication_busy_or_interrupted');throw e;}try{return await fn();}finally{await rm(path,{recursive:true});}}
}
// A cloud host can supply this same interface through its authenticated
// durable content service. Request/response bodies never enter model context.
export class HttpRepositoryStore {
  constructor({origin,token,fetchImpl=fetch}){const u=new URL(origin);check(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'invalid_store_origin');this.origin=origin.replace(/\/$/,'');this.token=token;this.fetchImpl=fetchImpl;}
  async call(action,body){let r;try{r=await this.fetchImpl(this.origin,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify({action,...body,...(this.lease??{})}),signal:AbortSignal.timeout(60000)});}catch{throw new AdapterError('repository_store_unavailable');}check(r.ok,'repository_store_rejected');return r.json();}
  async put(bytes){bytes=Buffer.from(bytes);check(bytes.length<=5*1024*1024,'content_too_large');const content=await this.call('put',{bytes:bytes.toString('base64')});check(content.sha256===sha256(bytes),'content_integrity_failed');return content;}
  async get(content){const {bytes}=await this.call('get',{content}),data=Buffer.from(bytes,'base64');check(sha256(data)===content.sha256,'content_integrity_failed');return data;}
  read(key){return this.call('read',{key});}
  save(key,value){return this.call('save',{key,value});}
  async lock(changeId,fn){const owner=randomUUID();await this.call('lock',{changeId,owner});this.lease={changeId,owner};try{return await fn();}finally{try{await this.call('unlock',{changeId,owner});}finally{this.lease=null;}}}
}

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,readFile,writeFile,lstat,open,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {validatePath,validateSnapshot,validateChangeSet} from '../../src/repository-adapters/contract.mjs';
import {sha256,check,AdapterError} from './store.mjs';
const exec=promisify(execFile),oid=/^[a-f0-9]{40,64}$/;
export class GitRepository {
  constructor({source,remote,authorization,store,allowFileRemote=false,maxFiles=5000,maxBytes=50*1024*1024,maxSourceBytes=1024*1024*1024}) {
    const u=new URL(remote);check((u.protocol==='https:'||(allowFileRemote&&u.protocol==='file:'))&&!u.username&&!u.password&&!u.search&&!u.hash,'invalid_repository_remote');
    this.source=source;this.remote=remote;this.authorization=authorization;this.store=store;this.maxFiles=maxFiles;this.maxBytes=maxBytes;this.maxSourceBytes=maxSourceBytes;
  }
  async run(args,{cwd,input,auth=false,env={}}={}) {
    const clean={PATH:process.env.PATH,HOME:tmpdir(),LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:this.remote.startsWith('file:')?'file':'https',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_CONFIG_KEY_1:'protocol.ext.allow',GIT_CONFIG_VALUE_1:'never',...env};
    if(auth&&this.authorization){clean.GIT_CONFIG_COUNT='3';clean.GIT_CONFIG_KEY_2=`http.${this.remote}.extraHeader`;clean.GIT_CONFIG_VALUE_2='Authorization: '+await this.authorization();}
    try{return (await new Promise((accept,reject)=>{const child=execFile('git',args,{cwd,env:clean,encoding:'buffer',maxBuffer:Math.max(this.maxSourceBytes,6*1024*1024),timeout:60000},(e,stdout)=>e?reject(e):accept(stdout));child.stdin.on('error',()=>{});child.stdin.end(input??null);}));}
    catch{throw new AdapterError('git_operation_failed');}
  }
  async head(ref=this.source.ref){check(typeof ref==='string'&&ref.length<=200&&!ref.startsWith('-')&&!/[\s~^:?*\[\\]|\.\.|@\{/.test(ref),'invalid_repository_ref');const name=ref.startsWith('refs/')?ref:'refs/heads/'+ref;const text=(await this.run(['ls-remote','--exit-code',this.remote,name],{auth:true})).toString().trim().split(/\s+/);check(oid.test(text[0])&&text[1]===name,'source_ref_not_found');return text[0];}
  async branchHead(branch){const text=(await this.run(['ls-remote',this.remote,'refs/heads/'+branch],{auth:true})).toString().trim();if(!text)return null;const [sha,ref]=text.split(/\s+/);check(oid.test(sha)&&ref==='refs/heads/'+branch,'invalid_branch_head');return sha;}
  async repository(revision,fn){check(oid.test(revision),'invalid_source_revision');const root=await mkdtemp(join(tmpdir(),'metis-git-'));try{await this.run(['init','--bare','--template=',root]);await this.run(['-C',root,'fetch','--depth=1','--no-tags','--no-recurse-submodules',this.remote,revision],{auth:true});return await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
  async tree(root,revision){
    const entries=(await this.run(['-C',root,'ls-tree','-rlz','--full-tree',revision])).toString('utf8').split('\0').filter(Boolean);check(entries.length<=this.maxFiles,'repository_file_limit');let total=0;
    return entries.map(entry=>{const m=/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);check(m&&['100644','100755'].includes(m[1]),'unsupported_repository_entry');const [,mode,blob,size,path]=m;validatePath(path);total+=Number(size);check(total<=this.maxSourceBytes,'repository_source_limit');return {path,mode,blob,size:Number(size)};});
  }
  async snapshot(revision,ref=this.source.ref){return this.repository(revision,async root=>{
      const files=await this.tree(root,revision),instructions=[];
      for(const f of files.filter(f=>/(^|\/)AGENTS\.md$/.test(f.path))){check(f.size<=1024*1024,'instruction_file_limit');instructions.push({path:f.path,sha256:sha256(await this.run(['-C',root,'cat-file','blob',f.blob]))});}
      const content=await this.store.put(Buffer.from(JSON.stringify({kind:'git-reference-v1',source:this.source,revision})));
      return validateSnapshot({version:1,source:{...this.source,ref},adapterVersion:'git-reference-v1',revision,content,instructions});
  });}
  async files(snapshot){validateSnapshot(snapshot);const descriptor=JSON.parse((await this.store.get(snapshot.content)).toString());
    check(snapshot.adapterVersion==='git-reference-v1'&&descriptor.kind==='git-reference-v1'&&descriptor.revision===snapshot.revision&&descriptor.source.adapter===this.source.adapter&&descriptor.source.repository===this.source.repository&&descriptor.source.ref===this.source.ref,'invalid_git_reference');return this.repository(snapshot.revision,root=>this.tree(root,snapshot.revision));
  }
  async prepare(snapshot,workspace){check((await readdir(workspace)).length===0,'workspace_must_be_empty');check((await lstat(workspace)).isDirectory()&&!(await lstat(workspace)).isSymbolicLink(),'invalid_workspace');await this.files(snapshot);
    return this.repository(snapshot.revision,async root=>{for(const f of await this.tree(root,snapshot.revision)){const path=join(workspace,f.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,await this.run(['-C',root,'cat-file','blob',f.blob]),{flag:'wx',mode:f.mode==='100755'?0o755:0o644});}return workspace;});
  }
  async fingerprint(workspace,path,algorithm='sha1'){
    validatePath(path);let current=resolve(workspace);for(const part of path.split('/').slice(0,-1)){current=join(current,part);try{const stat=await lstat(current);check(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe_workspace_entry');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
    let file;try{file=await open(join(workspace,path),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();check(stat.isFile()&&stat.size<=this.maxSourceBytes,'unsafe_workspace_entry');const hash=createHash('sha256'),gitHash=createHash(algorithm).update('blob '+stat.size+'\0');let size=0;for await(const chunk of file.createReadStream({autoClose:false})){size+=chunk.length;check(size<=this.maxSourceBytes,'repository_source_limit');hash.update(chunk);gitHash.update(chunk);}check(size===stat.size,'workspace_changed_during_capture');return {sha256:hash.digest('hex'),blob:gitHash.digest('hex'),mode:stat.mode&0o111?'100755':'100644',size};}catch(e){if(e.code==='ENOENT')return null;if(e instanceof AdapterError)throw e;throw new AdapterError('unsafe_workspace_entry');}finally{await file?.close();}
  }
  async readWorkspace(workspace,path,limit=5*1024*1024){validatePath(path);const pieces=path.split('/');let current=resolve(workspace);for(const part of pieces.slice(0,-1)){current=join(current,part);let stat;try{stat=await lstat(current);}catch(e){if(e.code==='ENOENT')return null;throw e;}check(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe_workspace_entry');}let file;try{file=await open(join(workspace,path),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();check(stat.isFile()&&stat.size<=limit,'unsafe_workspace_entry');const bytes=await file.readFile();check(bytes.length<=limit,'content_too_large');return {bytes,mode:stat.mode&0o111?'100755':'100644'};}catch(e){if(e.code==='ENOENT')return null;if(e instanceof AdapterError)throw e;throw new AdapterError('unsafe_workspace_entry');}finally{await file?.close();}}
  async collect(snapshot,workspace,excludePaths=[]){
    const before=await this.files(snapshot);
    return this.repository(snapshot.revision,async root=>{
      await this.run(['-C',root,'read-tree',snapshot.revision]);
      const paths=(await this.run(['--git-dir='+root,'--work-tree='+workspace,'ls-files','--cached','--others','--exclude-standard','-z'])).toString().split('\0').filter(Boolean);check(paths.length<=this.maxFiles,'repository_file_limit');
      const originals=new Map(before.map(f=>[f.path,f])),changes=[];let total=0;
      for(const path of [...new Set([...originals.keys(),...paths])].sort()){
        const prior=originals.get(path);if(!prior&&excludePaths.includes(path))continue;
        if(prior?.blob){const fingerprint=await this.fingerprint(workspace,path,prior.blob.length===64?'sha256':'sha1');if(fingerprint?.blob===prior.blob&&fingerprint.mode===prior.mode)continue;prior.sha256=sha256(await this.run(['-C',root,'cat-file','blob',prior.blob]));}
        const file=await this.readWorkspace(workspace,path);if(file)total+=file.bytes.length;check(total<=this.maxBytes,'repository_byte_limit');
        const digest=file?sha256(file.bytes):null;if(prior?.sha256===digest&&prior?.mode===file?.mode)continue;
        changes.push({path,before:prior?{sha256:prior.sha256,mode:prior.mode}:null,after:file?{sha256:digest,mode:file.mode,contentRef:(await this.store.put(file.bytes)).ref}:null});
      }
      if(!changes.length)return null;
      return validateChangeSet({version:1,source:snapshot.source,baseRevision:snapshot.revision,changes},snapshot);
    });
  }
  branch(changeId){return 'codex/metis-'+sha256(changeId).slice(0,40);}
  async publishMedia(intent){
    return this.repository(intent.snapshot.revision,async root=>{
      await this.run(['-C',root,'read-tree','--empty']);const images=new Map();
      for(const pair of intent.review.comparisons)for(const side of ['before','after'])images.set(pair[side].content.ref,pair[side]);
      let index='';for(const image of images.values()){
        const bytes=await this.store.get(image.content),{pngDimensions}=await import('./media.mjs'),size=pngDimensions(bytes);
        check(image.mimeType==='image/png'&&size.width===image.width&&size.height===image.height&&bytes.length===image.byteLength,'media_metadata_mismatch');
        const blob=(await this.run(['-C',root,'hash-object','-w','--stdin'],{input:bytes})).toString().trim();index+=`100644 ${blob}\t${image.content.sha256}.png\0`;
      }
      await this.run(['-C',root,'update-index','-z','--index-info'],{input:index});const tree=(await this.run(['-C',root,'write-tree'])).toString().trim();
      const head=(await this.run(['-C',root,'commit-tree',tree],{input:'Metis review images '+intent.idempotencyKey+'\n',env:{GIT_AUTHOR_NAME:'Metis',GIT_AUTHOR_EMAIL:'metis@example.invalid',GIT_COMMITTER_NAME:'Metis',GIT_COMMITTER_EMAIL:'metis@example.invalid',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'}})).toString().trim();
      const branch='codex/metis-media-'+sha256(intent.idempotencyKey).slice(0,40),current=await this.branchHead(branch);check(!current||current===head,'media_branch_moved');
      if(!current)await this.run(['-C',root,'push','--porcelain','--force-with-lease=refs/heads/'+branch+':',this.remote,head+':refs/heads/'+branch],{auth:true});
      return Array.from(images.values(),image=>({...image.content,url:'https://raw.githubusercontent.com/'+this.source.repository+'/'+head+'/'+image.content.sha256+'.png'}));
    });
  }
  async push(intent,branch,expected){
    return this.repository(intent.snapshot.revision,async root=>{
      await this.run(['-C',root,'read-tree',intent.snapshot.revision]);
      const baseline=new Map((await this.files(intent.snapshot)).map(f=>[f.path,f]));
      let index='';for(const file of intent.changeSet.changes){const previous=baseline.get(file.path);if(previous?.blob)previous.sha256=sha256(await this.run(['-C',root,'cat-file','blob',previous.blob]));check(file.before?previous?.sha256===file.before.sha256&&previous.mode===file.before.mode:!previous,'source_content_changed');
        if(!file.after){index+=`0 ${'0'.repeat(40)}\t${file.path}\0`;continue;}
        const bytes=await this.store.get({ref:file.after.contentRef,sha256:file.after.sha256});
        const blob=(await this.run(['-C',root,'hash-object','-w','--stdin'],{input:bytes})).toString().trim();check(oid.test(blob),'invalid_blob');index+=`${file.after.mode} ${blob}\t${file.path}\0`;
      }
      await this.run(['-C',root,'update-index','-z','--index-info'],{input:index});
      const tree=(await this.run(['-C',root,'write-tree'])).toString().trim();
      const message=intent.review.title+'\n\nMetis-Operation: '+intent.idempotencyKey+'\n';
      const commit=(await this.run(['-C',root,'commit-tree',tree,'-p',intent.snapshot.revision],{input:message,env:{GIT_AUTHOR_NAME:'Metis',GIT_AUTHOR_EMAIL:'metis@example.invalid',GIT_COMMITTER_NAME:'Metis',GIT_COMMITTER_EMAIL:'metis@example.invalid',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'}})).toString().trim();
      const current=await this.branchHead(branch);if(current===commit)return commit;
      check(current===(expected??null),'review_head_moved');
      check(await this.head()===intent.snapshot.revision,'stale_target_base');
      await this.run(['-C',root,'push','--porcelain',`--force-with-lease=refs/heads/${branch}:${expected??''}`,this.remote,`${commit}:refs/heads/${branch}`],{auth:true});return commit;
    });
  }
}

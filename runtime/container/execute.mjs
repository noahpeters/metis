import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomInt} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,readFile,open,rm,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';

export function validateSubscriptionAuth(raw) {
  const auth=JSON.parse(raw);
  if (auth.OPENAI_API_KEY || (auth.auth_mode && auth.auth_mode!=='chatgpt') || typeof auth.tokens?.access_token!=='string' || !auth.tokens.access_token || typeof auth.tokens?.id_token!=='string' || !auth.tokens.id_token) throw new Error('subscription_auth_required');
  return auth;
}
export function cliEnvironment(authDir) {
  // Deliberately exclude Worker, GitHub, Cloudflare and API key credentials.
  return {PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:authDir,CODEX_HOME:authDir,LANG:'C.UTF-8',TERM:'dumb'};
}
export function parseEvents(output) {
  const evidence={threadId:null,turnCompleted:false,commandCount:0,finalMessage:'',failed:false};
  for (const line of output.split('\n').filter(Boolean)) {
    const event=JSON.parse(line);
    if (event.type==='thread.started') evidence.threadId=event.thread_id;
    if (event.type==='turn.completed') evidence.turnCompleted=true;
    if (['turn.failed','error'].includes(event.type)) evidence.failed=true;
    if (event.type==='item.completed' && event.item?.type==='command_execution' && event.item.status==='completed' && event.item.exit_code===0) evidence.commandCount++;
    if (event.type==='item.completed' && event.item?.type==='agent_message') evidence.finalMessage=event.item.text;
  }
  return evidence;
}
async function collectArtifact(workspace,name) {
  let file;
  try {
    file=await open(join(workspace,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await file.stat();
    if (!stat.isFile() || stat.size>12000) return null;
    const buffer=Buffer.alloc(12001);const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>12000)return null;
    const content=buffer.subarray(0,bytesRead).toString('utf8');
    return {name,sha256:createHash('sha256').update(content).digest('hex'),content};
  } catch {return null;} finally {await file?.close();}
}
async function verifySolution(workspace) {
  const inputs=[[],Array.from({length:12},()=>randomInt(-10000,10000))].map(values=>({values,nonce:randomBytes(24).toString('hex')}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./verify-solution.mjs',import.meta.url)),join(workspace,'solution.mjs'),JSON.stringify(inputs)],{cwd:workspace,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});
  let output='';let bytes=0;let killed=false;
  const kill=()=>{killed=true;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(kill,3000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>20000)kill();else output+=chunk;});child.stderr.on('data',()=>{});
  let code;
  try {code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});}finally{clearTimeout(timer);}
  if(code!==0||killed)throw new Error('verification_process_failed');
  const results=JSON.parse(output);
  const cases=inputs.map(({values,nonce},index)=>({values,nonce,actual:results[index]}));
  const passed=cases.every(({values,nonce,actual})=>isDeepStrictEqual(actual,{count:values.length,sum:values.reduce((a,b)=>a+b,0),sorted:[...values].sort((a,b)=>a-b),nonceSha256:createHash('sha256').update(nonce).digest('hex')}));
  return {kind:'numeric_summary_v1',passed,cases};
}

export async function runCodex(task,rawAuth,{spawnProcess=spawn,timeoutMs=90000}={}) {
  let auth;
  try {auth=validateSubscriptionAuth(rawAuth);} catch {return {state:'blocked',reason:'subscription_auth_required'};}
  const root=await mkdtemp('/tmp/metis-codex-');
  const workspace=join(root,'workspace');const authDir=join(root,'auth');
  try {
    await mkdir(workspace,{mode:0o700});await mkdir(authDir,{mode:0o700});
    await writeFile(join(authDir,'auth.json'),JSON.stringify(auth),{mode:0o600});
    const startedAt=new Date().toISOString();
    const args=['exec','--json','--ephemeral','--ignore-user-config','--skip-git-repo-check','--sandbox','workspace-write','-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-C',workspace,'-'];
    let output='';let bytes=0;let killed=false;
    const child=spawnProcess('codex',args,{cwd:workspace,env:cliEnvironment(authDir),stdio:['pipe','pipe','pipe'],detached:true});
    const kill=()=>{killed=true;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const timer=setTimeout(kill,timeoutMs);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1_000_000)kill();else output+=chunk;});
    // Do not persist raw stderr, prompts or auth diagnostics into results/logs.
    child.stderr.on('data',()=>{});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
    child.stdin.on('error',()=>{});
    child.stdin.end('Execute the task below in this isolated workspace. Do not use GitHub, merge, deploy, or request API keys. Use shell commands to verify your work. If blocked, explain why.\n\n'+task.instructions);
    let exitCode;
    try {exitCode=await exited;} finally {clearTimeout(timer);}
    if(killed)return {state:'blocked',reason:'execution_timeout_or_output_limit'};
    const credentialValues=Object.values(auth.tokens).filter(value=>typeof value==='string'&&value.length>=8);
    try {
      const refreshed=validateSubscriptionAuth(await readFile(join(authDir,'auth.json'),'utf8'));
      credentialValues.push(...Object.values(refreshed.tokens).filter(value=>typeof value==='string'&&value.length>=8));
    } catch {return {state:'blocked',reason:'subscription_auth_cache_invalid'};}
    const containsCredential=text=>credentialValues.some(value=>text.includes(value));
    if(containsCredential(output))return {state:'blocked',reason:'credential_output_rejected'};
    let evidence;
    try {evidence=parseEvents(output);} catch {return {state:'failed',reason:'invalid_codex_event_stream'};}
    await rm(authDir,{recursive:true,force:true});
    let verification=null;
    if(task.verification==='numeric_summary_v1'){
      try{verification=await verifySolution(workspace);}catch{return {state:'failed',reason:'independent_code_verification_failed'};}
      if(!verification.passed)return {state:'failed',reason:'independent_code_verification_failed'};
    }
    const artifacts=(await Promise.all(['result.json','solution.mjs'].map(name=>collectArtifact(workspace,name)))).filter(Boolean);
    if(artifacts.some(file=>containsCredential(file.content)))return {state:'blocked',reason:'credential_output_rejected'};
    const result={operation:'codex_exec',taskId:task.taskId,billingMode:'included_subscription',startedAt,completedAt:new Date().toISOString(),exitCode,...evidence,artifacts,verification};
    if (exitCode!==0 || evidence.failed || !evidence.turnCompleted || !evidence.threadId || evidence.commandCount<1 || !evidence.finalMessage || Buffer.byteLength(JSON.stringify(result))>48000) return {state:'blocked',reason:'codex_execution_not_verified'};
    return {state:'completed',result};
  } catch {return {state:'blocked',reason:'runtime_execution_error'};}
  finally {await rm(root,{recursive:true,force:true});}
}

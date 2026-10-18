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
  return {PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:authDir,CODEX_HOME:authDir,LANG:'C.UTF-8',TERM:'dumb',...(process.env.PLAYWRIGHT_BROWSERS_PATH?{PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH}:{})};
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
// Only fixed hints, counters, timing and a validated thread UUID may survive
// interruption. Command text, output, diagnostics and item IDs stay in memory.
export function createExecutionProgress(credentials=[],clock=Date.now,{captureCommandOutput=false}={}) {
  const started=clock(),completed=new Set(),commands=[];let pending='',threadId=null,count=0,last=null,lastActivity=started,lastEvent=null,commandsTruncated=0;
  const duration=from=>Math.max(0,Math.min(86400000,Math.round(clock()-from)));
  const scrub=text=>{
    if(typeof text!=='string')return '';
    for(const secret of credentials)if(typeof secret==='string'&&secret.length>=8)text=text.split(secret).join('[redacted]');
    // Fail closed for credential-like log lines, private keys and token strings.
    text=text.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*/g,'[redacted]')
      .replace(/^.*(?:authorization|bearer\s|cookie|access_token|refresh_token|id_token|api[_-]?key|password|secret[=:]).*$/gim,'[redacted]')
      .replace(/[A-Za-z0-9_+/=-]{32,}/g,'[redacted]');
    return text.length>2000?text.slice(-2000).replace(/^[^\n]*(?:\n|$)/,''):text;
  };
  const hint=command=>{
    if(typeof command!=='string')return 'other';
    const matches=[...command.matchAll(/(?:^|[\s/'"])pnpm(?:\s+run)?\s+(lint|typecheck|test|build:worker|build)(?=$|[\s;|&'"])/g)];
    const scripts=[...new Set(matches.map(m=>m[1]))];
    // These are command-text hints, not proof that a check ran or passed.
    if(scripts.length>1)return 'verification_batch';
    if(scripts.length===1)return 'pnpm_'+scripts[0].replace(':','_');
    if(/(?:^|[\s/'"])python3?(?:\s|$)/.test(command))return 'python';
    if(/(?:^|[\s/'"])node(?:\s|$)/.test(command))return 'node';
    return 'other';
  };
  return {
    push(chunk){
      pending+=chunk.toString();let newline;
      while((newline=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);let event;
        try{event=JSON.parse(line);}catch{continue;}
        if(event?.type==='thread.started'&&typeof event.thread_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.thread_id))threadId=event.thread_id;
        const item=event?.item;
        const kind=['thread.started','turn.started','turn.completed','turn.failed','error'].includes(event?.type)?event.type:
          ['item.started','item.updated','item.completed'].includes(event?.type)&&['command_execution','agent_message','reasoning'].includes(item?.type)?event.type+':'+item.type:null;
        if(kind){lastActivity=clock();lastEvent=kind;}
        if(item?.type!=='command_execution')continue;
        const id=typeof item.id==='string'&&item.id.length<=128?item.id:null;
        if(event.type==='item.started'){
          last={id,hint:hint(item.command),status:'running',started:clock(),finished:null};commands.push(last);
          if(commands.length>32){commands.shift();commandsTruncated++;}
        }
        if(event.type==='item.completed'){
          if(id&&completed.has(id))continue;
          if(item.status==='completed'&&item.exit_code===0)count=Math.min(10000,count+1);if(id)completed.add(id);
          let entry=id?commands.find(c=>c.id===id&&c.finished===null):null;
          if(!entry){entry={id,hint:hint(item.command),started:clock()};commands.push(entry);if(commands.length>32){commands.shift();commandsTruncated++;}}
          Object.assign(entry,{status:item.status==='completed'&&item.exit_code===0?'completed':'failed',finished:clock()});last=entry;
        }
        if(captureCommandOutput&&typeof item.aggregated_output==='string'){
          const entry=id?commands.find(c=>c.id===id):last;
          if(entry){entry.outputTail=scrub(item.aggregated_output);let budget=8000;for(let i=commands.length-1;i>=0;i--){if(commands[i].outputTail){commands[i].outputTail=commands[i].outputTail.slice(-Math.max(0,Math.min(budget,2000)));if(!budget)delete commands[i].outputTail;else budget-=commands[i].outputTail.length;}}}
        }
      }
    },
    snapshot(){const timing=c=>({hint:c.hint,status:c.status,elapsedMs:Math.max(0,Math.min(86400000,(c.finished??clock())-c.started))});return {threadId:threadId&&!credentials.some(v=>typeof v==='string'&&v.length>=8&&(threadId.includes(v)||v.includes(threadId)))?threadId:null,commandCount:count,executionProgress:{elapsedMs:duration(started),idleMs:duration(lastActivity),lastEvent,commandsTruncated,commands:commands.map(c=>({...timing(c),startedMs:Math.max(0,Math.min(86400000,c.started-started)),...(c.outputTail?{outputTail:scrub(c.outputTail)}:{})})),lastCommand:last?timing(last):null}};}
  };
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

export async function runCodex(task,rawAuth,{spawnProcess=spawn,timeoutMs=90000,workspacePath,onProgress,captureCommandOutput=false}={}) {
  let auth;
  try {auth=validateSubscriptionAuth(rawAuth);} catch {return {state:'blocked',reason:'subscription_auth_required'};}
  const root=await mkdtemp('/tmp/metis-codex-');
  const workspace=workspacePath??join(root,'workspace');const authDir=join(root,'auth');
  try {
    if(!workspacePath)await mkdir(workspace,{mode:0o700});await mkdir(authDir,{mode:0o700});
    await writeFile(join(authDir,'auth.json'),JSON.stringify(auth),{mode:0o600});
    const startedAt=new Date().toISOString();
    const args=['exec','--json','--ephemeral','--ignore-user-config','--skip-git-repo-check','--sandbox','workspace-write','-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-C',workspace];
    if(task.repositoryBinding){const schema=join(root,'outcome.schema.json');await writeFile(schema,JSON.stringify({type:'object',properties:{status:{type:'string',enum:['completed','blocked'],description:'Choose blocked if work is incomplete or project instructions require unresolved human input or approval.'},summary:{type:'string'},blockers:{type:'array',items:{type:'string'}}},required:['status','summary','blockers'],additionalProperties:false}),{mode:0o600});args.push('--output-schema',schema);}
    args.push('-');
    let output='';let diagnostic='';let bytes=0;let terminationReason=null;
    const credentialValues=Object.values(auth.tokens).filter(value=>typeof value==='string'&&value.length>=8),progress=createExecutionProgress(credentialValues,Date.now,{captureCommandOutput});
    const refreshCredentials=async()=>{try{for(const v of Object.values(validateSubscriptionAuth(await readFile(join(authDir,'auth.json'),'utf8')).tokens))if(typeof v==='string'&&v.length>=8&&!credentialValues.includes(v))credentialValues.push(v);}catch{}};
    const child=spawnProcess('codex',args,{cwd:workspace,env:cliEnvironment(authDir),stdio:['pipe','pipe','pipe'],detached:true});
    const kill=reason=>{if(terminationReason)return;terminationReason=reason;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const timer=setTimeout(()=>kill('execution_timeout'),timeoutMs);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1_000_000)kill('execution_output_limit');else {output+=chunk;progress.push(chunk);}});
    // Raw diagnostics stay in memory only. Persist a fixed category, never text.
    child.stderr.on('data',chunk=>{if(diagnostic.length<16000)diagnostic+=chunk.toString().slice(0,16000-diagnostic.length);});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
    // One best-effort write in flight; never queue a backlog of heartbeat writes.
    let pendingProgress=null;
    const report=()=>{if(typeof onProgress!=='function'||pendingProgress)return;pendingProgress=Promise.resolve().then(async()=>{await refreshCredentials();await onProgress(progress.snapshot());}).catch(()=>{}).finally(()=>{pendingProgress=null;});};
    const progressTimer=typeof onProgress==='function'?setInterval(report,5000):null;report();
    child.stdin.on('error',()=>{});
    child.stdin.end('Execute the task below in this isolated workspace. Do not use GitHub, merge, deploy, or request API keys. Use shell commands to verify your work. If blocked, explain why.\n\n'+task.instructions);
    let exitCode;
    try {exitCode=await exited;} finally {clearTimeout(timer);if(progressTimer)clearInterval(progressTimer);await pendingProgress;}
    if(terminationReason){
      try{credentialValues.push(...Object.values(validateSubscriptionAuth(await readFile(join(authDir,'auth.json'),'utf8')).tokens));}catch{}
      return {state:'blocked',reason:terminationReason,result:progress.snapshot()};
    }
    try {
      const refreshed=validateSubscriptionAuth(await readFile(join(authDir,'auth.json'),'utf8'));
      credentialValues.push(...Object.values(refreshed.tokens).filter(value=>typeof value==='string'&&value.length>=8));
    } catch {return {state:'blocked',reason:'subscription_auth_cache_invalid'};}
    const containsCredential=text=>credentialValues.some(value=>text.includes(value));
    if(containsCredential(output))return {state:'blocked',reason:'credential_output_rejected'};
    let evidence;
    try {evidence=parseEvents(output);} catch {return {state:'failed',reason:'invalid_codex_event_stream'};}
    await rm(authDir,{recursive:true,force:true});
    if (exitCode!==0 || evidence.failed || !evidence.turnCompleted || !evidence.threadId || (!task.repositoryBinding&&evidence.commandCount<1) || !evidence.finalMessage) {
      const text=diagnostic+'\n'+output;
      const category=/unexpected argument|unrecognized option|unknown option/i.test(text)?'unsupported_option':/401|unauthorized|refresh.token|authentication|not logged in/i.test(text)?'authentication':/bwrap|bubblewrap|landlock|sandbox|operation not permitted/i.test(text)?'sandbox':'unclassified';
      return {state:'blocked',reason:`codex_execution_not_verified_exit_${Number.isInteger(exitCode)?exitCode:'unknown'}_${category}`,result:progress.snapshot()};
    }
    let agentOutcome=null;
    if(task.repositoryBinding){
      try{agentOutcome=JSON.parse(evidence.finalMessage);}catch{return {state:'blocked',reason:'repository_outcome_invalid'};}
      if(!agentOutcome||typeof agentOutcome!=='object'||Object.keys(agentOutcome).some(k=>!['status','summary','blockers'].includes(k))||Buffer.byteLength(JSON.stringify(agentOutcome))>32000||!['completed','blocked'].includes(agentOutcome.status)||typeof agentOutcome.summary!=='string'||!agentOutcome.summary.trim()||!Array.isArray(agentOutcome.blockers)||agentOutcome.blockers.length>20||agentOutcome.blockers.some(item=>typeof item!=='string'||!item.trim()||item.length>1000))return {state:'blocked',reason:'repository_outcome_invalid'};
      evidence.finalMessage=agentOutcome.summary;
      if(agentOutcome.status==='blocked')return {state:'blocked',reason:'repository_agent_blocked',result:{operation:'codex_exec',taskId:task.taskId,billingMode:'included_subscription',startedAt,completedAt:new Date().toISOString(),exitCode,...evidence,executionProgress:progress.snapshot().executionProgress,blockers:agentOutcome.blockers.length?agentOutcome.blockers:[agentOutcome.summary]}};
      if(agentOutcome.blockers.length)return {state:'blocked',reason:'repository_outcome_inconsistent'};
      if(evidence.commandCount<1)return {state:'blocked',reason:'repository_no_successful_verification_command'};
    }
    let verification=null;
    if(task.verification==='numeric_summary_v1'){
      try{verification=await verifySolution(workspace);}catch{return {state:'failed',reason:'independent_code_verification_failed'};}
      if(!verification.passed)return {state:'failed',reason:'independent_code_verification_failed'};
    }
    const artifacts=task.repositoryBinding?[]:(await Promise.all(['result.json','solution.mjs'].map(name=>collectArtifact(workspace,name)))).filter(Boolean);
    if(artifacts.some(file=>containsCredential(file.content)))return {state:'blocked',reason:'credential_output_rejected'};
    const result={operation:'codex_exec',taskId:task.taskId,billingMode:'included_subscription',startedAt,completedAt:new Date().toISOString(),exitCode,...evidence,artifacts,verification,...(agentOutcome?{agentOutcome,executionProgress:progress.snapshot().executionProgress}:{})};
    if (Buffer.byteLength(JSON.stringify(result))>48000) return {state:'blocked',reason:'codex_result_exceeded_limit'};
    return {state:'completed',result};
  } catch {return {state:'blocked',reason:'runtime_execution_error'};}
  finally {await rm(root,{recursive:true,force:true});}
}

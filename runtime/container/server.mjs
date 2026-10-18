import {createServer} from 'node:http';
import {runRepositoryTask} from '../repositories/run.mjs';
import {runPublisherCommand} from '../repositories/publisher.mjs';
import {runCodex} from './execute.mjs';
let auth=process.env.CODEX_SUBSCRIPTION_AUTH_JSON??'';
delete process.env.CODEX_SUBSCRIPTION_AUTH_JSON;
let repositoryConfig;try {repositoryConfig=JSON.parse(process.env.METIS_REPOSITORY_CONFIG??'null');} catch {}
delete process.env.METIS_REPOSITORY_CONFIG;
let publisherConfig;try{publisherConfig=JSON.parse(process.env.METIS_PUBLISHER_CONFIG??'null');}catch{}
delete process.env.METIS_PUBLISHER_CONFIG;
let used=false;
// No logs of request bodies, credentials or raw Codex output. Only the private
// Container DO can route to this port; the runtime Worker has no public route.
const server=createServer(async(req,res)=>{
  const send=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/health')return send({ok:true});
  if(req.method!=='POST'||req.url!==(publisherConfig?'/publish':'/execute'))return send({error:'not found'},404);
  if(used)return send({state:'blocked',reason:'container_already_used'},409);
  let buffer='';
  try {
    for await (const chunk of req){buffer+=chunk;if(Buffer.byteLength(buffer)>1048576)return send({error:'request too large'},413);}
    const task=JSON.parse(buffer);
    if(publisherConfig){used=true;return send(await runPublisherCommand(task,publisherConfig));}
    if(typeof task.taskId!=='string'||typeof task.instructions!=='string'||!task.instructions.trim()||task.instructions.length>10000)return send({error:'invalid task'},400);
    used=true;
    const result=task.repositoryBinding?await runRepositoryTask(task,auth,repositoryConfig):await runCodex(task,auth);auth='';send(result);
  }catch {auth='';send({state:'blocked',reason:'runtime_request_error'},500);}
});
// Explicit handlers are required when Node is the container's PID 1.
const shutdown=()=>{
  auth='';
  server.close(()=>process.exit(0));
  server.closeAllConnections();
  setTimeout(()=>process.exit(1),2000).unref();
};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
server.listen(Number(process.env.PORT??8080),'0.0.0.0',()=>{
  // IPC is present only in the subprocess lifecycle test; production logs stay empty.
  process.send?.({port:server.address().port});
});

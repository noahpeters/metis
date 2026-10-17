import {createServer} from 'node:http';
import {runCodex} from './execute.mjs';
let auth=process.env.CODEX_SUBSCRIPTION_AUTH_JSON??'';
delete process.env.CODEX_SUBSCRIPTION_AUTH_JSON;
let used=false;
// No logs of request bodies, credentials or raw Codex output. Only the private
// Container DO can route to this port; the runtime Worker has no public route.
createServer(async(req,res)=>{
  const send=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/health')return send({ok:true});
  if(req.method!=='POST'||req.url!=='/execute')return send({error:'not found'},404);
  if(used)return send({state:'blocked',reason:'container_already_used'},409);
  let buffer='';
  try {
    for await (const chunk of req){buffer+=chunk;if(Buffer.byteLength(buffer)>20000)return send({error:'request too large'},413);}
    const task=JSON.parse(buffer);
    if(typeof task.taskId!=='string'||typeof task.instructions!=='string'||!task.instructions.trim()||task.instructions.length>10000)return send({error:'invalid task'},400);
    used=true;
    const result=await runCodex(task,auth);auth='';send(result);
  }catch {auth='';send({state:'blocked',reason:'runtime_request_error'},500);}
}).listen(8080,'0.0.0.0');

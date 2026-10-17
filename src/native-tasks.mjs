import { emailAllowed } from './ui/auth.mjs';
import { executeStandaloneCodex } from './standalone-codex.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const fail = (message,status=400)=>json({error:{message}},status);
const attemptsSQL = `SELECT a.*,s.state,s.error,s.created_at AS queued_at,s.execution_started_at,s.updated_at,s.result_json FROM native_task_attempts a JOIN standalone_tasks s ON s.id=a.id`;
const latestSQL = `(SELECT a.id FROM native_task_attempts a WHERE a.task_id=t.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)`;
const tasksSQL = `SELECT t.*,s.state AS execution_state,s.error,s.id AS attempt_id FROM native_tasks t LEFT JOIN standalone_tasks s ON s.id=${latestSQL}`;
function taskView(row) {
  const {data_json,mutation_token,...task}=row;
  return {...task,data:JSON.parse(data_json),state:task.execution_state??task.phase};
}
function attemptView(row) {
  const {result_json,...attempt}=row;
  const result=result_json?JSON.parse(result_json):null;
  return {...attempt,result,thread_id:result?.threadId??null,url:`/tasks/${row.task_id}/attempts/${row.id}`};
}
export async function nativeTasksForIdentity(email,method,path,body,env) {
  if (!emailAllowed(email)) return fail('A verified from-trees.com identity is required',403);
  email=email.trim().toLowerCase();
  const parts=path.split('/').filter(Boolean);
  if (parts[0]!=='api'||parts[1]!=='tasks'||parts.length>4) return fail('Not found',404);
  const id=parts[2],action=parts[3];
  if(id&&!uuid.test(id)) return fail('Invalid task ID',400);
  if(method==='GET'&&!action) {
    if(!id) {
      const rows=await env.DB.prepare(tasksSQL+' ORDER BY t.created_at DESC,t.rowid DESC LIMIT 200').all();
      return json({tasks:rows.results.map(taskView),limit:200});
    }
    const row=await env.DB.prepare(tasksSQL+' WHERE t.id=?').bind(id).first();
    if(!row)return fail('Task not found',404);
    const dependencies=await env.DB.prepare(`SELECT t.id,t.title,COALESCE(s.state,t.phase) AS state FROM native_task_dependencies d JOIN native_tasks t ON t.id=d.dependency_id LEFT JOIN standalone_tasks s ON s.id=${latestSQL} WHERE d.task_id=? ORDER BY t.title`).bind(id).all();
    const attempts=await env.DB.prepare(attemptsSQL+' WHERE a.task_id=? ORDER BY a.created_at DESC,a.rowid DESC').bind(id).all();
    const events=await env.DB.prepare('SELECT e.* FROM standalone_task_events e JOIN native_task_attempts a ON a.id=e.task_id WHERE a.task_id=? ORDER BY e.sequence').bind(id).all();
    return json({task:taskView(row),dependencies:dependencies.results,attempts:attempts.results.map(attemptView),events:events.results});
  }
  if(method!=='POST'||!body||typeof body!=='object'||Array.isArray(body))return fail('Invalid request');
  if(!id||action==='edit') {
    if(!uuid.test(body.id??id??'')) return fail('A UUID is required');
    const title=typeof body.title==='string'?body.title.trim():'';
    if(!title||title.length>200||typeof body.instructions!=='string'||!body.instructions.trim()||body.instructions.length>10000)return fail('Title and instructions are required (200 / 10000 characters maximum)');
    if(!body.data||typeof body.data!=='object'||Array.isArray(body.data))return fail('Task data must be a JSON object');
    const data=JSON.stringify(body.data);
    if(new TextEncoder().encode(data).length>16000)return fail('Task data exceeds 16 KB');
    if(!id) {
      await env.DB.prepare('INSERT OR IGNORE INTO native_tasks(id,title,instructions,data_json,created_by) VALUES (?,?,?,?,?)').bind(body.id,title,body.instructions,data,email).run();
      const existing=await env.DB.prepare('SELECT * FROM native_tasks WHERE id=?').bind(body.id).first();
      if(existing.title!==title||existing.instructions!==body.instructions||existing.data_json!==data||existing.created_by!==email)return fail('Task ID already exists with different content',409);
      return json({id:body.id},201);
    }
    const changed=await env.DB.prepare("UPDATE native_tasks SET title=?,instructions=?,data_json=?,version=version+1,updated_at=unixepoch() WHERE id=? AND version=? AND phase='draft'").bind(title,body.instructions,data,id,body.version??0).run();
    return changed.meta.changes?json({id}):fail('Task changed or is no longer a draft',409);
  }
  const task=await env.DB.prepare('SELECT * FROM native_tasks WHERE id=?').bind(id).first();
  if(!task)return fail('Task not found',404);
  if(action==='start'&&uuid.test(body.attempt_id??'')) {
    const existing=await env.DB.prepare('SELECT task_id FROM native_task_attempts WHERE id=?').bind(body.attempt_id).first();
    if(existing)return existing.task_id===id?json({id,attempt_id:body.attempt_id},202):fail('Attempt ID conflict',409);
  }
  if(!Number.isInteger(body.version)||body.version!==task.version)return fail('Task changed; refresh before acting',409);
  if(action==='dependencies') {
    if(!Array.isArray(body.dependencies)||body.dependencies.length>40||body.dependencies.some(d=>!uuid.test(d)||d===id)||new Set(body.dependencies).size!==body.dependencies.length)return fail('Supply up to 40 distinct dependency IDs, excluding this task');
    // Validate and mutate in one D1 transaction. The recursive CTE terminates
    // even on corrupt input; a concurrent edge edit cannot introduce a cycle.
    const deps=body.dependencies;
    const eligible=`EXISTS (SELECT 1 FROM native_tasks WHERE id=? AND version=? AND phase='draft')`;
    const valid=deps.length?` AND (SELECT count(*) FROM native_tasks WHERE id IN (${deps.map(()=>'?')}))=${deps.length} AND NOT EXISTS (WITH RECURSIVE ancestors(id) AS (SELECT dependency_id FROM native_task_dependencies WHERE task_id IN (${deps.map(()=>'?')}) UNION SELECT d.dependency_id FROM native_task_dependencies d JOIN ancestors a ON d.task_id=a.id) SELECT 1 FROM ancestors WHERE id=?)`:'';
    const conditions=[id,body.version,...deps,...deps,...(deps.length?[id]:[])];
    const mutation=crypto.randomUUID();
    const result=await env.DB.batch([
      env.DB.prepare(`UPDATE native_tasks SET mutation_token=?,version=version+1,updated_at=unixepoch() WHERE id=? AND ${eligible}${valid}`).bind(mutation,id,...conditions),
      env.DB.prepare(`DELETE FROM native_task_dependencies WHERE task_id=? AND EXISTS (SELECT 1 FROM native_tasks WHERE id=? AND mutation_token=? AND phase='draft')`).bind(id,id,mutation),
      ...deps.map(d=>env.DB.prepare(`INSERT INTO native_task_dependencies(task_id,dependency_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM native_tasks WHERE id=? AND mutation_token=? AND phase='draft')`).bind(id,d,id,mutation))
    ]);
    return result[0].meta.changes?json({id}):fail('Draft changed, missing dependency, or dependency cycle',409);
  }
  if(action==='ready'||action==='cancel') {
    const result=await env.DB.prepare(`UPDATE native_tasks SET phase=?,version=version+1,updated_at=unixepoch() WHERE id=? AND version=? AND phase IN ('draft','ready') AND NOT EXISTS (SELECT 1 FROM native_task_attempts WHERE task_id=?)`).bind(action==='ready'?'ready':'cancelled',id,body.version,id).run();
    return result.meta.changes?json({id}):fail('Only unexecuted tasks can change readiness',409);
  }
  if(action==='start') {
    if(env.STANDALONE_CODEX_ENABLED!=='true'||!env.CODEX_RUNTIME)return fail('Cloud Codex runtime is unavailable',503);
    if(!uuid.test(body.attempt_id??''))return fail('An attempt UUID is required');
    const existing=await env.DB.prepare('SELECT task_id FROM native_task_attempts WHERE id=?').bind(body.attempt_id).first();
    if(existing)return existing.task_id===id?json({id,attempt_id:body.attempt_id},202):fail('Attempt ID conflict',409);
    // Reserve the single native execution atomically, including dependency and
    // prior-attempt checks. Never replay an ambiguous execution as a new run.
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO standalone_tasks(id,instructions,state,executor) SELECT ?,instructions,'queued','codex' FROM native_tasks t WHERE t.id=? AND t.version=? AND t.phase='ready' AND (NOT EXISTS (SELECT 1 FROM native_task_attempts WHERE task_id=t.id) OR EXISTS (SELECT 1 FROM standalone_tasks prior WHERE prior.id=${latestSQL} AND prior.state IN ('blocked','failed') AND json_extract(prior.result_json,'$.containerStopped')=1)) AND NOT EXISTS (SELECT 1 FROM standalone_tasks WHERE executor='codex' AND (state IN ('queued','running') OR (id IN (SELECT id FROM native_task_attempts) AND state IN ('blocked','failed') AND COALESCE(json_extract(result_json,'$.containerStopped'),0)<>1))) AND NOT EXISTS (SELECT 1 FROM native_task_dependencies d WHERE d.task_id=t.id AND NOT EXISTS (SELECT 1 FROM native_task_attempts a JOIN standalone_tasks s ON s.id=a.id WHERE a.task_id=d.dependency_id AND s.state='completed'))`).bind(body.attempt_id,id,body.version),
      env.DB.prepare('INSERT OR IGNORE INTO native_task_attempts(id,task_id,requested_by) SELECT id,?,? FROM standalone_tasks WHERE id=? AND changes()=1').bind(id,email,body.attempt_id),
      env.DB.prepare('UPDATE native_tasks SET version=version+1,updated_at=unixepoch() WHERE id=? AND EXISTS (SELECT 1 FROM native_task_attempts WHERE id=? AND task_id=?) AND version=?').bind(id,body.attempt_id,id,body.version)
    ]);
    if(!result[0].meta.changes)return fail('Dependencies incomplete, capacity unavailable, or task already attempted. Inspect execution history before retrying.',409);
    await sendNativeAttempt(env,body.attempt_id).catch(()=>{});
    return json({id,attempt_id:body.attempt_id},202);
  }
  return fail('Not found',404);
}
async function sendNativeAttempt(env,id) {
  await env.DISPATCH_QUEUE.send({type:'native_codex',taskId:id});
  await env.DB.prepare('UPDATE native_task_attempts SET sent_at=unixepoch() WHERE id=?').bind(id).run();
}
export async function flushNativeOutbox(env) {
  const rows=await env.DB.prepare("SELECT a.id FROM native_task_attempts a JOIN standalone_tasks s ON s.id=a.id WHERE s.state='queued' AND (a.sent_at IS NULL OR a.sent_at<unixepoch()-60) LIMIT 10").all();
  for(const row of rows.results)await sendNativeAttempt(env,row.id);
}
export async function executeNativeAttempt(env,id,attempts) {
  const row=await env.DB.prepare('SELECT id FROM native_task_attempts WHERE id=?').bind(id).first();
  if(row)await executeStandaloneCodex(env,id,attempts);
}

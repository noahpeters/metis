const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type":"application/json","cache-control":"no-store"}});
export async function submitStandalone(request, env) {
  if (!env.STANDALONE_DISPATCH_TOKEN || request.headers.get("authorization") !== `Bearer ${env.STANDALONE_DISPATCH_TOKEN}`) return json({error:"unauthorized"},401);
  let body;
  try { body = await request.json(); } catch { return json({error:"invalid JSON"},400); }
  if (typeof body?.instructions !== "string" || !body.instructions.trim() || body.instructions.length > 10000) return json({error:"instructions must contain 1-10000 characters"},400);
  const executor=body.executor??'proof';
  if (!['proof','codex'].includes(executor)) return json({error:'unknown executor'},400);
  if (executor==='codex' && (env.STANDALONE_CODEX_ENABLED!=='true' || !env.CODEX_RUNTIME)) return json({error:'Cloud Codex runtime disabled'},503);
  const verification=body.verification??null;
  if (verification!==null && (executor!=='codex' || verification!=='numeric_summary_v1')) return json({error:'unknown verification'},400);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO standalone_tasks (id,instructions,state,executor,verification) VALUES (?,?,'queued',?,?)").bind(id,body.instructions,executor,verification).run();
  try {
    await env.DISPATCH_QUEUE.send({type:executor==='codex'?'standalone_codex':'standalone_proof',taskId:id});
  } catch {
    await env.DB.prepare("UPDATE standalone_tasks SET state='failed',error='Queue submission failed',updated_at=unixepoch() WHERE id=? AND state='queued'").bind(id).run();
    return json({id,state:"failed",error:"Queue submission failed"},503);
  }
  return json({id,state:"queued"},202);
}
export async function standaloneStatus(request, env, id) {
  if (!env.STANDALONE_DISPATCH_TOKEN || request.headers.get("authorization") !== `Bearer ${env.STANDALONE_DISPATCH_TOKEN}`) return json({error:"unauthorized"},401);
  const row = await env.DB.prepare("SELECT id,state,executor,artifact_key,result_json,error,created_at,updated_at FROM standalone_tasks WHERE id=?").bind(id).first();
  if (!row) return json({error:"not found"},404);
  const {result_json, ...task} = row;
  return json({...task, result: result_json ? JSON.parse(result_json) : null});
}
export async function executeStandaloneProof(env, id, attempts = 1) {
  // A lease permits recovery after a consumer crash; the claim token fences a
  // stale consumer from committing over its replacement. No external effects.
  const claimToken = crypto.randomUUID();
  const claim = await env.DB.prepare("UPDATE standalone_tasks SET state='running',claim_token=?,execution_started_at=COALESCE(execution_started_at,unixepoch()),updated_at=unixepoch() WHERE id=? AND (state='queued' OR (state='running' AND updated_at<=unixepoch()-60))").bind(claimToken,id).run();
  if (!claim.meta.changes) {
    const row = await env.DB.prepare("SELECT state FROM standalone_tasks WHERE id=?").bind(id).first();
    if (row?.state === 'running') throw new Error("Standalone task lease is active");
    return;
  }
  try {
    const row = await env.DB.prepare("SELECT instructions,execution_started_at FROM standalone_tasks WHERE id=?").bind(id).first();
    // Instructions are echoed as data, never evaluated. Stable across retries.
    const result = {operation:"standalone_proof",version:1,taskId:id,instructions:row.instructions,executedAt:new Date(row.execution_started_at * 1000).toISOString(),status:"completed"};
    await env.DB.prepare("UPDATE standalone_tasks SET state='completed',result_json=?,error=NULL,claim_token=NULL,updated_at=unixepoch() WHERE id=? AND state='running' AND claim_token=?").bind(JSON.stringify(result),id,claimToken).run();
  } catch (error) {
    // Production Queue allows three retries (four total delivery attempts).
    // Store a bounded diagnostic without copying instructions or secrets.
    await env.DB.prepare("UPDATE standalone_tasks SET state=?,error='Proof persistence failed',claim_token=NULL,updated_at=unixepoch() WHERE id=? AND state='running' AND claim_token=?").bind(attempts >= 4 ? 'failed' : 'queued',id,claimToken).run();
    throw error;
  }
}

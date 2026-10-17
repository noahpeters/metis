const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type":"application/json","cache-control":"no-store"}});
export async function submitStandalone(request, env) {
  if (!env.STANDALONE_DISPATCH_TOKEN || request.headers.get("authorization") !== `Bearer ${env.STANDALONE_DISPATCH_TOKEN}`) return json({error:"unauthorized"},401);
  let body;
  try { body = await request.json(); } catch { return json({error:"invalid JSON"},400); }
  if (typeof body?.instructions !== "string" || !body.instructions.trim() || body.instructions.length > 10000) return json({error:"instructions must contain 1-10000 characters"},400);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO standalone_tasks (id,instructions,state) VALUES (?,?,'queued')").bind(id,body.instructions).run();
  await env.DISPATCH_QUEUE.send({type:"standalone_proof",taskId:id});
  return json({id,state:"queued"},202);
}
export async function standaloneStatus(request, env, id) {
  if (!env.STANDALONE_DISPATCH_TOKEN || request.headers.get("authorization") !== `Bearer ${env.STANDALONE_DISPATCH_TOKEN}`) return json({error:"unauthorized"},401);
  const row = await env.DB.prepare("SELECT id,state,artifact_key,error,created_at,updated_at FROM standalone_tasks WHERE id=?").bind(id).first();
  return row ? json(row) : json({error:"not found"},404);
}
export async function executeStandaloneProof(env, id) {
  const claim = await env.DB.prepare("UPDATE standalone_tasks SET state='running',updated_at=unixepoch() WHERE id=? AND state='queued'").bind(id).run();
  if (!claim.meta.changes) return;
  try {
    const row = await env.DB.prepare("SELECT instructions FROM standalone_tasks WHERE id=?").bind(id).first();
    const key = `standalone-proof/${id}.txt`;
    await env.STANDALONE_ARTIFACTS.put(key, `Metis standalone execution proof\nTask: ${id}\nInstructions: ${row.instructions}\n`);
    await env.DB.prepare("UPDATE standalone_tasks SET state='completed',artifact_key=?,updated_at=unixepoch() WHERE id=?").bind(key,id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE standalone_tasks SET state='failed',error=?,updated_at=unixepoch() WHERE id=?").bind(String(error).slice(0,500),id).run();
    throw error;
  }
}

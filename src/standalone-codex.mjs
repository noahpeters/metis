// Real execution occurs in the private cloud runtime Worker, never in this
// control-plane isolate. The runtime durably deduplicates execution by task ID.
export async function executeStandaloneCodex(env,id,attempts=1) {
  const row=await env.DB.prepare("SELECT id,instructions,state,verification FROM standalone_tasks WHERE id=? AND executor='codex'").bind(id).first();
  if (!row || ['completed','failed','blocked'].includes(row.state)) return;
  if (env.STANDALONE_CODEX_ENABLED!=='true' || !env.CODEX_RUNTIME) {
    await env.DB.prepare("UPDATE standalone_tasks SET state='blocked',error='Cloud Codex runtime is disabled or unavailable',updated_at=unixepoch() WHERE id=? AND state IN ('queued','running')").bind(id).run();
    return;
  }
  await env.DB.prepare("UPDATE standalone_tasks SET state='running',execution_started_at=COALESCE(execution_started_at,unixepoch()),updated_at=unixepoch() WHERE id=? AND state='queued'").bind(id).run();
  try {
    const receipt=await env.CODEX_RUNTIME.execute({taskId:id,instructions:row.instructions,verification:row.verification});
    if (!receipt || !['completed','blocked','failed'].includes(receipt.state)) throw new Error('Invalid cloud runtime receipt');
    const result=receipt.result;
    if (receipt.state==='completed' && (result?.operation!=='codex_exec' || result.taskId!==id || result.billingMode!=='included_subscription' || result.exitCode!==0 || result.turnCompleted!==true || typeof result.threadId!=='string' || !result.threadId || !Number.isInteger(result.commandCount) || result.commandCount<1)) throw new Error('Cloud runtime did not supply command execution evidence');
    if (receipt.state==='completed' && row.verification && (result.verification?.kind!==row.verification || result.verification.passed!==true)) throw new Error('Cloud runtime independent verification missing');
    if (receipt.state==='completed' && result.containerStopped!==true) throw new Error('Cloud runtime shutdown was not confirmed');
    const encoded=JSON.stringify(result??null);
    if (new TextEncoder().encode(encoded).length>48000) throw new Error('Cloud runtime result exceeded limit');
    await env.DB.prepare("UPDATE standalone_tasks SET state=?,result_json=?,error=?,updated_at=unixepoch() WHERE id=? AND state='running'").bind(receipt.state,encoded,receipt.state==='completed'?null:('Cloud runtime: '+String(receipt.reason??'execution_incomplete').replace(/[^a-z0-9_]/gi,'').slice(0,100)),id).run();
  } catch(error) {
    // Retrying RPC asks for the same durably deduplicated task. It does not
    // authorize relaunching Codex after an ambiguous failure.
    if (attempts>=4) await env.DB.prepare("UPDATE standalone_tasks SET state='blocked',error='Cloud runtime receipt unavailable; inspect before retrying',updated_at=unixepoch() WHERE id=? AND state='running'").bind(id).run();
    throw error;
  }
}

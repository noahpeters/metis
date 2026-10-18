export async function executeRepositoryPublication(env,id,attempts=1){
  const job=await env.DB.prepare("SELECT j.state,j.mode,j.attempt_id,a.task_id,a.rework_reason,t.title,t.data_json,s.instructions,s.result_json FROM repository_publication_jobs j JOIN native_task_attempts a ON a.id=j.attempt_id JOIN native_tasks t ON t.id=a.task_id JOIN standalone_tasks s ON s.id=a.id WHERE j.id=?").bind(id).first();
  if(!job||['completed','blocked'].includes(job.state))return;
  await env.DB.prepare("UPDATE repository_publication_jobs SET state='running' WHERE id=? AND state='queued'").bind(id).run();
  try{
    const result=JSON.parse(job.result_json),data=JSON.parse(job.data_json);
    const receipt=await env.CODEX_RUNTIME.execute({taskId:id,repositoryOperation:job.mode,executionId:job.attempt_id,repositoryBinding:result.repository.binding,logicalTaskId:job.task_id,instructions:job.instructions,reworkReason:job.rework_reason??null,review:{title:job.title,description:data.reviewDescription??job.title}});
    if(receipt.state!=='completed'||receipt.result?.taskId!==job.attempt_id||receipt.result.containerStopped!==true)throw Error('Repository publication receipt unavailable');
    result.repository=receipt.result.repository;
    await env.DB.batch([env.DB.prepare('UPDATE standalone_tasks SET result_json=?,updated_at=unixepoch() WHERE id=?').bind(JSON.stringify(result),job.attempt_id),env.DB.prepare("UPDATE repository_publication_jobs SET state='completed' WHERE id=?").bind(id)]);
  }catch(error){if(attempts>=4)await env.DB.prepare("UPDATE repository_publication_jobs SET state='blocked' WHERE id=?").bind(id).run();throw error;}
}
export async function flushRepositoryPublications(env){const rows=await env.DB.prepare("SELECT id FROM repository_publication_jobs WHERE state='queued' LIMIT 10").all();for(const row of rows.results)await env.DISPATCH_QUEUE.send({type:'native_repository_publish',taskId:row.id});}

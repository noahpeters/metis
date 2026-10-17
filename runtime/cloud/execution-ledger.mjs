// Persist acceptance before launching arbitrary side effects. A process crash
// after acceptance is ambiguous: never automatically launch the task again.
export async function executeOnce(storage,task,run,lock=fn=>fn()) {
  const key=`task:${task.taskId}`;
  const identity=JSON.stringify(task);
  const previous=await lock(async()=>{
    const row=await storage.get(key);
    if (row) return row;
    await storage.put(key,{identity,acceptedAt:new Date().toISOString()});
    return null;
  });
  if (previous) {
    if (previous.identity!==identity) return {state:'blocked',reason:'task_identity_conflict'};
    return previous.receipt??{state:'blocked',reason:'execution_acceptance_ambiguous'};
  }
  let receipt;
  try {receipt=await run(task);} catch {receipt={state:'blocked',reason:'execution_transport_ambiguous'};}
  await storage.put(key,{identity,receipt});
  return receipt;
}

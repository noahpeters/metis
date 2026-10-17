// Never persist an exception's text: startup errors may include credentials.
function category(error) {
  const text=String(error?.message??error);
  if(/maximum.*container|max.*instance|capacity/i.test(text))return 'capacity';
  if(/no.*instance|instance.*unavailable/i.test(text))return 'unavailable';
  if(/timeout|timed out|deadline/i.test(text))return 'timeout';
  if(/permission|unauthorized|forbidden|403/i.test(text))return 'permission';
  if(/image|registry|pull/i.test(text))return 'image';
  if(/connect|closed|reset|disconnected|canceled|cancelled/i.test(text))return 'connection';
  return 'unknown';
}
export async function stopContainerAndConfirm(container,{delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),graceMs=2000,forceMs=5000}={}) {
  const wait=async timeout=>{
    for(let elapsed=0;elapsed<=timeout;elapsed+=100){
      const {status}=await container.getState();
      if(status==='stopped'||status==='stopped_with_code')return true;
      if(elapsed<timeout)await delay(100);
    }
    return false;
  };
  try{await container.stop();if(await wait(graceMs))return {forced:false};}catch{}
  // stop() only signals SIGTERM; destroy() terminates the VM without deleting
  // the Durable Object's task receipts. Do not leave the single slot occupied.
  await container.destroy();
  if(!await wait(forceMs))throw new Error('container_shutdown_not_confirmed');
  return {forced:true};
}
export async function executeContainerTask(container,task,auth) {
  let phase='startup';let receipt;
  try {
    // Instance acquisition has a separate SDK default of only eight seconds.
    // Give cold placement time to finish before the port-readiness window.
    await container.startAndWaitForPorts({ports:8080,startOptions:{envVars:{CODEX_SUBSCRIPTION_AUTH_JSON:auth}},cancellationOptions:{instanceGetTimeoutMS:60000,portReadyTimeoutMS:30000}});
    phase='request';
    const response=await container.containerFetch(new Request('http://container/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(task),signal:AbortSignal.timeout(120000)}));
    phase='response';
    receipt=response.ok?await response.json():{state:'blocked',reason:`container_http_${response.status}`};
  } catch(error) {receipt={state:'blocked',reason:`container_${phase}_${category(error)}`};}
  try {
    const cleanup=await stopContainerAndConfirm(container);
    if(receipt?.state==='completed'){receipt.result.containerStopped=true;receipt.result.containerStopForced=cleanup.forced;}
  } catch(error) {
    if(receipt?.state==='completed')receipt={state:'blocked',reason:`container_shutdown_${category(error)}`};
  }
  return receipt;
}

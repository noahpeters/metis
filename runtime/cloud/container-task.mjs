// Never persist an exception's text: startup errors may include credentials.
function category(error) {
  const text=String(error?.message??error);
  if(/no.*instance|instance.*unavailable|maximum.*container|max.*instance|capacity/i.test(text))return 'capacity';
  if(/timeout|timed out|deadline/i.test(text))return 'timeout';
  if(/permission|unauthorized|forbidden|403/i.test(text))return 'permission';
  if(/image|registry|pull/i.test(text))return 'image';
  if(/connect|closed|reset|disconnected|canceled|cancelled/i.test(text))return 'connection';
  return 'unknown';
}
export async function executeContainerTask(container,task,auth) {
  let phase='startup';let receipt;
  try {
    await container.startAndWaitForPorts({ports:8080,startOptions:{envVars:{CODEX_SUBSCRIPTION_AUTH_JSON:auth}},cancellationOptions:{portReadyTimeoutMS:30000}});
    phase='request';
    const response=await container.containerFetch(new Request('http://container/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(task),signal:AbortSignal.timeout(120000)}));
    phase='response';
    receipt=response.ok?await response.json():{state:'blocked',reason:`container_http_${response.status}`};
  } catch(error) {receipt={state:'blocked',reason:`container_${phase}_${category(error)}`};}
  try {await container.stop();} catch(error) {
    if(receipt?.state==='completed')receipt={state:'blocked',reason:`container_shutdown_${category(error)}`};
  }
  return receipt;
}

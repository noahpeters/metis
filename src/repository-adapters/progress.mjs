const hints=new Set(['other','python','node','verification_batch','pnpm_lint','pnpm_typecheck','pnpm_test','pnpm_build','pnpm_build_worker']);
const events=new Set(['thread.started','turn.started','turn.completed','turn.failed','error',...['item.started','item.updated','item.completed'].flatMap(type=>['command_execution','agent_message','reasoning'].map(item=>type+':'+item))]);
const duration=value=>Number.isFinite(value)?Math.max(0,Math.min(86400000,Math.round(value))):0;
// Project only the public diagnostic schema. Never expose arbitrary ledger data.
export function safeExecutionProgress(value) {
  const p=value?.executionProgress;if(!p||!Array.isArray(p.commands))return null;
  let outputBudget=8000;
  const command=c=>({hint:hints.has(c?.hint)?c.hint:'other',status:['running','completed','failed'].includes(c?.status)?c.status:'running',elapsedMs:duration(c?.elapsedMs)});
  const commands=p.commands.slice(-32).map(c=>({...command(c),startedMs:duration(c?.startedMs)}));
  for(let i=commands.length-1;i>=0;i--){const c=p.commands.slice(-32)[i];if(typeof c.outputTail==='string'&&outputBudget){const tail=c.outputTail.slice(-Math.min(2000,outputBudget));commands[i].outputTail=tail;outputBudget-=tail.length;}}
  return {threadId:/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.threadId??'')?value.threadId:null,commandCount:Number.isInteger(value.commandCount)?Math.max(0,Math.min(10000,value.commandCount)):0,executionProgress:{elapsedMs:duration(p.elapsedMs),idleMs:duration(p.idleMs),lastEvent:events.has(p.lastEvent)?p.lastEvent:null,commandsTruncated:Number.isInteger(p.commandsTruncated)?Math.max(0,p.commandsTruncated):0,commands,lastCommand:p.lastCommand?command(p.lastCommand):null}};
}

const $=selector=>document.querySelector(selector);
let tasks=[],selected=null,detail=null,editing=false,busy=false,refreshing=false;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const date=value=>value?new Date(value*1000).toLocaleString():'—';
async function api(path='',body) {
  const r=await fetch('/api/tasks'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await r.json();if(!r.ok)throw new Error(data.error?.message??'Task request failed');return data;
}
function notice(message){$('#task-notice').textContent=message;}
function link(text,url){const a=el('a',text);a.href=url;return a;}
function renderList(){
  const list=$('#task-list');list.replaceChildren();
  const visible=tasks.filter(t=>$('#task-filter').value==='all'||t.state===$('#task-filter').value);
  $('#task-count').textContent=`${visible.length} shown · latest ${tasks.length} tasks`;
  for(const task of visible){const a=link('',`/tasks/${task.id}`);a.className='task-list-item';if(task.id===selected)a.setAttribute('aria-current','page');a.append(el('strong',task.title),el('span',task.state,'task-state'));list.append(a);}
  if(!visible.length)list.append(el('p','No tasks in this view.'));
}
function button(text,fn,mutate=true){const b=el('button',text);b.type='button';b.disabled=busy;b.onclick=()=>mutate?act(fn):fn();return b;}
async function act(fn){if(busy)return;busy=true;try{await fn();notice('Saved.');await refresh(true);}catch(e){notice(e.message);}finally{busy=false;renderDetail();}}
function renderDetail(){
  const panel=$('#task-detail');panel.replaceChildren();
  if(!detail){panel.append(el('p','Select a task or capture new work.'));return;}
  const {task,dependencies,attempts,events}=detail;
  panel.append(el('p',task.state,'task-state'),el('h2',task.title),el('code',task.id),el('p',`Created by ${task.created_by} · ${date(task.created_at)}`));
  const actions=el('div',undefined,'task-actions');
  const post=(action,extra={})=>api(`/${task.id}/${action}`,{version:task.version,...extra});
  if(task.phase==='draft'){
    actions.append(button('Edit task',()=>openForm(task),false),button('Mark ready',()=>post('ready')));
  }
  if(!attempts.length&&task.phase!=='cancelled')actions.append(button('Cancel task',()=>post('cancel')));
  if(task.phase==='ready'&&(!attempts.length||(['blocked','failed'].includes(attempts[0].state)&&attempts[0].result?.containerStopped===true))){const b=button(attempts.length?'Retry cloud execution':'Start cloud execution',()=>post('start',{attempt_id:crypto.randomUUID()}));b.disabled=busy||dependencies.some(d=>d.state!=='completed');actions.append(b);}
  panel.append(actions,el('h3','Instructions'),el('pre',task.instructions,'task-content'),el('h3','Task data'),el('pre',JSON.stringify(task.data,null,2),'task-content'),el('h3','Dependencies'));
  for(const d of dependencies)panel.append(link(`${d.title} · ${d.state}`,`/tasks/${d.id}`),el('br'));
  if(!dependencies.length)panel.append(el('p','No dependencies.'));
  if(task.phase==='draft'){
    const form=el('form');form.className='dependency-form';const label=el('label','Dependencies (select tasks that must complete first)');label.htmlFor='dependency-select';
    const select=el('select');select.id='dependency-select';select.multiple=true;select.size=Math.min(6,Math.max(2,tasks.length-1));
    for(const candidate of tasks.filter(t=>t.id!==task.id)){const option=el('option',`${candidate.title} · ${candidate.state}`);option.value=candidate.id;option.selected=dependencies.some(d=>d.id===candidate.id);select.append(option);}
    const save=el('button','Save dependencies');save.type='submit';save.disabled=busy;form.append(label,select,save);form.onsubmit=e=>{e.preventDefault();act(()=>post('dependencies',{dependencies:Array.from(select.selectedOptions,o=>o.value)}));};panel.append(form);
  }
  panel.append(el('h3','Execution attempts'));
  if(!attempts.length)panel.append(el('p','No execution attempts yet. Mark ready, then start when dependencies are complete.'));
  for(const attempt of attempts){
    const article=el('article',undefined,'task-attempt');article.id=`attempt-${attempt.id}`;
    article.append(link(`Attempt ${attempt.id}`,attempt.url),el('p',`${attempt.state} · queued ${date(attempt.queued_at)} · started ${date(attempt.execution_started_at)}`));
    if(attempt.error)article.append(el('p',attempt.error,'warning'));
    article.append(el('p',attempt.thread_id?`Codex thread: ${attempt.thread_id}`:'No completed Codex thread recorded.'));
    article.append(el('p','This is the retained Metis execution record. The CLI workspace is ephemeral; a Codex browser session link is unavailable.'));
    const history=el('ol');for(const event of events.filter(e=>e.task_id===attempt.id))history.append(el('li',`${event.state} · ${date(event.created_at)}`));article.append(history);
    if(attempt.result){const disclosure=el('details');disclosure.append(el('summary','Saved execution result'),el('pre',JSON.stringify(attempt.result,null,2),'task-content'));article.append(disclosure);}
    panel.append(article);
  }
}
function openForm(task){editing=!!task;$('#task-form-title').textContent=editing?'Edit task':'New task';$('#task-title').value=task?.title??'';$('#task-instructions').value=task?.instructions??'';$('#task-data').value=JSON.stringify(task?.data??{},null,2);$('#task-form-error').textContent='';$('#task-dialog').showModal();}
async function refresh(force=false){
  if(refreshing||(!force&&(busy||$('#task-dialog').open||document.activeElement?.closest('.dependency-form'))))return;
  refreshing=true;
  try{const data=await api();tasks=data.tasks;const parts=location.pathname.split('/');selected=parts[2]??null;detail=selected?await api(`/${selected}`):null;renderList();renderDetail();notice(`Updated ${new Date().toLocaleTimeString()}`);if(parts[3]==='attempts'&&parts[4])document.getElementById(`attempt-${parts[4]}`)?.scrollIntoView({block:'nearest'});}
  catch(e){notice(`Could not refresh: ${e.message}`);}finally{refreshing=false;}
}
$('#new-task').onclick=()=>openForm();$('#cancel-task').onclick=()=>$('#task-dialog').close();$('#task-filter').onchange=renderList;
$('#task-form').onsubmit=async e=>{
  e.preventDefault();const submit=e.submitter;submit.disabled=true;
  try{const data=JSON.parse($('#task-data').value);const body={id:editing?selected:crypto.randomUUID(),title:$('#task-title').value,instructions:$('#task-instructions').value,data,version:detail?.task.version};const result=await api(editing?`/${selected}/edit`:'',body);$('#task-dialog').close();history.pushState({},'',`/tasks/${result.id}`);await refresh(true);}catch(error){$('#task-form-error').textContent=error.message;}finally{submit.disabled=false;}
};
document.addEventListener('click',event=>{const a=event.target.closest('a');if(!a||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;const url=new URL(a.href);if(url.origin===location.origin&&url.pathname.startsWith('/tasks')){event.preventDefault();history.pushState({},'',url.pathname);refresh(true);}});
window.addEventListener('popstate',()=>refresh(true));refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';

// Actual Worker HTTP, D1, Queue producer and asynchronous Queue consumer.
// No GitHub credentials, R2 binding or outbound network are provided.
test('standalone HTTP -> real local Queue -> D1 -> HTTP result', {timeout:30000}, async t => {
  const root=new URL('..',import.meta.url).pathname;
  const entry=join(root,'src/control-plane-entrypoint.mjs');
  const paths=(await readdir(join(root,'src'),{recursive:true})).filter(p=>p.endsWith('.mjs')).map(p=>join(root,'src',p));
  const mf=new Miniflare(convertV4MiniflareOptions({
    compatibilityDate:'2026-08-30',cf:false,log:new Log(LogLevel.WARN),
    modules:[entry,...paths.filter(p=>p!==entry)].map(path=>({type:'ESModule',path})),modulesRoot:root,
    d1Databases:{DB:'standalone-proof'},bindings:{STANDALONE_DISPATCH_TOKEN:'local-only'},
    queueProducers:{DISPATCH_QUEUE:'standalone'},queueConsumers:{standalone:{maxBatchSize:1,maxBatchTimeout:0,maxRetries:3,deadLetterQueue:'dead-letter',retryDelay:0}},
    outboundService:()=>new Response('Unexpected outbound request',{status:503}),
  }));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const name of ['0020_standalone_dispatch.sql','0021_standalone_d1_proof.sql','0022_standalone_codex_runner.sql']) {
    await db.exec((await readFile(join(root,'migrations',name),'utf8')).replace(/^\s*--.*$/gm,'').replace(/\r?\n/g,' '));
  }
  const instructions='Local Queue delivery proof';
  const response=await mf.dispatchFetch('https://example.com/v1/standalone/tasks',{method:'POST',headers:{authorization:'Bearer local-only'},body:JSON.stringify({instructions})});
  assert.equal(response.status,202);const {id}=await response.json();
  let row;
  for(let i=0;i<100;i++) {
    row=await db.prepare('SELECT * FROM standalone_tasks WHERE id=?').bind(id).first();
    if(row?.state==='completed')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(row?.state,'completed');
  const result=JSON.parse(row.result_json);assert.equal(result.taskId,id);assert.equal(result.instructions,instructions);assert.equal(result.status,'completed');
  assert.equal(result.executedAt,new Date(row.execution_started_at*1000).toISOString());
  const events=await db.prepare('SELECT state FROM standalone_task_events WHERE task_id=? ORDER BY sequence').bind(id).all();
  assert.deepEqual(events.results.map(r=>r.state),['queued','running','completed']);
  const status=await mf.dispatchFetch(`https://example.com/v1/standalone/tasks/${id}`,{headers:{authorization:'Bearer local-only'}});
  assert.equal(status.status,200);assert.deepEqual((await status.json()).result,result);
  await db.exec("CREATE TRIGGER inject_proof_failure BEFORE UPDATE OF state ON standalone_tasks WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected proof write failure'); END;");
  const failure=await mf.dispatchFetch('https://example.com/v1/standalone/tasks',{method:'POST',headers:{authorization:'Bearer local-only'},body:JSON.stringify({instructions:'Force retry exhaustion'})});
  const failedId=(await failure.json()).id;
  let failed;
  for(let i=0;i<100;i++) {
    failed=await db.prepare('SELECT state,result_json FROM standalone_tasks WHERE id=?').bind(failedId).first();
    if(failed?.state==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(failed?.state,'failed');assert.equal(failed.result_json,null);
  const retries=await db.prepare('SELECT state FROM standalone_task_events WHERE task_id=? ORDER BY sequence').bind(failedId).all();
  assert.deepEqual(retries.results.map(r=>r.state),['queued','running','queued','running','queued','running','queued','running','failed']);
});

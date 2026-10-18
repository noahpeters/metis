// Private HTTPS bridge for the container's content store and publication ledger.
// All objects remain in D1; no public media endpoint or R2 provisioning.
export async function repositoryStore(request,env) {
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const supplied=request.headers.get('authorization')??'';
  if(!env.REPOSITORY_STORE_TOKEN||supplied!=='Bearer '+env.REPOSITORY_STORE_TOKEN)return json({error:'unauthorized'},401);
  try {
    if(Number(request.headers.get('content-length'))>8*1024*1024)return json({error:'too_large'},413);
    const raw=await request.text();if(new TextEncoder().encode(raw).length>8*1024*1024)return json({error:'too_large'},413);
    const body=JSON.parse(raw),key=body.key;
    const valid=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
    if(body.action==='put') {
      if(typeof body.bytes!=='string'||body.bytes.length>7*1024*1024)return json({error:'too_large'},413);
      const binary=atob(body.bytes),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>5*1024*1024)return json({error:'too_large'},413);
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''),ref='sha256:'+sha256;
      const encoded=btoa(binary),chunks=[];for(let i=0;i<encoded.length;i+=64000)chunks.push(encoded.slice(i,i+64000));if(!chunks.length)chunks.push('');
      await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO repository_objects(ref,sha256,chunks) VALUES(?,?,?)').bind(ref,sha256,chunks.length),...chunks.map((data,i)=>env.DB.prepare('INSERT OR IGNORE INTO repository_object_chunks(ref,sequence,data) VALUES(?,?,?)').bind(ref,i,data))]);return json({ref,sha256});
    }
    if(body.action==='get') {
      if(!/^sha256:[a-f0-9]{64}$/.test(body.content?.ref)||body.content.ref!=='sha256:'+body.content.sha256)return json({error:'invalid_content'},400);
      const meta=await env.DB.prepare('SELECT * FROM repository_objects WHERE ref=?').bind(body.content.ref).first();if(!meta)return json({error:'not_found'},404);
      const rows=await env.DB.prepare('SELECT data FROM repository_object_chunks WHERE ref=? ORDER BY sequence').bind(meta.ref).all();if(rows.results.length!==meta.chunks)return json({error:'incomplete_object'},503);return json({bytes:rows.results.map(r=>r.data).join('')});
    }
    if(body.action==='read'&&valid(key)){const row=await env.DB.prepare('SELECT value FROM repository_records WHERE key=?').bind(key).first();return json(row?JSON.parse(row.value):null);}
    if(body.action==='save'&&valid(key)) {const value=JSON.stringify(body.value);if(new TextEncoder().encode(value).length>1024*1024)return json({error:'too_large'},413);if(!valid(body.changeId)||!valid(body.owner))return json({error:'lock_required'},409);const result=await env.DB.prepare('INSERT INTO repository_records(key,value) SELECT ?,? WHERE EXISTS (SELECT 1 FROM repository_locks WHERE change_id=? AND owner=? AND expires_at>unixepoch()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=unixepoch()').bind(key,value,body.changeId,body.owner).run();return json({ok:!!result.meta.changes},result.meta.changes?200:409);}
    if(['lock','unlock'].includes(body.action)&&valid(body.changeId)&&valid(body.owner)) {
      const result=body.action==='lock'?await env.DB.prepare('INSERT INTO repository_locks(change_id,owner,expires_at) VALUES(?,?,unixepoch()+1200) ON CONFLICT(change_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE repository_locks.expires_at<=unixepoch()').bind(body.changeId,body.owner).run():await env.DB.prepare('DELETE FROM repository_locks WHERE change_id=? AND owner=?').bind(body.changeId,body.owner).run();
      return json({ok:!!result.meta.changes},result.meta.changes?200:409);
    }
    return json({error:'invalid_request'},400);
  }catch{return json({error:'repository_store_failed'},503);}
}

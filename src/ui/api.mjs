export const allowedApiRequest = (method, pathname) => ((method === "GET" && /^\/api\/tasks(?:\/[0-9a-f-]+)?$/.test(pathname)) || (method === "POST" && /^\/api\/tasks(?:\/[0-9a-f-]+\/(?:edit|dependencies|ready|cancel|start|rework|publish|observe))?$/.test(pathname))) || (method === "GET" && ["/api/status", "/api/pacing", "/api/stream", "/api/repositories"].includes(pathname)) || (method === "POST" && ["/api/pacing/nudge", "/api/capacity/reenergize", "/api/repositories/revalidate", "/api/issues/reset-ready", "/api/issues/force-complete"].includes(pathname));

export async function proxyApi(request, env, identity) {
  const url = new URL(request.url);
  if (!allowedApiRequest(request.method, url.pathname)) return response({ error: { code: "not_found", message: "API route is not allowed" } }, 404);
  if (url.pathname === "/api/stream") return streamSnapshots(request, env, identity);
  let upstream;
  if (url.pathname.startsWith("/api/tasks")) {
    let body=null;
    if(request.method === "POST") {
      if(request.headers.get("origin") && request.headers.get("origin")!==url.origin) return response({error:{message:"Cross-origin writes are forbidden"}},403);
      if(!request.headers.get("content-type")?.startsWith("application/json")) return response({error:{message:"JSON content type is required"}},415);
      if(Number(request.headers.get("content-length"))>40000) return response({error:{message:"Request too large"}},413);
      const raw=await request.text();
      if(new TextEncoder().encode(raw).length>40000) return response({error:{message:"Request too large"}},413);
      try { body=JSON.parse(raw); } catch { return response({error:{message:"Invalid JSON"}},400); }
    }
    try { upstream=await env.CONTROL_PLANE.nativeTasks(identity.email,request.method,url.pathname,body); }
    catch { return response({error:{message:"Task service is temporarily unavailable"}},503); }
    return new Response(upstream.body,{status:upstream.status,headers:{"content-type":"application/json","cache-control":"no-store"}});
  }
  if (url.pathname === "/api/status") upstream = await env.CONTROL_PLANE.uiStatus(identity.email);
  else if (url.pathname === "/api/pacing") upstream = await env.CONTROL_PLANE.pacingOverview(identity.email);
  else if (url.pathname === "/api/repositories") upstream = await env.CONTROL_PLANE.repositoryOverview(identity.email);
  else if (url.pathname === "/api/pacing/nudge") upstream = await env.CONTROL_PLANE.nudgeReadyWork(identity.email);
  else if (url.pathname === "/api/capacity/reenergize") {
    let body;
    try { body = await request.json(); }
    catch { return response({ error: { code: "invalid_json", message: "A JSON request is required" } }, 400); }
    upstream = await env.CONTROL_PLANE.reenergizeCapacity(identity.email, body);
  }
  else if (url.pathname === "/api/repositories/revalidate") {
    let body;
    try { body = await request.json(); }
    catch { return response({ error: { code: "invalid_json", message: "A JSON request is required" } }, 400); }
    upstream = await env.CONTROL_PLANE.revalidateRepository(identity.email, body, request.headers.get("Idempotency-Key"));
  }
  else {
    let body;
    try { body = await request.json(); }
    catch { return response({ error: { code: "invalid_json", message: "A JSON request is required" } }, 400); }
    upstream = await env.CONTROL_PLANE.administerIssue(identity.email, body, request.headers.get("Idempotency-Key"), url.pathname.endsWith("reset-ready") ? "reset_ready" : "force_complete");
  }
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function streamSnapshots(request, env, identity) {
  const encoder = new TextEncoder();
  const streamId = crypto.randomUUID();
  const interval = Math.max(100, Number(env.UI_STREAM_INTERVAL_MS) || 1_000);
  const lifetime = Math.max(interval, Number(env.UI_STREAM_LIFETIME_MS) || 55_000);
  let revision = 0;
  let timer;
  let lifetimeTimer;
  let closed = false;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const run = async () => {
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearTimeout(lifetimeTimer);
        writer.close().catch(() => {});
      };
      request.signal.addEventListener("abort", close, { once: true });
      const emit = async () => {
        if (closed) return;
        try {
          const upstream = await env.CONTROL_PLANE.pacingOverview(identity.email);
          if (upstream.status !== 200) throw new Error(`snapshot status ${upstream.status}`);
          revision += 1;
          const snapshot = JSON.parse(upstream.body);
          await writer.write(encoder.encode(`id: ${streamId}:${revision}\nevent: snapshot\ndata: ${JSON.stringify({ stream_id: streamId, revision, snapshot })}\n\n`));
        } catch {
          if (!closed) await writer.write(encoder.encode(`event: unavailable\ndata: ${JSON.stringify({ stream_id: streamId })}\n\n`));
        }
        if (!closed) timer = setTimeout(emit, interval);
      };
      lifetimeTimer = setTimeout(close, lifetime);
      await emit();
  };
  run().catch(() => {});
  return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
}

export function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

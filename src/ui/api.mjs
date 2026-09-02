export const allowedApiRequest = (method, pathname) => (method === "GET" && ["/api/status", "/api/pacing"].includes(pathname)) || (method === "POST" && ["/api/pacing/reset", "/api/pacing/nudge"].includes(pathname));

export async function proxyApi(request, env, identity) {
  const url = new URL(request.url);
  if (!allowedApiRequest(request.method, url.pathname)) return response({ error: { code: "not_found", message: "API route is not allowed" } }, 404);
  let upstream;
  if (url.pathname === "/api/status") upstream = await env.CONTROL_PLANE.uiStatus(identity.email);
  else if (url.pathname === "/api/pacing") upstream = await env.CONTROL_PLANE.pacingOverview(identity.email);
  else if (url.pathname === "/api/pacing/nudge") upstream = await env.CONTROL_PLANE.nudgeReadyWork(identity.email);
  else {
    let body;
    try { body = await request.json(); }
    catch { return response({ error: { code: "invalid_json", message: "A JSON reset request is required" } }, 400); }
    upstream = await env.CONTROL_PLANE.resetPacingWindow(identity.email, body, request.headers.get("Idempotency-Key"));
  }
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

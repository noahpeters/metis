export const allowedApiRequest = (method, pathname) => (method === "GET" && ["/api/status", "/api/pacing"].includes(pathname)) || (method === "POST" && pathname === "/api/pacing/reset");

export async function proxyApi(request, env, identity) {
  const url = new URL(request.url);
  if (!allowedApiRequest(request.method, url.pathname)) return response({ error: { code: "not_found", message: "API route is not allowed" } }, 404);
  const headers = new Headers({
    "X-Metis-Verified-Email": identity.email,
  });
  if (request.headers.has("Idempotency-Key")) headers.set("Idempotency-Key", request.headers.get("Idempotency-Key"));
  const route = url.pathname === "/api/status" ? "/internal/ui/status" : url.pathname === "/api/pacing" ? "/internal/ui/pacing" : "/internal/ui/pacing/reset";
  const upstream = await env.CONTROL_PLANE.fetch(new Request(`https://control-plane${route}`, { method: request.method, headers, body: request.method === "POST" ? request.body : null }));
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

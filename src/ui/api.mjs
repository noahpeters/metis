export const allowedApiRequest = (method, pathname) => method === "GET" && pathname === "/api/status";

export async function proxyApi(request, env, identity) {
  const url = new URL(request.url);
  if (!allowedApiRequest(request.method, url.pathname)) return response({ error: { code: "not_found", message: "API route is not allowed" } }, 404);
  const headers = new Headers({
    "X-Metis-Verified-Email": identity.email,
    "X-Metis-UI-Binding": env.UI_BINDING_TOKEN,
  });
  const upstream = await env.CONTROL_PLANE.fetch(new Request(`https://control-plane/internal/ui/status`, { headers }));
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

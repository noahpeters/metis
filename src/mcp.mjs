const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const protocolVersion = "2025-03-26";
const tool = { name: "metis_ping", description: "Read-only connectivity check for the Metis control plane.", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
function authorized(request, env) {
  const token = env.METIS_MCP_BEARER_TOKEN;
  const header = request.headers.get("authorization");
  if (!token || !header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  // Compare fixed-length digests to avoid token-length and early-exit timing leaks.
  return compare(supplied, token);
}
function compare(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(a), bb = enc.encode(b);
  let diff = aa.length ^ bb.length;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
export async function handleMcp(request, env) {
  if (!authorized(request, env)) return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let message;
  try { message = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return json({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid request" } }, 400);
  if (message.id === undefined) return new Response(null, { status: 202 });
  let result;
  switch (message.method) {
    case "initialize":
      result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "metis", version: "0.1.0" } };
      break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: [tool] }; break;
    case "tools/call":
      if (message.params?.name !== "metis_ping") return json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } });
      result = { content: [{ type: "text", text: JSON.stringify({ service: "metis", status: "operational", timestamp: new Date().toISOString() }) }] };
      break;
    default: return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
  return json({ jsonrpc: "2.0", id: message.id, result });
}

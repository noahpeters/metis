import { authenticate } from "./auth.mjs";
import { proxyApi } from "./api.mjs";

const shell = (email) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>metis</title><link rel="stylesheet" href="/assets/app.css"></head><body><a class="skip" href="#main">Skip to content</a><header><strong>metis</strong><span>${escapeHtml(email)}</span></header><main id="main"><p class="eyebrow">CONTROL PLANE</p><h1>Administration</h1><div class="panels"><section aria-labelledby="status"><h2 id="status">System status</h2><p id="runtime" aria-live="polite">Loading operational status…</p></section><section aria-labelledby="pacing-title"><h2 id="pacing-title">Pacing window</h2><p class="muted">Local estimates only — not provider usage or billing.</p><dl id="pacing" aria-live="polite"><div><dt>Window</dt><dd>Loading…</dd></div></dl><form id="reset"><h3>Start a fresh window</h3><label>Reason <input name="reason" minlength="8" maxlength="500" required></label><label class="confirm"><input name="confirmed" type="checkbox" required> I understand this resets local pacing counters only.</label><button type="submit">Reset pacing window</button><p id="reset-result" aria-live="polite"></p></form></section></div></main><script type="module" src="/assets/app.js"></script></body></html>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);
  try {
    const identity = await authenticate(request, env);
    if (url.pathname.startsWith("/api/")) return proxyApi(request, env, identity);
    if (request.method !== "GET" || url.pathname !== "/") return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(shell(identity.email), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
  } catch {
    return new Response("<!doctype html><title>Unauthorized · metis</title><main><h1>Access denied</h1><p>A verified from-trees.com identity is required.</p></main>", { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
} };

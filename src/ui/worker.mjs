import { authenticate } from "./auth.mjs";
import { proxyApi } from "./api.mjs";

const shell = (email) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>metis · operations</title><link rel="stylesheet" href="/app.css"></head><body><a class="skip" href="#main">Skip to content</a><header><strong>metis</strong><div><span id="live-status" class="live-status" data-state="connecting" role="status">Connecting…</span><span>${escapeHtml(email)}</span></div></header><main id="main"><div id="pacing-card" class="pacing-card" data-state="loading" aria-live="polite" aria-busy="true"><div class="status-visual"><span class="status-circle skeleton"></span></div><div class="status-details"><p class="eyebrow">CODEX CAPACITY</p><h1>Loading capacity status…</h1><p class="reason">Retrieving the latest verified control-plane observation.</p><div id="pacing-actions" class="pacing-actions"><button id="nudge" type="button" hidden>Nudge</button><button id="reenergize" type="button" hidden>Reenergize</button></div></div></div><section class="repositories" aria-labelledby="repositories-title"><p class="eyebrow">REPOSITORY HEALTH</p><h2 id="repositories-title">Managed repositories</h2><div id="repository-cards" class="repository-grid" aria-live="polite" aria-busy="true"><p>Loading repository health…</p></div></section><p id="announcement" class="sr-only" role="status" aria-live="assertive"></p></main><dialog id="revalidate-dialog" aria-labelledby="revalidate-title"><form id="revalidate-form" method="dialog"><p class="eyebrow">AUDITED ADMINISTRATOR ACTION</p><h2 id="revalidate-title">Revalidate recovery evidence?</h2><p id="revalidate-transition"></p><dl id="revalidate-evidence"></dl><p class="warning">The lock remains unless authoritative GitHub evidence satisfies the displayed policy. This action cannot merge or deploy code.</p><label for="revalidate-reason">Reason</label><textarea id="revalidate-reason" name="reason" minlength="8" maxlength="500" required rows="3"></textarea><div class="dialog-actions"><button id="cancel-revalidate" class="secondary" type="button">Cancel</button><button type="submit">Confirm revalidation</button></div></form></dialog><script type="module" src="/app.js"></script></body></html>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const assetPaths = new Set(["/app.css", "/app.js", "/pacing.js"]);

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (assetPaths.has(url.pathname)) return env.ASSETS.fetch(request);
  try {
    const identity = await authenticate(request, env);
    if (url.pathname.startsWith("/api/")) return proxyApi(request, env, identity);
    if (request.method !== "GET" || url.pathname !== "/") return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(shell(identity.email), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
  } catch {
    return new Response("<!doctype html><title>Unauthorized · metis</title><main><h1>Access denied</h1><p>A verified from-trees.com identity is required.</p></main>", { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
} };
